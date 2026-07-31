// =====================================================================
// deploy/publish.mjs —— 私有库 → 公开库的【唯一发布路径】，闸长在路上。
//
// 为什么是一条路而不是一条纪律（2026-07-31 立，与当天的一致性闸同一原则）：
//   同一天刚证明过——靠"记得做某件事"的护栏一定会漏（人设白纸黑字写了微信别用
//   Markdown，照样发到了手机上）。发布漏一次的代价不可逆：公开仓库 1000+ 星、
//   169 个 fork，推上去等于被复制走，删仓库也召不回。
//   所以脱敏不是"发布前记得做的一步"，而是这条路本身——扫不过就出不去，
//   压根不存在"忘了扫"这个状态。
//
// 三段，全过才落地：
//   ① 复制到暂存（按排除清单剔除不该公开的文件）
//   ② 按本地密表做替换 + 身份文件换成占位版
//   ③ 扫暂存产物：通用探测器 + 密表原值残留双查，命中任何一条 → 退出非零、不写目标
//
// 铁律：从不 commit、从不 push。对外的最后一下留给人（原则9/审批层）。
// 密表与目标路径都在 gitignore 的本地文件里——这个脚本自己也要被公开，绝不能带真值。
//
// 用法：
//   node deploy/publish.mjs              # 转换 + 扫 + 同步进公开库工作区
//   node deploy/publish.mjs --check DIR  # 只扫某个目录（公开库的 pre-push 钩子用它兜底）
//   node deploy/publish.mjs --selftest   # 离线自检
// =====================================================================

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 必须走 fileURLToPath：路径里有中文时 URL.pathname 是百分号编码的，直接用会找不到文件。
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_CONF = join(REPO, 'deploy', 'publish.local.json');

// ---------------------------------------------------------------------
// 排除清单：**不进公开库的文件**，每条写清为什么（清单要能被审，不能是黑箱）。
// 判据：只要"公开后会暴露他本人、真人租户、或线上基础设施"，就不出去——
// 哪怕替换掉里面的 IP 也不行（运维日志的价值在于细节，脱完就没意义，不如不发）。
// ---------------------------------------------------------------------
export const EXCLUDE = [
  ['seed_memory.mjs', '整份是关于主人的个人事实（职业/阶段/行为模式），公开=公开他本人'],
  ['DEPLOYED.md', '部署流水：线上 IP、微信 id、服务器路径、SSH 别名，脱完就没信息量'],
  ['AUDIT_2026-06-27.md', '内部审计记录，对外无意义'],
  ['小王架构图.html', '含线上地址的架构图（想公开可单独脱敏后手动加）'],
  ['package-lock.json', '纯噪音，公开版不需要锁文件'],
  ['identities/friend.json', '真人租户的私密人设（本来就 gitignore，双保险）'],
  ['deploy/publish.local.json', '本地密表 + 目标路径（绝不出去）'],
];
const isExcluded = (rel) => EXCLUDE.some(([p]) => rel === p || rel.startsWith(p + '/'));

// ---------------------------------------------------------------------
// 通用探测器：**不含任何真值**，靠形状抓。密表漏了哪一条，这里还有一次机会。
// 每条都要能在 selftest 里被单独打中——探测器自己不许是摆设。
// ---------------------------------------------------------------------
const IP_ALLOW = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255', '1.2.3.4', '8.8.8.8', '0.0.0.1']);
// 非公网段：内网 + 链路本地(169.254/16，云厂商元数据服务就在这) + 运营商级 NAT(100.64/10，
// 阿里云内网 DNS 100.100.100.200 在这段)。这些是公开常量，不是谁的地址，放行。
const isPrivateIp = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
};
const PLACEHOLDER = /^(x+|your[-_].*|<.*>|placeholder|changeme|example)$/i;

export const DETECTORS = [
  {
    kind: '公网 IP',
    scan: (line) => (line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [])
      .filter((ip) => ip.split('.').every((o) => Number(o) <= 255) && !IP_ALLOW.has(ip) && !isPrivateIp(ip)),
  },
  {
    kind: 'API key',
    scan: (line) => line.match(/\b(?:sk|xai|gsk|ghp|ghs|glpat)-[A-Za-z0-9_-]{16,}/g) || [],
  },
  {
    kind: '密钥赋值',
    // KEY=<长值> 且不是占位符。.env.example 那种空值/示例值不该被打中。
    scan: (line) => {
      const m = line.match(/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD))\s*[=:]\s*['"]?([A-Za-z0-9_\-]{16,})/);
      return m && !PLACEHOLDER.test(m[2]) ? [`${m[1]}=${m[2].slice(0, 6)}…`] : [];
    },
  },
  {
    kind: '企微 id（16 位裸数字）',
    scan: (line) => line.match(/(?<![\d.])\d{16}(?![\d.])/g) || [],
  },
  {
    kind: '手机号',
    scan: (line) => line.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) || [],
  },
  {
    kind: '本机路径（含中文）',
    // \u76d8\u7b26\u524d\u4e0d\u80fd\u6328\u7740\u5b57\u6bcd\uff0c\u5426\u5219 https:// \u91cc\u7684\u300cs:\u300d\u4f1a\u88ab\u5f53\u6210\u76d8\u7b26\uff08\u771f\u673a\u8dd1\u51fa\u6765\u7684\u8bef\u62a5\uff09\u3002
    scan: (line) => line.match(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`]*[\u4e00-\u9fff][^\s"'`]*/g) || [],
  },
];

// 逐行豁免标记。为什么需要：本脚本自己的自检用例里就得有"长得像密钥的样本"，
// 文档里也会出现示例配置——它们必须能被公开，否则闸会把自己锁死（首次真跑就撞上了）。
// 纪律：豁免必须是**显式写在那一行上的**（可 grep 出全集），且每次运行都会报数——
// 不允许存在看不见的豁免（原则：不做静默截断）。
export const ALLOW_MARK = 'publish-allow';

// 一段文本里的所有命中。返回 [{line, kind, sample}]；被豁免的行计入 exempt。
export function scanText(text, extraLiterals = [], exempt = { n: 0 }) {
  const hits = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(ALLOW_MARK)) { exempt.n++; continue; }
    for (const d of DETECTORS) {
      for (const s of d.scan(lines[i])) hits.push({ line: i + 1, kind: d.kind, sample: s });
    }
    // 密表原值残留：替换环节漏掉的（比如换了写法、加了空格）在这里被抓。
    for (const lit of extraLiterals) {
      if (lit && lines[i].includes(lit)) hits.push({ line: i + 1, kind: '密表原值残留', sample: lit });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------
// 转换：密表替换 + 身份文件换占位版。纯函数，好测。
// ---------------------------------------------------------------------
export function substitute(text, pairs) {
  let s = String(text);
  for (const [real, placeholder] of pairs) if (real) s = s.split(real).join(placeholder);
  return s;
}

// 身份文件只留"结构"，不留人：
//   - 人设正文清空（那是主人本人的东西）
//   - 天气城市只留第一个（常驻地）。第二个城市泄露的是行踪与关系——家人在哪、常回哪，
//     对读代码的人零价值，对认识他的人是信息。留一个就够说明"这个字段是个列表"。
export function stubIdentity(jsonText) {
  const o = JSON.parse(jsonText);
  const first = (a) => (Array.isArray(a) && a.length ? [a[0]] : []);
  return JSON.stringify({
    ownerName: o.ownerName ?? '',
    profileNote: '',
    weatherMorningCities: first(o.weatherMorningCities),
    weatherEveningCities: first(o.weatherEveningCities),
  }, null, 2) + '\n';
}

// 公开版要额外造出来的文件：真人租户的身份文件本来就 gitignore（私有库里都没有），
// 但公开库缺了它就看不出"多租户长什么样"。所以给一个纯模板——里面没有任何真实数据。
//
// 为什么叫 .example：随源码一起发出去的 .gitignore 里写着忽略 identities/friend.json，
// 于是公开库 git add 会**静默跳过**同名文件——模板根本进不了提交（实测踩到）。
// 换成仓库既有的 .example 约定（.env.example / friend.env.example / router.config.example.json），
// 既不被忽略，也一眼看得出"这是模板不是真配置"。
export const EMIT = [
  ['identities/friend.example.json', JSON.stringify({
    ownerName: '朋友',
    profileNote: '',
    weatherMorningCities: ['上海'],
    weatherEveningCities: ['上海'],
  }, null, 2) + '\n'],
];

const isText = (rel) => /\.(mjs|js|json|md|html|sh|service|example|yml|yaml|txt|gitignore|gitattributes)$/i.test(rel) || /(^|\/)\.[a-z]+$/i.test(rel);

// ---------------------------------------------------------------------
// 扫一棵目录树（--check 也走它：公开库 pre-push 钩子直接扫工作区）。
// ---------------------------------------------------------------------
export function scanTree(dir, extraLiterals = [], exempt = { n: 0 }) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const rel = relative(dir, p).replace(/\\/g, '/');
      if (!isText(rel)) continue;
      let txt = '';
      try { txt = readFileSync(p, 'utf8'); } catch { continue; }
      for (const h of scanText(txt, extraLiterals, exempt)) out.push({ file: rel, ...h });
    }
  };
  walk(dir);
  return out;
}

// 递归拷贝：**不用 fs.cpSync**——它在这台 Windows 上会静默杀掉整个进程（无异常、无输出，
// 目标目录删了写不回来，2026-07-31 实测）。读写单文件是好的，所以就用最笨的原语走一遍。
function writeTree(src, dst) {
  let n = 0;
  const walk = (s, d) => {
    mkdirSync(d, { recursive: true });
    for (const name of readdirSync(s)) {
      const sp = join(s, name), dp = join(d, name);
      if (statSync(sp).isDirectory()) walk(sp, dp);
      else { writeFileSync(dp, readFileSync(sp)); n++; }
    }
  };
  walk(src, dst);
  return n;
}

function loadLocalConf() {
  if (!existsSync(LOCAL_CONF)) {
    throw new Error(
      `缺本地配置 ${LOCAL_CONF}\n` +
      `它不进 git（含真值）。照这个建：\n` +
      `{\n  "target": "<公开库克隆里的 xiaowang-v2 目录>",\n` +
      `  "substitutions": [["<真实值>", "<占位符>"]]\n}`
    );
  }
  const c = JSON.parse(readFileSync(LOCAL_CONF, 'utf8'));
  if (!c.target) throw new Error('本地配置缺 target');
  return { target: c.target, pairs: c.substitutions || [] };
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------
async function main(argv) {
  const checkIdx = argv.indexOf('--check');
  if (checkIdx !== -1) {
    const dir = argv[checkIdx + 1] || process.cwd();
    let literals = [];
    try { literals = loadLocalConf().pairs.map(([r]) => r); } catch { /* 钩子场景可能没配置：只跑通用探测器 */ }
    const exempt = { n: 0 };
    const hits = scanTree(dir, literals, exempt);
    report(hits, dir, exempt);
    process.exit(hits.length ? 1 : 0);
  }

  const { target, pairs } = loadLocalConf();
  const literals = pairs.map(([r]) => r);

  // ① 从 git 索引拿"该公开的文件"（未跟踪文件天然不在其中，少一类误发）
  // -z：非 ASCII 文件名（如「小王架构图.html」）默认会被 git 转义成 "\345\260..."，
  // 那样既建不出文件、也匹配不上 EXCLUDE。用 NUL 分隔拿原始字节。
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0').map((s) => s.trim()).filter(Boolean).filter((f) => !isExcluded(f));

  const stage = join(REPO, '.publish-stage');
  rmSync(stage, { recursive: true, force: true });

  // ② 复制 + 转换
  for (const rel of tracked) {
    const src = join(REPO, rel);
    const dst = join(stage, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (!isText(rel)) { writeFileSync(dst, readFileSync(src)); continue; }
    let txt = readFileSync(src, 'utf8');
    txt = /^identities\/.*\.json$/.test(rel) ? stubIdentity(txt) : substitute(txt, pairs);
    writeFileSync(dst, txt);
  }

  // ②b 造出公开版专有的模板文件（源库里不存在的）。它们同样要过下面的闸。
  for (const [rel, content] of EMIT) {
    const dst = join(stage, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content);
  }

  // ③ 闸：扫暂存产物，命中即拒（目标目录一个字节都不动）
  const exempt = { n: 0 };
  const hits = scanTree(stage, literals, exempt);
  if (hits.length) {
    report(hits, stage, exempt);
    console.error(`\n✗ 发布被拦下：${hits.length} 处未脱敏。暂存留在 ${stage} 供你查。`);
    console.error('  修法：把漏掉的真值补进 deploy/publish.local.json 的 substitutions，或把文件加进 EXCLUDE。');
    process.exit(1);
  }

  // 过闸才落地。目标目录整体替换（删掉已不该存在的旧文件）。
  rmSync(target, { recursive: true, force: true });
  const written = writeTree(stage, target);
  rmSync(stage, { recursive: true, force: true });

  if (exempt.n) console.log(`（${exempt.n} 行带 ${ALLOW_MARK} 豁免标记）`);
  console.log(`✓ 闸通过，${written} 个文件已同步到公开库工作区`);
  console.log(`  ${target}`);
  console.log('  排除：' + EXCLUDE.map(([p]) => p).join('、'));
  console.log('\n没有提交、没有推送——去公开库 git diff 看一眼再自己提交推送。');
}

function report(hits, base, exempt = { n: 0 }) {
  // 豁免必须每次都报出来：看不见的豁免等于闸上开了个没人记得的洞。
  if (exempt.n) console.log(`（${exempt.n} 行带 ${ALLOW_MARK} 豁免标记，已跳过——用 grep ${ALLOW_MARK} 看全集）`);
  if (!hits.length) { console.log(`✓ 扫描通过，无命中（${base}）`); return; }
  console.error(`发现 ${hits.length} 处：`);
  for (const h of hits.slice(0, 60)) console.error(`  ${h.file}:${h.line}  [${h.kind}]  ${h.sample}`);
  if (hits.length > 60) console.error(`  …还有 ${hits.length - 60} 处`);
}

const IS_MAIN = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

// =====================================================================
// --selftest：纯离线（不碰 git、不碰目标目录）。每个探测器都必须能被单独打中。
// =====================================================================
if (IS_MAIN && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };
  console.log('publish.mjs selftest\n');

  const hit = (s, kind) => scanText(s).some((h) => h.kind === kind);

  // 用例里一律用文档保留段的假 IP / 假路径（RFC5737 的 203.0.113.x）：
  // 它们照样能打中探测器，用例强度不变，而这个文件本身要被公开——真值不该出现在这。
  ok(hit('部署在 203.0.113.7:8080', '公网 IP'), '探测器：公网 IP'); // publish-allow 假 IP 样本
  ok(!hit('连 127.0.0.1:8081/health', '公网 IP'), '本地回环不误报');
  ok(!hit('内网 192.168.1.10 无所谓', '公网 IP'), '内网段不误报');
  ok(!hit('版本 v24.17.0 与 ^0.82.0', '公网 IP'), '版本号不误报');
  // 下面两条是真机跑第一次被误拦出来的，钉成用例防回归。
  ok(!hit('云元数据 169.254.169.254 / 阿里云 DNS 100.100.100.200', '公网 IP'), '云厂商固定地址不误报（链路本地/CGNAT 段）');
  ok(!hit('参考 https://example.com/x，回头看', '本机路径（含中文）'), 'https:// 里的「s:」不被当成盘符');
  ok(hit('LLM_API_KEY=sk-abcdefghij0123456789', 'API key'), '探测器：API key'); // publish-allow 假 key 样本
  ok(hit('TODO_SECRET=9f2b7c1ae4d84f0392bc55ad71e6', '密钥赋值'), '探测器：密钥赋值'); // publish-allow 假密钥样本
  ok(!hit('LLM_API_KEY=', '密钥赋值'), '.env.example 空值不误报');
  ok(!hit('WECOM_SECRET=your-secret-here', '密钥赋值'), '占位值不误报');
  ok(hit('target=<owner-id>', '企微 id（16 位裸数字）'), '探测器：企微 id');
  ok(!hit('时间戳 1785332286836 毫秒', '企微 id（16 位裸数字）'), '13 位时间戳不误报');
  ok(hit('联系 13800138000', '手机号'), '探测器：手机号'); // publish-allow 公知的假号段
  ok(hit('源码在 D:\\我的项目\\demo\\', '本机路径（含中文）'), '探测器：本机路径'); // publish-allow 假路径样本
  ok(!hit('代码 /opt/xiaowang-v2/ 库 v2.db', '本机路径（含中文）'), '服务器路径不误报');

  // 密表替换 + 残留双查
  const pairs = [['203.0.113.7', '<server-ip>'], ['D:\\我的项目\\demo', '<local-repo>']]; // publish-allow 假 IP/路径样本
  const before = 'ECS 203.0.113.7 上，源码 D:\\我的项目\\demo 里'; // publish-allow 假 IP/路径样本
  const after = substitute(before, pairs);
  ok(!/203\.0\.113\.7|我的项目/.test(after), 'substitute 把真值全换掉');
  ok(scanText(after, pairs.map(([r]) => r)).length === 0, '换完扫描零命中');
  ok(scanText(before, pairs.map(([r]) => r)).some((h) => h.kind === '密表原值残留'), '没换干净时"原值残留"能抓到');

  // 身份文件占位化
  const stub = JSON.parse(stubIdentity(JSON.stringify({
    ownerName: '子淇', profileNote: '他极反感 AI 味…', weatherMorningCities: ['上海'], weatherEveningCities: ['上海', '深圳'],
  })));
  ok(stub.profileNote === '' && stub.ownerName === '子淇', 'stubIdentity 清空人设正文、保留结构');
  ok(stub.weatherEveningCities.length === 1 && stub.weatherEveningCities[0] === '上海', 'stubIdentity 天气城市只留常驻地（第二个城市=行踪，不公开）');

  // 公开版模板：必须自身干净，否则等于从闸的内侧漏进去
  ok(EMIT.some(([p]) => p === 'identities/friend.example.json'), 'EMIT 造出真人租户身份的纯模板（源库里没有这个文件）');
  // 关键回归：模板名不能撞上随源码发出去的 .gitignore 规则，否则公开库 git add 静默跳过它
  const ignored = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  ok(EMIT.every(([p]) => !ignored.includes(p)), 'EMIT 文件名不被自带的 .gitignore 吞掉（实测踩过）');
  ok(EMIT.every(([, c]) => scanText(c).length === 0 && !/郭/.test(c)), 'EMIT 模板本身零命中、不含真人姓名');

  // 豁免标记：能生效，且必须显式写在那一行上、被计数（不允许看不见的豁免）
  const ex = { n: 0 };
  ok(scanText('key=sk-abcdefghij0123456789 // ' + ALLOW_MARK, [], ex).length === 0, '带豁免标记的行被跳过'); // publish-allow 假 key 样本
  ok(ex.n === 1, '豁免被计数（每次运行都会报出来，可被审）');
  ok(scanText('key=sk-abcdefghij0123456789').length > 0, '同一行去掉标记就照样拦'); // publish-allow 假 key 样本

  // 排除清单
  ok(isExcluded('seed_memory.mjs') && isExcluded('identities/friend.json'), 'EXCLUDE 命中个人事实与真人租户身份');
  ok(!isExcluded('todo.mjs') && !isExcluded('identities/ziqi.json'), 'EXCLUDE 不误伤正常源码/主人身份（后者走占位化）');
  ok(EXCLUDE.every(([, why]) => why && why.length > 6), '每条排除都写了理由（清单可被审）');

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}

if (IS_MAIN && !process.argv.includes('--selftest')) {
  main(process.argv.slice(2)).catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
}
