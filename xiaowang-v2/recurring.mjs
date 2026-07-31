// =====================================================================
// recurring.mjs —— 周期性任务调度（恢复自旧小王 scheduler.py 的"触发后重置 last_run"思路）。
//
// v2 原本只有一次性 schedule_task；这里补上"每天/每周固定时刻做 X"的共同底座——
// 天气播报、健康日报、新闻、日记提醒…一切 recurring 都长在它上面。任务是数据(表里的行)，机制是一次性投资。
//
// 设计取舍（少即是多 + 零依赖）：不引 cron-parser。日/周固定时刻用 'HH:MM'(CST) + 可选 dow，
// 复用 ESM 排程同款"纯读判定 → 到点/补发窗内未触发 → 触发"纪律。需要更复杂 cron 时再升级。
//
// 依赖方向（单向无环）：db ← recurring。本模块只读写自己的表 + 判定到期，【不执行动作】——
// 动作执行(发文案 / 派 agentic task)由 main 在 tick 里做（与 ESM esmDuePrompt 同构，保持 db←recurring 干净）。
// 可整块删除（原则6）：删本文件 + main 的 step②.6 即退回无周期任务。
// =====================================================================

import { getDb, nowMs, tx } from './db.mjs';

// 补发上限：到点后最多迟这么多分钟内仍补发（与 ESM 一致）；超了视为当天错过，不在离谱钟点补发。
const MAX_CATCHUP_LATE_MIN = 180;

// CST 墙钟（与 esm.mjs 同口径：epoch ms +8h 再取 getUTC*，不依赖 OS 时区）。
function cstParts() {
  const d = new Date(nowMs() + 8 * 3600 * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return { hm, date: d.toISOString().slice(0, 10), dow: d.getUTCDay() }; // dow: 0=周日
}
const hmToMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

// ---- schema：recurring_jobs（幂等建表） ----
export function initRecurringSchema(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      fire_hm         TEXT    NOT NULL,                 -- 'HH:MM' CST
      dow             INTEGER,                          -- 0-6(0=周日) 周几触发；NULL=每天
      kind            TEXT    NOT NULL DEFAULT 'agentic' CHECK (kind IN ('agentic','builtin')),
      action          TEXT    NOT NULL DEFAULT '{}',    -- builtin:{handler,params} / agentic:{message}
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_fired_date TEXT,                             -- 'YYYY-MM-DD' CST，当天只触发一次
      expires_on      TEXT,                             -- 'YYYY-MM-DD' CST 截止日(含当天)；NULL=无限期。过期由 sweepExpiredJobs 自动禁用
      created_at      INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recurring_enabled ON recurring_jobs (enabled);`);
  // 老库迁移：expires_on 列 2026-07-23 加（调度生命周期修复），已有该列则忽略。
  try { db.exec(`ALTER TABLE recurring_jobs ADD COLUMN expires_on TEXT`); } catch { /* 列已存在 */ }
  return db;
}

function parseAction(s) {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}

// ---- 到期判定（纯读，不写）：返回本拍应触发的 job（action 已 parse）。 ----
// 触发条件：enabled + (dow 为空=每天 或 dow 命中今天) + 已到点(hm>=fire) + 在补发窗内 + 当天未触发过。
export function dueRecurringJobs(db = getDb()) {
  const { hm, date, dow } = cstParts();
  const nowMin = hmToMin(hm);
  const rows = db.prepare(`SELECT * FROM recurring_jobs WHERE enabled = 1`).all();
  const due = [];
  for (const r of rows) {
    if (r.expires_on && date > r.expires_on) continue; // 已过截止日：不触发（禁用留痕由 sweepExpiredJobs 做）
    if (r.dow != null && r.dow !== dow) continue;
    const late = nowMin - hmToMin(r.fire_hm);
    if (late < 0 || late > MAX_CATCHUP_LATE_MIN) continue;
    if (r.last_fired_date === date) continue; // 当天已触发
    due.push({ ...r, action: parseAction(r.action), _date: date });
  }
  return due;
}

// ---- 过期清扫（写操作，与 dueRecurringJobs 的纯读判定分离；main 每拍先扫再判定到期）。 ----
// 为什么存在：2026-07-23 事故——"每天提醒直到周六"只能建成无限期任务，过了 DDL 继续天天响，
// 且触发会话会把原文里的相对日期("周六前")重新锚定到本周 → 任务永不过期。
// 禁用(enabled=0)而非删行：与 cancel 同纪律，留台账可对账/可复活。返回被禁用的行供 main 记日志。
export function sweepExpiredJobs(db = getDb()) {
  const { date } = cstParts();
  const rows = db.prepare(
    `SELECT id, name, expires_on FROM recurring_jobs WHERE enabled = 1 AND expires_on IS NOT NULL AND expires_on < ?`
  ).all(date);
  if (!rows.length) return [];
  tx((d) => {
    for (const r of rows) d.prepare(`UPDATE recurring_jobs SET enabled = 0 WHERE id = ?`).run(r.id);
  });
  return rows;
}

// 触发后落标（当天只触发一次）。与 enqueue/派 task 解耦：main 先成功执行动作再调它（失败则下拍重试）。
export function markJobFired(db, id, date) {
  tx((d) => {
    d.prepare(`UPDATE recurring_jobs SET last_fired_date = ? WHERE id = ?`).run(date, id);
  });
}

// ---- 管理接口（供 seed 脚本 / 未来的 schedule_recurring 工具用） ----
export function addJob(db, { name, fireHm, dow = null, kind = 'agentic', action = {}, expiresOn = null }) {
  if (!name || !fireHm) throw new Error('addJob: name 与 fireHm 必填');
  if (!/^\d{1,2}:\d{2}$/.test(fireHm)) throw new Error(`addJob: fireHm 需 'HH:MM'，得到 ${fireHm}`);
  if (kind !== 'agentic' && kind !== 'builtin') throw new Error(`addJob: kind 须 agentic|builtin`);
  if (expiresOn != null && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new Error(`addJob: expiresOn 需 'YYYY-MM-DD'，得到 ${expiresOn}`);
  return tx((d) => {
    const info = d.prepare(
      `INSERT INTO recurring_jobs (name, fire_hm, dow, kind, action, enabled, expires_on, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(name, fireHm, dow, kind, JSON.stringify(action ?? {}), expiresOn, nowMs());
    return Number(info.lastInsertRowid);
  });
}

export function listJobs(db = getDb()) {
  return db.prepare(`SELECT id,name,fire_hm,dow,kind,enabled,last_fired_date,expires_on,created_at FROM recurring_jobs ORDER BY fire_hm`).all();
}
export function removeJob(db, id) {
  return tx((d) => d.prepare(`DELETE FROM recurring_jobs WHERE id = ?`).run(id).changes);
}
export function setEnabled(db, id, enabled) {
  return tx((d) => d.prepare(`UPDATE recurring_jobs SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id).changes);
}
// 复活一个被取消(enabled=0)的任务并更新时间/内容：同名重建走这里（原地 UPDATE，不新增行）。
// 为什么需要：cancel 是禁用不删行，同名新建若一律被挡，"取消过的名字"就永远建不回来（线上真死锁过——
// list_schedules 又只显示启用中的，模型连挡路的是谁都看不见）。last_fired_date 清空=按新配置重新起算。
export function reviveJob(db, id, { fireHm, dow = null, action = {}, expiresOn = null }) {
  if (!/^\d{1,2}:\d{2}$/.test(fireHm || '')) throw new Error(`reviveJob: fireHm 需 'HH:MM'，得到 ${fireHm}`);
  if (expiresOn != null && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new Error(`reviveJob: expiresOn 需 'YYYY-MM-DD'，得到 ${expiresOn}`);
  return tx((d) => d.prepare(
    `UPDATE recurring_jobs SET fire_hm = ?, dow = ?, action = ?, expires_on = ?, enabled = 1, last_fired_date = NULL WHERE id = ?`
  ).run(fireHm, dow, JSON.stringify(action ?? {}), expiresOn, id).changes);
}

// =====================================================================
// --selftest：离线、临时 db，验建表/加任务/到期判定/落标幂等/补发窗。用可注入时钟钉死"现在"。
// =====================================================================
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

if (process.argv.includes('--selftest') && import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const db = await import('./db.mjs');
  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };
  console.log('recurring.mjs selftest (临时 db, 注入时钟)\n');

  const tmp = join(tmpdir(), `xw2-rec-${process.pid}-${Date.now()}.db`);
  process.env.XW2_DB_PATH = tmp;
  try {
    const conn = db.initDb(tmp);
    initRecurringSchema(conn);

    const wid = addJob(conn, { name: '天气-上海早', fireHm: '08:30', dow: null, kind: 'builtin', action: { handler: 'weather', preset: 'morning' } });
    const sun = addJob(conn, { name: '周日回顾', fireHm: '21:00', dow: 0, kind: 'agentic', action: { message: '回顾这周' } });
    ok(wid > 0 && sun > 0, 'addJob 返回 id');
    ok(listJobs(conn).length === 2, 'listJobs 列出 2 条');

    // 钉死到 2026-06-26(周五) 08:45 CST（08:30 已过、在 180min 补发窗内、当天未触发）
    db.__setClockForTest(() => Date.parse('2026-06-26T00:45:00Z'));
    let due = dueRecurringJobs(conn);
    ok(due.length === 1 && due[0].id === wid, '08:45 周五：每日天气 job 到期（周日 job 因 dow 不命中不触发）');
    ok(due[0].action.handler === 'weather' && due[0].action.preset === 'morning', 'action 已 parse');

    markJobFired(conn, wid, due[0]._date);
    ok(dueRecurringJobs(conn).length === 0, '落标后当天同 job 不再触发（幂等）');

    // 超补发窗：12:00 CST 已超 08:30+180min → 不触发
    db.__setClockForTest(() => Date.parse('2026-06-26T04:00:00Z')); // 12:00 CST
    ok(dueRecurringJobs(conn).length === 0, '超 180min 补发窗不触发（不在离谱钟点补发）');

    // 周日 dow 命中：钉到 2026-06-28(周日) 21:05 CST
    db.__setClockForTest(() => Date.parse('2026-06-28T13:05:00Z'));
    due = dueRecurringJobs(conn);
    ok(due.some((j) => j.id === sun), '周日 21:05：dow=0 的周日 job 触发');

    // disable 后不触发
    setEnabled(conn, sun, false);
    ok(!dueRecurringJobs(conn).some((j) => j.id === sun), 'disable 后不触发');

    // removeJob
    ok(removeJob(conn, wid) === 1 && listJobs(conn).length === 1, 'removeJob 删除生效');

    // 生命周期（expiresOn）：截止日当天(含)仍触发；过后不触发且被 sweep 自动禁用（留行可对账）
    const lim = addJob(conn, { name: '限期提醒', fireHm: '08:30', dow: null, kind: 'agentic', action: { message: '周六前搞定X' }, expiresOn: '2026-06-26' });
    db.__setClockForTest(() => Date.parse('2026-06-26T00:45:00Z')); // 截止日当天 08:45 CST
    ok(dueRecurringJobs(conn).some((j) => j.id === lim), 'expiresOn 截止日当天(含)仍触发');
    ok(sweepExpiredJobs(conn).length === 0, '截止日当天 sweep 不禁用');
    db.__setClockForTest(() => Date.parse('2026-06-27T00:45:00Z')); // 次日
    ok(!dueRecurringJobs(conn).some((j) => j.id === lim), '过截止日不再触发（due 侧兜底）');
    const swept = sweepExpiredJobs(conn);
    ok(swept.length === 1 && swept[0].id === lim, 'sweep 禁用过期任务并返回台账');
    ok(listJobs(conn).find((j) => j.id === lim).enabled === 0, '过期任务 enabled=0 留行不删');
    ok(sweepExpiredJobs(conn).length === 0, 'sweep 幂等（已禁用的不重复报）');
    // revive 带新截止日：expires_on 更新、重新启用
    ok(reviveJob(conn, lim, { fireHm: '09:00', action: { message: '新一轮' }, expiresOn: '2026-07-04' }) === 1, 'reviveJob 接受 expiresOn');
    const revived = listJobs(conn).find((j) => j.id === lim);
    ok(revived.enabled === 1 && revived.expires_on === '2026-07-04', 'revive 后新截止日生效');

    db.__setClockForTest(null);
  } catch (e) {
    fail++; console.log('  ✗ selftest 异常: ' + e.stack);
  } finally {
    try { (await import('./db.mjs')).__closeForTest(); } catch {}
    for (const ext of ['', '-wal', '-shm']) { try { rmSync(tmp + ext, { force: true }); } catch {} }
  }
  console.log(`\n[recurring.mjs selftest] PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
