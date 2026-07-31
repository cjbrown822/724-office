#!/usr/bin/env node
// =====================================================================
// verify_tenant.mjs —— 租户全路径验收脚本（开通/改任何租户配置前必跑）
//
// 为什么存在：2026-07 朋友实例两个真机 bug（出站收件人回落老测试号→消息泄漏；
// get_weather 硬编码不认西安）静默跑了几个月才被发现。根因不是智能不够，是
// 没有任何东西在改动那一刻逼着把「一个租户碰到的每条路径」全部过一遍——
// 测试覆盖面 ≈ 当时上下文注意力，凭直觉测多路径系统必漏（团队原则2：失败是系统问题）。
// 本脚本把全路径清单外部化成确定性断言：一条不对就红（exit 1）。
//
// 用法（在代码目录下）：
//   node verify_tenant.mjs ziqi              # 主实例（读 .env）
//   node verify_tenant.mjs friend            # 朋友实例（读 friend.env）
//   node verify_tenant.mjs /path/to/x.env    # 显式 env 路径
//   --offline   跳过真实高德天气调用（无网/本地开发机用）
//   --selftest  离线自测本脚本（临时夹具，不碰真实配置）
//
// 只读纪律：绝不写任何库/文件、绝不发任何消息——对真人租户零感知。
// 防清单腐烂纪律：凡新增「会发消息」或「随租户变」的东西，来这里加一条断言；
// 否则"漏"又会变回默认状态。
// =====================================================================

import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- 结果收集：✓ 通过 / ✗ 失败(exit 1) / ⚠ 警告(不拦) ----
const results = [];
const pass = (msg) => { results.push(['✓', msg]); };
const fail = (msg) => { results.push(['✗', msg]); };
const warn = (msg) => { results.push(['⚠', msg]); };
const check = (cond, okMsg, badMsg) => (cond ? pass(okMsg) : fail(badMsg));

// ---- env 解析（与 watchdog_cron.loadEnv 同规则：KEY=VALUE、忽略#、去成对引号）----
function parseEnvFile(path) {
  const env = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}

// ---- 租户名 → env 文件路径（约定：ziqi=.env，其余 <name>.env；含路径分隔符=显式路径）----
function resolveEnvPath(dir, arg) {
  if (arg.includes('/') || arg.includes('\\') || arg.endsWith('.env')) return resolve(arg);
  if (arg === 'ziqi') return join(dir, '.env');
  return join(dir, `${arg}.env`);
}

// ---- 身份文件路径（复刻 identity.mjs resolvePath 规则，保持同一真相）----
function resolveIdentityPath(dir, xw2Identity) {
  if (!xw2Identity) return join(dir, 'identities', 'ziqi.json');
  if (isAbsolute(xw2Identity) || xw2Identity.includes('/') || xw2Identity.includes('\\')) return xw2Identity;
  return join(dir, 'identities', `${xw2Identity}.json`);
}

// ---- 发现同目录其它租户 env（隔离性对照组）：.env + *.env，排除自己 ----
function otherTenantEnvs(dir, selfPath) {
  const found = [];
  const dot = join(dir, '.env');
  if (existsSync(dot)) found.push(dot);
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.env') && f !== '.env') found.push(join(dir, f));
  }
  return [...new Set(found.map((p) => resolve(p)))].filter((p) => p !== resolve(selfPath));
}

// =====================================================================
// 主验收流程。dir=代码目录（含 weather.mjs/router.config.json 等）。
// =====================================================================
async function verify(tenantArg, { dir = HERE, offline = false } = {}) {
  const envPath = resolveEnvPath(dir, tenantArg);

  // ---- A. 环境文件与关键键 ----
  console.log(`\n== A. 环境文件（${envPath}）==`);
  if (!existsSync(envPath)) {
    fail(`env 文件不存在：${envPath}`);
    return summarize();
  }
  let env;
  try { env = parseEnvFile(envPath); pass('env 文件存在且可解析'); }
  catch (e) { fail(`env 文件解析失败：${e.message}`); return summarize(); }

  const OWNER = String(env.OWNER_ID || '');
  const TARGET = String(env.WECOM_TARGET_ID || '');
  check(OWNER, 'OWNER_ID 已配置', 'OWNER_ID 缺失——入站门禁/出站收件人都没有基准');
  check(TARGET, 'WECOM_TARGET_ID 已配置', 'WECOM_TARGET_ID 缺失');
  check(OWNER && OWNER === TARGET,
    'OWNER_ID == WECOM_TARGET_ID（收发同一真相源）',
    `OWNER_ID(${OWNER}) ≠ WECOM_TARGET_ID(${TARGET})——就是泄漏事故那种分叉，主动推送可能发错人`);
  check(env.WECOM_TOKEN && env.WECOM_GUID, '企微出站凭证 WECOM_TOKEN/GUID 在位', 'WECOM_TOKEN 或 WECOM_GUID 缺失——出站发不出');
  check(env.WECOM_CALLBACK_SECRET, '回调密钥 WECOM_CALLBACK_SECRET 在位', 'WECOM_CALLBACK_SECRET 缺失——wecom 模式会拒绝启动（fail-fast）');
  const port = Number(env.HTTP_PORT || 0);
  check(Number.isInteger(port) && port > 0, `HTTP_PORT=${port}`, `HTTP_PORT 非法：${env.HTTP_PORT}`);

  // ---- B. 出站收件人解析（ESM推送/周期任务/一次性提醒/send_message 同一条链）----
  console.log('\n== B. 出站收件人（主动推送 ×4）==');
  const resolved = OWNER || TARGET || '';
  check(resolved && resolved === OWNER,
    `出站收件人解析 = OWNER_ID(${OWNER})`,
    `出站收件人解析结果异常：得到「${resolved}」，应为 OWNER_ID`);
  // 源码回归锁：确保"OWNER_ID 优先"的修复没被改回去（main 4 处 + tools.send_message 1 处）
  try {
    const ownerFirst = /process\.env\.OWNER_ID\s*\|\|[\s\S]{0,80}?process\.env\.WECOM_TARGET_ID/g;
    const mainSrc = readFileSync(join(dir, 'main.mjs'), 'utf8');
    const toolsSrc = readFileSync(join(dir, 'tools.mjs'), 'utf8');
    const nMain = (mainSrc.match(ownerFirst) || []).length;
    const nTools = (toolsSrc.match(ownerFirst) || []).length;
    check(nMain >= 4 && nTools >= 1,
      `源码回归锁：OWNER_ID 优先链在位（main.mjs ×${nMain} / tools.mjs ×${nTools}）`,
      `源码回归锁失败：OWNER_ID 优先链 main.mjs ×${nMain}（应≥4）/ tools.mjs ×${nTools}（应≥1）——07-07 泄漏修复可能被改掉了`);
    // send_message 收件人 schema 锁：paramSchema 不得出现 target 参数（防二阶注入借身份外发）
    const smStart = toolsSrc.indexOf("name: 'send_message'");
    const smEnd = toolsSrc.indexOf('fn:', smStart);
    const smBlock = smStart >= 0 && smEnd > smStart ? toolsSrc.slice(smStart, smEnd) : '';
    check(smBlock && !/\btarget\s*:/.test(smBlock),
      'send_message schema 锁在位（无 target 参数，收件人恒为 owner）',
      'send_message 的 paramSchema 出现 target 参数——安全锁被解开了（06-25 加固要求恒锁 owner）');
  } catch (e) { warn(`源码回归锁检查跳过（读不到源码）：${e.message}`); }

  // ---- C. 身份 / 天气 ----
  console.log('\n== C. 身份与天气 ==');
  const idPath = resolveIdentityPath(dir, env.XW2_IDENTITY);
  let identity = null;
  if (!existsSync(idPath)) {
    // identity.mjs 会静默回落中性默认身份——对朋友实例这意味着丢掉全部人设，必须红
    fail(`身份文件不存在：${idPath}（identity.mjs 会静默回落中性身份=人设整个丢失）`);
  } else {
    try { identity = JSON.parse(readFileSync(idPath, 'utf8')); pass(`身份文件可解析：${idPath}`); }
    catch (e) { fail(`身份文件 JSON 解析失败：${e.message}`); }
  }
  if (identity) check(identity.ownerName, `ownerName=「${identity.ownerName}」`, '身份缺 ownerName');

  let ADCODE = null, weatherBriefing = null;
  try { ({ ADCODE, weatherBriefing } = await import(pathToFileURL(join(dir, 'weather.mjs')).href)); }
  catch (e) { warn(`weather.mjs 导入失败，城市检查跳过：${e.message}`); }
  const cities = [...new Set([
    ...((identity && identity.weatherMorningCities) || ['上海']),
    ...((identity && identity.weatherEveningCities) || ['上海']),
  ])];
  if (ADCODE) {
    const bad = cities.filter((c) => c && !ADCODE[c]);
    check(bad.length === 0,
      `身份全部城市天气可用：${cities.join('/')}`,
      `城市不在 ADCODE：${bad.join('/')}（该城天气每天默默失败——西安事故同款）。去 weather.mjs ADCODE 补`);
    // tools.get_weather 的 enum 必须从 ADCODE 派生（加城市只改一处）
    try {
      const toolsSrc = readFileSync(join(dir, 'tools.mjs'), 'utf8');
      check(/enum:\s*Object\.keys\(ADCODE\)/.test(toolsSrc),
        'get_weather enum 从 ADCODE 派生（单一真相源）',
        'get_weather 的 enum 不再从 ADCODE 派生——加城市会漏改，硬编码回归');
    } catch { warn('tools.mjs 读不到，enum 派生检查跳过'); }
  }
  // 真实天气调用（--offline 跳过）：每城真返数据才算通
  if (!offline && weatherBriefing && ADCODE) {
    for (const c of cities) {
      if (!ADCODE[c]) continue; // 上面已红过，不重复
      try {
        const text = await weatherBriefing({ cities: [c], fromIdx: 0, days: 1 });
        check(typeof text === 'string' && text.length > 10, `高德实测 ${c}：返回真实数据`, `高德实测 ${c}：返回异常（${String(text).slice(0, 40)}）`);
      } catch (e) { fail(`高德实测 ${c} 失败：${e.message}`); }
    }
  } else if (offline) warn('（--offline）跳过高德真实调用');

  // ---- D. 路由（router.config.json）----
  console.log('\n== D. 路由 ==');
  const rcPath = join(dir, 'router.config.json');
  let rc = null;
  if (!existsSync(rcPath)) warn(`router.config.json 不在（本地开发机正常；服务器上必须有）：${rcPath}`);
  else {
    try { rc = JSON.parse(readFileSync(rcPath, 'utf8')); pass('router.config.json 可解析'); }
    catch (e) { fail(`router.config.json 解析失败：${e.message}`); }
  }
  if (rc) {
    const routes = rc.routes || {};
    const myRoute = OWNER ? routes[OWNER] : null;
    check(myRoute, `路由存在：${OWNER} → ${myRoute}`, `router 没有 OWNER_ID(${OWNER}) 的路由——这个租户根本收不到消息`);
    if (myRoute) {
      let u = null;
      try { u = new URL(myRoute); } catch { fail(`路由目标不是合法 URL：${myRoute}`); }
      if (u) {
        check(Number(u.port) === port, `路由端口 ${u.port} == HTTP_PORT ${port}`, `路由端口 ${u.port} ≠ HTTP_PORT ${port}——消息进不到这个后端`);
        check(env.WECOM_CALLBACK_SECRET && u.pathname === `/cb/${env.WECOM_CALLBACK_SECRET}`,
          '路由路径命中本租户回调密钥 /cb/<secret>',
          `路由路径(${u.pathname}) ≠ /cb/<本租户 WECOM_CALLBACK_SECRET>——router 转发会被后端 404 静默丢`);
      }
    }
    check(rc.defaultTarget === null || rc.defaultTarget === undefined || rc.defaultTarget === '',
      'default-deny：defaultTarget 为空（未知发件人一律丢弃）',
      `defaultTarget=「${rc.defaultTarget}」——未知发件人会被兜底转发，违反 default-deny（团队原则3）`);
    // 一租户一后端：除 OWNER 外不得有别的 sender 指到本租户端口（防老测试号残留路由串消息）
    const intruders = Object.entries(routes)
      .filter(([sid, url]) => sid !== OWNER && (() => { try { return Number(new URL(url).port) === port; } catch { return false; } })())
      .map(([sid]) => sid);
    check(intruders.length === 0,
      `端口 ${port} 只服务 OWNER 一个发件人`,
      `其他发件人也路由到本租户端口 ${port}：${intruders.join(',')}——别人的消息会进这个租户的库（老测试号残留同款）`);
  }
  check(!rc || Number(rc.port || 8080) !== port,
    'HTTP_PORT 不与 router 公网端口冲突',
    `HTTP_PORT=${port} 撞上 router 端口——后端起不来或劫持回调`);

  // ---- E. 库隔离 ----
  console.log('\n== E. 数据库隔离 ==');
  const dbPath = env.XW2_DB_PATH ? resolve(env.XW2_DB_PATH) : '';
  check(dbPath, `XW2_DB_PATH=${dbPath}`, 'XW2_DB_PATH 缺失——两实例会共用默认库=数据串库');
  const others = otherTenantEnvs(dir, envPath).map((p) => {
    try { return { p, env: parseEnvFile(p) }; } catch { return { p, env: {} }; }
  });
  for (const o of others) {
    const odb = o.env.XW2_DB_PATH ? resolve(o.env.XW2_DB_PATH) : resolve(join(dir, 'v2.db'));
    check(!dbPath || dbPath !== odb,
      `库与 ${o.p} 隔离`,
      `库路径与 ${o.p} 相同（${dbPath}）——两租户共用一个库=隐私互通`);
  }
  if (dbPath && existsSync(dbPath)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout=5000;');
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
        const need = ['episodes', 'facts', 'outbox', 'tasks', 'heartbeat', 'recurring_jobs', 'esm_raw', 'notes', 'media_log'];
        const missing = need.filter((t) => !tables.has(t));
        check(missing.length === 0, `核心表齐全（${need.length} 张）`, `库缺表：${missing.join(',')}——schema 迁移没跑全`);
        const hb = tables.has('heartbeat') ? db.prepare('SELECT ts FROM heartbeat WHERE id=1').get() : null;
        if (hb && Date.now() - Number(hb.ts) < 10 * 60 * 1000) pass(`heartbeat 新鲜（${Math.round((Date.now() - Number(hb.ts)) / 1000)}s 前）=实例活着`);
        else warn('heartbeat 不新鲜或缺失（实例没在跑？开通前验收属正常，上线后再跑一次应变绿）');
      } finally { try { db.close(); } catch { /* 忽略 */ } }
    } catch (e) { warn(`库只读检查失败（node:sqlite 不可用或锁死）：${e.message}`); }
  } else if (dbPath) {
    warn(`库文件还不存在（${dbPath}）——首次开通属正常，服务首启会建；上线后再跑一次应全绿`);
  }

  // ---- F. 沙箱 / 媒体目录隔离（空值会回落共享默认目录=隐私混写）----
  console.log('\n== F. 沙箱与媒体隔离 ==');
  const effSandbox = resolve(env.XW2_SANDBOX_DIR || join(dir, 'workspace'));
  const effMedia = resolve(env.MEDIA_DIR || join(dir, 'media'));
  for (const o of others) {
    const oSandbox = resolve(o.env.XW2_SANDBOX_DIR || join(dir, 'workspace'));
    const oMedia = resolve(o.env.MEDIA_DIR || join(dir, 'media'));
    check(effSandbox !== oSandbox,
      `沙箱与 ${o.p} 隔离（${effSandbox}）`,
      `沙箱目录与 ${o.p} 相同（${effSandbox}）——read_file/write_file 跨租户互见`);
    check(effMedia !== oMedia,
      `媒体目录与 ${o.p} 隔离（${effMedia}）`,
      `媒体目录与 ${o.p} 相同（${effMedia}）——图片/语音原件跨租户混存`);
  }
  if (!others.length) warn('同目录没发现其它租户 env，隔离对照跳过（单租户部署正常）');

  // ---- G. ESM 开关 ----
  console.log('\n== G. ESM 开关 ==');
  const esmVal = env.ESM_ENABLED === undefined ? '' : String(env.ESM_ENABLED);
  check(['', '0', '1'].includes(esmVal),
    `ESM_ENABLED=「${esmVal || '(未设=开)'}」（代码语义：!== '0' 即开）`,
    `ESM_ENABLED=「${esmVal}」是脚枪——代码判定是 !== '0'，这个值实际=开。想关就写 0`);

  // ---- G2. 运营者上报通道（report_to_operator，随租户变的出站路径→按防腐纪律进清单）----
  console.log('\n== G2. 运营者上报 ==');
  const op = String(env.OPERATOR_ID || '');
  if (op) {
    check(op !== OWNER,
      `OPERATOR_ID(${op}) ≠ OWNER_ID（上报通道指向运营者，工具会注册）`,
      `OPERATOR_ID == OWNER_ID(${op})——上报会发回主人自己，通道无意义且不该注册`);
  } else {
    warn('OPERATOR_ID 未配置——report_to_operator 不注册（运营者本人的实例属正常；朋友租户建议配置指向运营者）');
  }

  // ---- H. systemd 绑定（仅在真实部署目录 + Linux 上有意义；夹具/本地跳过）----
  console.log('\n== H. systemd ==');
  if (process.platform === 'linux' && dir === HERE) {
    try {
      const units = readdirSync('/etc/systemd/system').filter((f) => f.startsWith('xiaowang') && f.endsWith('.service'));
      const mine = units.filter((u) => {
        try { return readFileSync(join('/etc/systemd/system', u), 'utf8').includes(`EnvironmentFile=${envPath}`); }
        catch { return false; }
      });
      check(mine.length === 1, `systemd unit 唯一绑定本 env：${mine[0] || '(无)'}`,
        mine.length === 0 ? `没有 unit 的 EnvironmentFile 指向 ${envPath}——这个租户没有服务在管`
          : `多个 unit 指向同一 env（${mine.join(',')}）——两个服务抢一个库`);
      if (mine.length === 1) {
        try {
          const state = execFileSync('systemctl', ['is-active', mine[0].replace(/\.service$/, '')], { timeout: 10000 }).toString().trim();
          if (state === 'active') pass(`服务 ${mine[0]} active`);
          else warn(`服务 ${mine[0]} 状态=${state}（开通前验收属正常）`);
        } catch { warn(`服务 ${mine[0]} 未激活（开通前验收属正常）`); }
      }
    } catch (e) { warn(`systemd 检查跳过：${e.message}`); }
  } else warn('非服务器部署目录（本地开发/夹具），systemd 检查跳过');

  return summarize();
}

function summarize() {
  console.log('\n== 汇总 ==');
  let nPass = 0, nFail = 0, nWarn = 0;
  for (const [mark, msg] of results) {
    console.log(`  ${mark} ${msg}`);
    if (mark === '✓') nPass++; else if (mark === '✗') nFail++; else nWarn++;
  }
  console.log(`\n${nFail === 0 ? '🟢' : '🔴'} 通过 ${nPass} / 警告 ${nWarn} / 失败 ${nFail}`);
  return nFail === 0;
}

// =====================================================================
// --selftest：离线自测（临时夹具目录，不碰真实配置、不联网、不写真实文件）。
// 覆盖：好租户 0 失败；坏租户的经典事故逐一变红（收发分叉/坏城市/路由密钥错/
// default-deny 破洞/库路径相撞/残留发件人/ESM 脚枪值）；env 缺失红而不崩。
// 顺序有讲究：先在"只有好租户"的世界里验好租户（0 失败），再写入坏租户与坏
// 路由配置验坏租户——避免坏夹具反向污染好租户的隔离对照。
// =====================================================================
async function selftest() {
  let failCnt = 0;
  const ok = (cond, name) => { console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`); if (!cond) failCnt++; };
  const tmp = mkdtempSync(join(tmpdir(), 'verify-tenant-'));
  try {
    // 夹具：源码锁检查/城市检查要读真实 weather.mjs/tools.mjs/main.mjs/identity.mjs
    for (const f of ['weather.mjs', 'tools.mjs', 'main.mjs', 'identity.mjs']) {
      writeFileSync(join(tmp, f), readFileSync(join(HERE, f)));
    }
    const idDir = join(tmp, 'identities');
    mkdirSync(idDir, { recursive: true });
    writeFileSync(join(idDir, 'good.json'), JSON.stringify({ ownerName: '测试主人', weatherMorningCities: ['上海'], weatherEveningCities: ['深圳'] }));
    writeFileSync(join(idDir, 'bad.json'), JSON.stringify({ ownerName: '坏主人', weatherMorningCities: ['火星'] }));
    writeFileSync(join(tmp, 'good.env'), [
      'OWNER_ID=GOODOWNER', 'WECOM_TARGET_ID=GOODOWNER', 'WECOM_TOKEN=t', 'WECOM_GUID=g',
      'WECOM_CALLBACK_SECRET=sec-good', 'HTTP_PORT=9081',
      `XW2_DB_PATH=${join(tmp, 'good.db').replace(/\\/g, '/')}`,
      `XW2_SANDBOX_DIR=${join(tmp, 'ws-good').replace(/\\/g, '/')}`,
      `MEDIA_DIR=${join(tmp, 'media-good').replace(/\\/g, '/')}`,
      'XW2_IDENTITY=good', 'ESM_ENABLED=0', 'OPERATOR_ID=THEOPERATOR',
    ].join('\n'));
    // 世界 v1：只有好租户 + 干净路由
    writeFileSync(join(tmp, 'router.config.json'), JSON.stringify({
      port: 8080,
      routes: { GOODOWNER: 'http://127.0.0.1:9081/cb/sec-good' },
      defaultTarget: null,
    }));

    results.length = 0;
    const goodOk = await verify('good', { dir: tmp, offline: true });
    ok(goodOk, '好租户验收通过（0 失败）');

    // 世界 v2：加入坏租户（收发分叉/撞库/坏城市/脚枪 ESM）+ 坏路由（密钥错/残留发件人/defaultTarget 破洞）
    writeFileSync(join(tmp, 'bad.env'), [
      'OWNER_ID=BADOWNER', 'WECOM_TARGET_ID=OLDTESTID', // 收发分叉（泄漏事故同款）
      'WECOM_TOKEN=t', 'WECOM_GUID=g', 'WECOM_CALLBACK_SECRET=sec-bad', 'HTTP_PORT=9082',
      `XW2_DB_PATH=${join(tmp, 'good.db').replace(/\\/g, '/')}`, // 故意撞 good 的库
      'XW2_IDENTITY=bad', 'ESM_ENABLED=false', // 脚枪值：!== '0' 实际是开
      'OPERATOR_ID=BADOWNER', // 故意 == OWNER：上报发回自己
    ].join('\n'));
    writeFileSync(join(tmp, 'router.config.json'), JSON.stringify({
      port: 8080,
      routes: {
        GOODOWNER: 'http://127.0.0.1:9081/cb/sec-good',
        BADOWNER: 'http://127.0.0.1:9082/cb/WRONG', // 路由密钥不匹配
        LEFTOVER: 'http://127.0.0.1:9082/cb/x',     // 残留发件人同端口
      },
      defaultTarget: 'http://127.0.0.1:9082/cb/x',  // default-deny 破洞
    }));

    results.length = 0;
    const badOk = await verify('bad', { dir: tmp, offline: true });
    const failsText = results.filter(([m]) => m === '✗').map(([, s]) => s).join('\n');
    ok(!badOk, '坏租户验收整体为红');
    ok(/≠ WECOM_TARGET_ID/.test(failsText), '抓出：收发 id 分叉（泄漏事故）');
    ok(/不在 ADCODE/.test(failsText), '抓出：身份城市不支持（西安事故）');
    ok(/路由路径/.test(failsText), '抓出：路由密钥不匹配');
    ok(/default-deny|defaultTarget/.test(failsText), '抓出：defaultTarget 破洞');
    ok(/库路径与/.test(failsText), '抓出：两租户库路径相撞');
    ok(/别人的消息会进这个租户的库/.test(failsText), '抓出：残留发件人路由到同端口');
    ok(/脚枪/.test(failsText), '抓出：ESM_ENABLED 脚枪值');
    ok(/上报会发回主人自己/.test(failsText), '抓出：OPERATOR_ID == OWNER_ID（上报通道自环）');

    // env 缺失：直接红且不崩
    results.length = 0;
    const missOk = await verify('nonexistent', { dir: tmp, offline: true });
    ok(!missOk, 'env 文件缺失：红而不崩');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
  console.log(`\nselftest: ${failCnt === 0 ? 'ALL PASS' : failCnt + ' FAIL'}`);
  process.exit(failCnt === 0 ? 0 : 1);
}

// ---- 入口 ----
const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  await selftest();
} else {
  const tenant = args.find((a) => !a.startsWith('--'));
  if (!tenant) {
    console.error('用法：node verify_tenant.mjs <ziqi|friend|/path/to/x.env> [--offline]');
    process.exit(2);
  }
  const okAll = await verify(tenant, { offline: args.includes('--offline') });
  process.exit(okAll ? 0 : 1);
}
