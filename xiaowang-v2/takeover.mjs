// =====================================================================
// takeover.mjs —— 接管包导出（可接管性靠结构，不靠小王活着）
//
// 目标：主人随时接管这台机器时，"小王知道的一切重要内容"都躺在
// 沙箱/接管/ 下，打开 index.html 一页看懂——锚点记忆、守则、黑匣子笔记、
// 日程、文件台账、项目树。md 是正本格式，HTML 是阅读视图（子淇拍板：
// 接管阅读体验优先 HTML；要 PDF 用浏览器打印即可，2C2G 不装渲染器）。
//
// 纪律：
// - 纯确定性、零 LLM、零写库——只读打开库（readOnly，不碰服务进程的单写连接，
//   与 watchdog_cron.mjs 同款姿势）。
// - 独立模块 + cron 每日跑（而非 loop 里的工具）：接管包恰恰要在小王不工作/
//   已死时也新鲜（原则2/6）。手动刷新：node takeover.mjs --export
// - 产物只落沙箱，绝不进 PUBLISHED_DIR——里面是主人的记忆，不能有公网可达路径。
// - 可整块删除：删本文件 + crontab 一行即退场，正本（库/文件树）不受影响。
// =====================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DIR = import.meta.dirname;
const EXPORT_SUBDIR = '接管';

// ---- 小工具：CST 时间、HTML 转义、原子写 ----
function fmtCst(ms) {
  if (ms == null) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
// 所有入 HTML 的内容都过这里——notes/facts 是用户原话，必须转义（防自我注入破坏视图）。
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function atomicWrite(fp, content) {
  const tmp = fp + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, fp);
}

// ---- 数据收集：每节独立 try/catch——某张表缺失（旧库/空库）降级为提示行，绝不整包失败 ----
function collect(dbPath, sandboxDir) {
  const out = { generatedAt: Date.now(), dbPath, sandboxDir };
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    out.dbError = `库打不开（${e.message}）——只导出文件侧`;
  }
  const q = (label, fn, fallback = []) => {
    if (!db) return fallback;
    try { return fn(db); } catch (e) { console.error(`[takeover] ${label} 读取失败(降级): ${e.message}`); return fallback; }
  };

  out.anchorsCore = q('anchors-core', (d) =>
    d.prepare(`SELECT entity, fact FROM facts WHERE pinned=1 AND pin_tier='core' AND superseded_by IS NULL ORDER BY importance DESC, id`).all());
  out.anchorsIndex = q('anchors-index', (d) =>
    d.prepare(`SELECT entity, fact FROM facts WHERE pinned=1 AND pin_tier='index' AND superseded_by IS NULL ORDER BY id`).all());
  out.facts = q('facts', (d) =>
    d.prepare(`SELECT id, entity, fact, pinned, created_at FROM facts WHERE superseded_by IS NULL ORDER BY entity, id LIMIT 500`).all());
  out.notes = q('notes', (d) =>
    d.prepare(`SELECT id, ts, content, source FROM notes ORDER BY ts DESC LIMIT 500`).all());
  out.notesTotal = q('notes-count', (d) => d.prepare(`SELECT COUNT(*) c FROM notes`).get().c, 0);
  out.recurring = q('recurring', (d) =>
    d.prepare(`SELECT id, name, fire_hm, enabled FROM recurring_jobs ORDER BY fire_hm`).all());
  out.tasksPending = q('tasks-pending', (d) =>
    d.prepare(`SELECT id, created_at, next_run_at, payload FROM tasks WHERE status='pending' ORDER BY next_run_at LIMIT 50`).all()
      .map((t) => ({ ...t, note: taskNote(t.payload) })));
  out.tasksDone = q('tasks-done', (d) =>
    d.prepare(`SELECT id, next_run_at, payload FROM tasks WHERE status='done' ORDER BY id DESC LIMIT 10`).all()
      .map((t) => ({ ...t, note: taskNote(t.payload) })));
  try { db && db.close(); } catch { /* 只读连接关闭失败不影响导出 */ }

  // 文件侧：台账原文 + 工作区两层树
  try {
    const fp = join(sandboxDir, 'FILES.md');
    out.filesLedger = existsSync(fp) ? readFileSync(fp, 'utf8') : '';
  } catch { out.filesLedger = ''; }
  out.tree = scanTree(sandboxDir);
  return out;
}

function taskNote(payload) {
  try { return (JSON.parse(payload) || {}).note || ''; } catch { return ''; }
}

// 工作区两层树（跳过 接管/ 自身与隐藏文件；只列结构不读内容）
function scanTree(root) {
  const lines = [];
  let entries = [];
  try { entries = readdirSync(root).filter((n) => !n.startsWith('.') && n !== EXPORT_SUBDIR).sort(); } catch { return lines; }
  for (const name of entries) {
    const abs = join(root, name);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { continue; }
    lines.push(isDir ? name + '/' : name);
    if (isDir) {
      try {
        for (const child of readdirSync(abs).filter((n) => !n.startsWith('.')).sort().slice(0, 50)) {
          lines.push('  ' + child + (statSync(join(abs, child)).isDirectory() ? '/' : ''));
        }
      } catch { /* 子目录读不了就只列目录名 */ }
    }
  }
  return lines;
}

// ---- 渲染：md 正本 ----
function renderMemoryMd(c) {
  const L = [`# 记忆快照（生成于 ${fmtCst(c.generatedAt)}）`, '', '正本在 SQLite（facts 表）；本文件是每日镜像，供不跑程序直接读。', ''];
  L.push('## 核心锚点（每轮对话全文在场）', '');
  for (const a of c.anchorsCore) L.push(`- ${a.entity ? `[${a.entity}] ` : ''}${a.fact}`);
  L.push('', '## 专题守则索引（索引行，正文见事实库/黑匣子）', '');
  for (const a of c.anchorsIndex) L.push(`- ${a.entity ? `[${a.entity}] ` : ''}${a.fact}`);
  L.push('', '## 事实库全量（含已不常驻的历史事实）', '');
  for (const f of c.facts) L.push(`- ${f.pinned ? '📌 ' : ''}${f.entity ? `[${f.entity}] ` : ''}${f.fact}`);
  return L.join('\n') + '\n';
}
function renderNotesMd(c) {
  const L = [`# 黑匣子笔记（共 ${c.notesTotal} 条，导出最近 ${c.notes.length} 条；生成于 ${fmtCst(c.generatedAt)}）`, '', '正本在 SQLite（notes 表，只追加不可改写）。#快记与归档正文都在这。', ''];
  for (const n of [...c.notes].reverse()) L.push(`## ${fmtCst(n.ts)} （#${n.id}·${n.source}）`, '', n.content, '');
  return L.join('\n');
}
function renderScheduleMd(c) {
  const L = [`# 日程（生成于 ${fmtCst(c.generatedAt)}）`, '', '## 周期任务', ''];
  for (const j of c.recurring) L.push(`- ${j.enabled ? '✅' : '⛔'} ${j.fire_hm} ${j.name}`);
  L.push('', '## 待触发的一次性任务', '');
  for (const t of c.tasksPending) L.push(`- ${fmtCst(t.next_run_at)} ｜ ${t.note || '(无说明)'}`);
  L.push('', '## 最近完成的 10 条', '');
  for (const t of c.tasksDone) L.push(`- ${fmtCst(t.next_run_at)} ｜ ${t.note || '(无说明)'}`);
  return L.join('\n') + '\n';
}

// ---- 渲染：index.html 阅读视图（自包含单文件、明暗双主题、零外部依赖） ----
function renderHtml(c) {
  const sec = (id, title, inner) => `<section id="${id}"><h2>${title}</h2>${inner}</section>`;
  const ul = (rows) => `<ul>${rows.join('')}</ul>`;
  const li = (s) => `<li>${s}</li>`;

  const nav = [
    ['mem', '记忆锚点'], ['facts', '事实库'], ['notes', '黑匣子'],
    ['sched', '日程'], ['files', '文件台账'], ['tree', '工作区'],
  ].map(([id, t]) => `<a href="#${id}">${t}</a>`).join('');

  const coreLis = c.anchorsCore.map((a) => li(`${a.entity ? `<b>[${esc(a.entity)}]</b> ` : ''}${esc(a.fact)}`));
  const idxLis = c.anchorsIndex.map((a) => li(`${a.entity ? `<b>[${esc(a.entity)}]</b> ` : ''}${esc(a.fact)}`));
  const factLis = c.facts.map((f) => li(`${f.pinned ? '<span class="pin">钉</span> ' : ''}${f.entity ? `<b>[${esc(f.entity)}]</b> ` : ''}${esc(f.fact)}`));
  const noteBlocks = [...c.notes].reverse().map((n) =>
    `<article><div class="nh">${fmtCst(n.ts)} <span class="dim">#${n.id} · ${esc(n.source)}</span></div><pre>${esc(n.content)}</pre></article>`).join('');
  const recRows = c.recurring.map((j) => `<tr><td>${j.enabled ? '启用' : '停用'}</td><td class="mono">${esc(j.fire_hm)}</td><td>${esc(j.name)}</td></tr>`).join('');
  const pendRows = c.tasksPending.map((t) => `<tr><td class="mono">${fmtCst(t.next_run_at)}</td><td>${esc(t.note || '(无说明)')}</td></tr>`).join('');
  const doneRows = c.tasksDone.map((t) => `<tr><td class="mono">${fmtCst(t.next_run_at)}</td><td>${esc(t.note || '(无说明)')}</td></tr>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小王 · 接管包 ${fmtCst(c.generatedAt).slice(0, 10)}</title>
<style>
:root{--bg:#f5f6f5;--card:#fff;--ink:#1a2420;--ink2:#4c5854;--dim:#7d8884;--line:#dde3e0;--acc:#0f5f56;--tint:#e3efec;}
@media (prefers-color-scheme: dark){:root{--bg:#101715;--card:#182220;--ink:#e8eeec;--ink2:#aab6b1;--dim:#75827d;--line:#2a3532;--acc:#4fb8a8;--tint:#16302b;}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 "Microsoft YaHei","PingFang SC",sans-serif;}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:1.7rem;margin:.2em 0}.sub{color:var(--ink2);margin:0 0 6px}.stamp{color:var(--dim);font-size:.85rem}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
nav a{color:var(--acc);text-decoration:none;font-size:.9rem;border:1px solid var(--line);border-radius:999px;padding:4px 12px;background:var(--card)}
.note{background:var(--tint);border-radius:10px;padding:12px 16px;font-size:.92rem;color:var(--ink2);margin-top:14px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:22px;overflow-x:auto}
h2{font-size:1.15rem;margin:0 0 12px;color:var(--acc)}h3{font-size:.98rem;margin:16px 0 8px}
ul{margin:0;padding-left:1.2em}li{margin:4px 0;color:var(--ink2)}li b{color:var(--ink)}
.pin{display:inline-block;background:var(--tint);color:var(--acc);border-radius:5px;font-size:.72rem;padding:1px 6px;font-weight:700}
table{border-collapse:collapse;width:100%;font-size:.92rem}td,th{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left;color:var(--ink2)}th{color:var(--ink)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:.86em;white-space:nowrap}.dim{color:var(--dim);font-weight:400;font-size:.85em}
article{border-top:1px solid var(--line);padding:10px 0}article:first-of-type{border-top:none}
.nh{font-weight:700;font-size:.9rem}pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:inherit;color:var(--ink2)}
</style></head><body><div class="wrap">
<h1>小王 · 接管包</h1>
<p class="sub">这台机器上小王知道的一切重要内容，一页读完。给随时可能亲自接管的主人。</p>
<p class="stamp">生成于 ${fmtCst(c.generatedAt)}（每日自动刷新）　库：${esc(c.dbPath)}${c.dbError ? ` ｜ <b>注意：${esc(c.dbError)}</b>` : ''}</p>
<nav>${nav}</nav>
<div class="note">正本原则：文件在工作区文件树里、记忆在 SQLite 里，本页只是镜像视图。同目录下有对应的 .md 正本镜像（记忆.md / 黑匣子.md / 日程.md）。</div>
${sec('mem', '记忆锚点', `<h3>核心（每轮对话全文在场，上限 12 席）</h3>${ul(coreLis)}<h3>专题守则索引（一行索引，正文在事实库/黑匣子）</h3>${ul(idxLis)}`)}
${sec('facts', `事实库全量（${c.facts.length} 条有效）`, ul(factLis))}
${sec('notes', `黑匣子笔记（共 ${c.notesTotal} 条，展示最近 ${c.notes.length} 条）`, noteBlocks || '<p class="dim">（空）</p>')}
${sec('sched', '日程', `<h3>周期任务</h3><table><tr><th>状态</th><th>时刻</th><th>任务</th></tr>${recRows}</table><h3>待触发</h3><table><tr><th>触发时刻</th><th>内容</th></tr>${pendRows || '<tr><td colspan="2" class="dim">（无）</td></tr>'}</table><h3>最近完成</h3><table><tr><th>触发时刻</th><th>内容</th></tr>${doneRows}</table>`)}
${sec('files', '文件台账（FILES.md 原文）', `<pre>${esc(c.filesLedger || '（尚无台账）')}</pre>`)}
${sec('tree', '工作区文件树（两层）', `<pre>${esc(c.tree.join('\n') || '（空）')}</pre>`)}
</div></body></html>`;
}

// ---- 导出主入口 ----
export function runExport({ dbPath, sandboxDir } = {}) {
  const db = dbPath || process.env.XW2_DB_PATH || join(DIR, 'v2.db');
  const sandbox = resolve(sandboxDir || process.env.XW2_SANDBOX_DIR || join(DIR, 'workspace'));
  const c = collect(db, sandbox);
  const outDir = join(sandbox, EXPORT_SUBDIR);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  atomicWrite(join(outDir, '记忆.md'), renderMemoryMd(c));
  atomicWrite(join(outDir, '黑匣子.md'), renderNotesMd(c));
  atomicWrite(join(outDir, '日程.md'), renderScheduleMd(c));
  atomicWrite(join(outDir, 'index.html'), renderHtml(c));
  console.log(`[takeover] 导出完成 → ${outDir}（core ${c.anchorsCore.length} / index ${c.anchorsIndex.length} / facts ${c.facts.length} / notes ${c.notes.length}）`);
  return { dir: outDir, counts: { core: c.anchorsCore.length, index: c.anchorsIndex.length, facts: c.facts.length, notes: c.notes.length } };
}

const IS_MAIN = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN && process.argv.includes('--export')) {
  runExport();
}

// ---- selftest：临时库 + 临时沙箱，全离线 ----
if (IS_MAIN && process.argv.includes('--selftest')) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

  const dir = mkdtempSync(join(tmpdir(), 'xw2-tko-'));
  const dbPath = join(dir, 'v2.db');
  process.env.XW2_DB_PATH = dbPath;
  const dbm = await import('./db.mjs');
  dbm.initDb(dbPath);
  const { initRecurringSchema, addJob } = await import('./recurring.mjs');
  initRecurringSchema(dbm.getDb());
  dbm.tx((c) => {
    c.prepare(`INSERT INTO facts (entity, fact, source, confidence, created_at, valid_from, importance, pinned, pin_tier)
               VALUES ('铁律', '12个月不换方向', 'user_said', 0.95, 1, 1, 0.9, 1, 'core')`).run();
    c.prepare(`INSERT INTO facts (entity, fact, source, confidence, created_at, valid_from, importance, pinned, pin_tier)
               VALUES ('购车', '购车框架已立——memory_search 购车', 'user_said', 0.95, 1, 1, 0.9, 1, 'index')`).run();
    c.prepare(`INSERT INTO notes (ts, session_id, content, source) VALUES (1000, 's', '含 <script>alert(1)</script> 的笔记', 'hashtag')`).run();
    c.prepare(`INSERT INTO tasks (kind, status, payload, created_at, updated_at, next_run_at, attempts)
               VALUES ('agentic', 'pending', '{"note":"发薪日提醒"}', 1000, 1000, 2000, 0)`).run();
  });
  addJob(dbm.getDb(), { name: '测试天气', fireHm: '08:30', action: { type: 'x' } });

  const sandbox = join(dir, 'sandbox');
  mkdirSync(join(sandbox, 'projects', '演示项目'), { recursive: true });
  writeFileSync(join(sandbox, 'FILES.md'), '# 文件台账\n- inbox/a.md ｜ 2026-07-14 ｜ 长期 ｜ 演示', 'utf8');

  try {
    const r = runExport({ dbPath, sandboxDir: sandbox });
    ok(existsSync(join(sandbox, '接管', 'index.html')), '导出生成 index.html');
    ok(r.counts.core === 1 && r.counts.index === 1, '锚点分 tier 计数正确');
    const html = readFileSync(join(sandbox, '接管', 'index.html'), 'utf8');
    ok(html.includes('12个月不换方向') && html.includes('购车框架已立'), 'HTML 含 core 与 index 锚点');
    ok(html.includes('&lt;script&gt;') && !html.includes('<script>alert'), '笔记内容 HTML 转义（防自我注入破坏视图）');
    ok(html.includes('发薪日提醒') && html.includes('测试天气'), 'HTML 含待触发任务与周期任务');
    ok(html.includes('演示') && html.includes('FILES.md'), 'HTML 含文件台账原文');
    ok(html.includes('projects/') && html.includes('演示项目'), 'HTML 含两层工作区树');
    ok(readFileSync(join(sandbox, '接管', '记忆.md'), 'utf8').includes('[购车] 购车框架已立'), '记忆.md 正本镜像含索引锚点');
    ok(readFileSync(join(sandbox, '接管', '黑匣子.md'), 'utf8').includes('alert(1)'), '黑匣子.md 保留原文（md 不转义）');
    ok(readFileSync(join(sandbox, '接管', '日程.md'), 'utf8').includes('08:30 测试天气'), '日程.md 含周期任务');
    const r2 = runExport({ dbPath, sandboxDir: sandbox });
    ok(r2.counts.core === 1, '二次导出幂等覆盖不报错');
    // 库侧被删/坏时降级不崩（只导文件侧）
    const r3 = runExport({ dbPath: join(dir, '不存在.db'), sandboxDir: sandbox });
    ok(existsSync(join(sandbox, '接管', 'index.html')) && r3.counts.core === 0, '库不可读 → 降级只导文件侧，不崩');
  } catch (e) {
    fail++; console.log('  ✗ selftest 异常: ' + e.stack);
  } finally {
    try { dbm.__closeForTest && dbm.__closeForTest(); } catch { /* 收尾失败不影响结论 */ }
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n[takeover selftest] PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
