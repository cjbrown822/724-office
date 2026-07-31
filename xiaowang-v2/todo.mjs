// =====================================================================
// todo.mjs —— 待办面板的数据层（表 + 状态机 + 跨天滚动 + 提醒打通）。
//
// 为什么独立成模块：待办是一个有自己生命周期的实体（open→done/dropped、按天归属、
// 自动滚动），不是 facts/notes/schedule 任何一个的变体——此前它散落三处正是"乱"的根源。
// 本模块只做数据与规则，不做 HTTP（adapter 接）、不做工具注册（tools 接）、不做渲染（页面接）。
//
// 三个铁律：
//   ① 一张表是唯一事实源：页面点勾、微信里让小王记、agent 自己加，全落同一 todos 表。
//   ② 数据变更全部确定性：滚动/完成/取消提醒是纯代码，LLM 只负责把自然语言路由到这里。
//   ③ todo_events 全量流水：谁(actor)在何时做了什么，跨天整合可回放，出怪状态可对账。
//
// 日期口径：scheduled_day/origin_day 均为东八区 'YYYY-MM-DD'（与 recurring 同纪律）；
// 时间戳口径与全库一致 = epoch ms。
// =====================================================================

import { pathToFileURL } from 'node:url';
import { getDb, tx, nowMs } from './db.mjs';
import { createTask, scheduleTimer, markTaskDone } from './durable.mjs';
import { initRecurringSchema, listJobs, setEnabled } from './recurring.mjs';

// ---------------------------------------------------------------------
// 建表（幂等；只有配置了 TODO_SECRET 的实例会被 main/adapter/tools 调到——
// 未开通的实例（如朋友）连表都不建，隔离靠结构不靠约定）。
// ---------------------------------------------------------------------
export function initTodoSchema(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT    NOT NULL,
      detail           TEXT    NOT NULL DEFAULT '',
      links            TEXT    NOT NULL DEFAULT '[]',
      tag              TEXT,
      status           TEXT    NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open','parked','done','dropped')),
      scheduled_day    TEXT    NOT NULL,
      origin_day       TEXT    NOT NULL,
      rollover_count   INTEGER NOT NULL DEFAULT 0,
      done_at          INTEGER,
      source           TEXT    NOT NULL DEFAULT 'web',
      reminder_task_id INTEGER,
      sort_key         REAL    NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_day ON todos (status, scheduled_day, sort_key);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      ts      INTEGER NOT NULL,
      actor   TEXT    NOT NULL,
      action  TEXT    NOT NULL,
      payload TEXT    NOT NULL DEFAULT '{}'
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_events_todo ON todo_events (todo_id, ts);`);
  return db;
}

// ---------------------------------------------------------------------
// 日期助手（东八区）。
// ---------------------------------------------------------------------
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const cstDayOf = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
export const cstToday = () => cstDayOf(nowMs());
const addDays = (day, n) => cstDayOf(new Date(`${day}T00:00:00+08:00`).getTime() + n * 86400e3 + 1);
export const fmtCst = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

// 'today/今天' | 'tomorrow/明天' | 'YYYY-MM-DD' → 'YYYY-MM-DD'；过去的日期拒绝（待办排到昨天无意义，
// 想补记历史该用 done 而不是 add）。
export function parseDay(input) {
  const s = String(input ?? '').trim().toLowerCase();
  const today = cstToday();
  if (!s || s === 'today' || s === '今天') return today;
  if (s === 'tomorrow' || s === '明天') return addDays(today, 1);
  if (!DAY_RE.test(s)) throw new Error("day 需 'YYYY-MM-DD' 或 today/tomorrow");
  if (s < today) throw new Error(`day=${s} 已是过去（今天 ${today}）——待办只能排今天或以后`);
  return s;
}

// 'HH:MM'（今天，已过算明天）| 'YYYY-MM-DD HH:MM' → epoch ms（与 tools.parseAtCst 同语义；
// 待办提醒必须在未来，错的表达当场回灌）。
export function parseRemindAt(s) {
  const str = String(s ?? '').trim();
  let m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (m) {
    const t = new Date(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00+08:00`).getTime();
    if (t <= nowMs()) throw new Error(`提醒时刻 ${fmtCst(t)} 已过去`);
    return t;
  }
  m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    let t = new Date(`${cstToday()}T${m[1].padStart(2, '0')}:${m[2]}:00+08:00`).getTime();
    if (t <= nowMs()) t += 86400e3;
    return t;
  }
  throw new Error("remind_at 需 'HH:MM'（今天，已过算明天）或 'YYYY-MM-DD HH:MM'，东八区");
}

// ---------------------------------------------------------------------
// 流水（audit）：所有写路径必经。tx 内调用（与业务写同事务，绝不出现"改了没记账"）。
// ---------------------------------------------------------------------
function logEvent(d, todoId, actor, action, payload = {}) {
  d.prepare(`INSERT INTO todo_events (todo_id, ts, actor, action, payload) VALUES (?,?,?,?,?)`)
    .run(todoId, nowMs(), String(actor || 'unknown'), action, JSON.stringify(payload));
}

const rowToTodo = (r) => r && ({
  ...r,
  links: (() => { try { return JSON.parse(r.links) || []; } catch { return []; } })(),
});

// 备注正文里的 URL 自动抽成链接（Memos 的"结构后置"：先写下来，结构是派生索引，
// 不强迫在"链接栏"里填）。返回去重合并后的数组。
const URL_RE = /https?:\/\/[^\s<>"'）)】\]，。；;]+/g;
function mergeUrlsFromText(existing, text) {
  const found = String(text ?? '').match(URL_RE) || [];
  const merged = [...existing];
  for (const u of found) if (!merged.includes(u)) merged.push(u);
  return merged;
}

export function getTodo(db, id) {
  return rowToTodo(db.prepare(`SELECT * FROM todos WHERE id=?`).get(id));
}

// ---------------------------------------------------------------------
// 新建。sort_key = 当日组内 max+1（新条目排到底部；页面拖拽用 fractional 改）。
// ---------------------------------------------------------------------
export function addTodo(db, { title, detail = '', links = [], tag = null, day, source = 'web', actor = 'web' }) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('title 不能为空');
  if (t.length > 500) throw new Error('title 过长（>500字）');
  const scheduledDay = parseDay(day);
  let linksArr = (Array.isArray(links) ? links : [links]).map((u) => String(u).trim()).filter(Boolean);
  linksArr = mergeUrlsFromText(linksArr, detail); // 备注里贴的 URL 自动变链接 chip
  const now = nowMs();
  return tx((d) => {
    const maxKey = d.prepare(`SELECT COALESCE(MAX(sort_key),0) k FROM todos WHERE scheduled_day=? AND status='open'`).get(scheduledDay).k;
    const res = d.prepare(
      `INSERT INTO todos (title, detail, links, tag, status, scheduled_day, origin_day, source, sort_key, created_at, updated_at)
       VALUES (?,?,?,?,'open',?,?,?,?,?,?)`
    ).run(t, String(detail ?? ''), JSON.stringify(linksArr), tag ? String(tag).trim() : null,
      scheduledDay, scheduledDay, String(source), maxKey + 1, now, now);
    const id = Number(res.lastInsertRowid);
    logEvent(d, id, actor, 'add', { title: t, day: scheduledDay });
    return { id, day: scheduledDay };
  });
}

// ---------------------------------------------------------------------
// 状态迁移。每个动作一个函数（状态守卫在函数内，错的迁移当场报可操作错误）。
// ---------------------------------------------------------------------
function mustGet(d, id) {
  const row = d.prepare(`SELECT * FROM todos WHERE id=?`).get(id);
  if (!row) throw new Error(`没有 id=${id} 的待办`);
  return row;
}

// 完成。同事务里顺手取消挂着的提醒（打通点①：划掉即闭环，不会晚上还被提醒已完成的事）。
export function completeTodo(db, id, actor = 'web') {
  const out = tx((d) => {
    const row = mustGet(d, id);
    if (row.status === 'done') return { id, already: true };
    d.prepare(`UPDATE todos SET status='done', done_at=?, updated_at=? WHERE id=?`).run(nowMs(), nowMs(), id);
    logEvent(d, id, actor, 'done', {});
    return { id, title: row.title, reminderTaskId: row.reminder_task_id };
  });
  if (!out.already && out.reminderTaskId) cancelReminderTask(db, id, out.reminderTaskId, actor);
  return out;
}

// 搁置（泄压阀，学 Things 的 Someday）：不想再让它天天滚、但也不想删——退出每日时间线，
// 挂着的提醒一并取消（搁置=现在不做）。调研实证 TeuxDeux 缺这一块导致清单越滚越长。
export function parkTodo(db, id, actor = 'web') {
  const out = tx((d) => {
    const row = mustGet(d, id);
    if (row.status !== 'open') throw new Error(`待办#${id} 状态是 ${row.status}，只有进行中的能搁置`);
    d.prepare(`UPDATE todos SET status='parked', updated_at=? WHERE id=?`).run(nowMs(), id);
    logEvent(d, id, actor, 'park', { rollover_count: row.rollover_count });
    return { id, title: row.title, reminderTaskId: row.reminder_task_id };
  });
  if (out.reminderTaskId) cancelReminderTask(db, id, out.reminderTaskId, actor);
  return out;
}

// 取回搁置：回到今天的清单，挂账计数清零（重新开始，不背旧账）。
export function unparkTodo(db, id, actor = 'web') {
  return tx((d) => {
    const row = mustGet(d, id);
    if (row.status !== 'parked') throw new Error(`待办#${id} 状态是 ${row.status}，不在搁置区`);
    const today = cstToday();
    const maxKey = d.prepare(`SELECT COALESCE(MAX(sort_key),0) k FROM todos WHERE scheduled_day=? AND status='open'`).get(today).k;
    d.prepare(`UPDATE todos SET status='open', scheduled_day=?, rollover_count=0, sort_key=?, updated_at=? WHERE id=?`)
      .run(today, maxKey + 1, nowMs(), id);
    logEvent(d, id, actor, 'unpark', { day: today });
    return { id, day: today };
  });
}

// 放弃（不做了但留痕，与"完成"分开——历史里能看出哪些是砍掉的）。同样取消提醒。
export function dropTodo(db, id, actor = 'web') {
  const out = tx((d) => {
    const row = mustGet(d, id);
    if (row.status !== 'open' && row.status !== 'parked') throw new Error(`待办#${id} 状态是 ${row.status}，只有未结束的能放弃`);
    d.prepare(`UPDATE todos SET status='dropped', done_at=?, updated_at=? WHERE id=?`).run(nowMs(), nowMs(), id);
    logEvent(d, id, actor, 'drop', {});
    return { id, title: row.title, reminderTaskId: row.reminder_task_id };
  });
  if (out.reminderTaskId) cancelReminderTask(db, id, out.reminderTaskId, actor);
  return out;
}

// 重开（勾错了/又要做了）：回 open、归到今天（回过去的日期没有意义）。
export function reopenTodo(db, id, actor = 'web') {
  return tx((d) => {
    const row = mustGet(d, id);
    if (row.status === 'open') return { id, already: true };
    const today = cstToday();
    const day = row.scheduled_day >= today ? row.scheduled_day : today;
    d.prepare(`UPDATE todos SET status='open', done_at=NULL, scheduled_day=?, updated_at=? WHERE id=?`).run(day, nowMs(), id);
    logEvent(d, id, actor, 'reopen', { day });
    return { id, day };
  });
}

// 推迟到某天（人主动改期 ≠ 自动滚动：rollover_count 清零——挂账徽标只统计"被动挂了几天"）。
export function deferTodo(db, id, day, actor = 'web') {
  const target = parseDay(day);
  return tx((d) => {
    const row = mustGet(d, id);
    if (row.status !== 'open') throw new Error(`待办#${id} 状态是 ${row.status}，已结束的不能改期`);
    d.prepare(`UPDATE todos SET scheduled_day=?, rollover_count=0, updated_at=? WHERE id=?`).run(target, nowMs(), id);
    logEvent(d, id, actor, 'defer', { from: row.scheduled_day, to: target });
    return { id, day: target };
  });
}

// 编辑正文字段（title/detail/tag，给什么改什么）。detail 是备注正文：页面 inline 编辑整段覆盖；
// 微信里"给X加一句备注"走 appendDetail 追加，不覆盖已有内容。
export function editTodo(db, id, { title, detail, tag }, actor = 'web') {
  return tx((d) => {
    const row = mustGet(d, id);
    const t = title != null ? String(title).trim() : row.title;
    if (!t) throw new Error('title 不能为空');
    const det = detail != null ? String(detail) : row.detail;
    const tg = tag !== undefined ? (tag ? String(tag).trim() : null) : row.tag;
    d.prepare(`UPDATE todos SET title=?, detail=?, tag=?, updated_at=? WHERE id=?`).run(t, det, tg, nowMs(), id);
    logEvent(d, id, actor, 'edit', { title: title != null, detail: detail != null, tag: tag !== undefined });
    return { id };
  });
}

export function appendDetail(db, id, text, actor = 'agent') {
  const line = String(text ?? '').trim();
  if (!line) throw new Error('备注内容不能为空');
  return tx((d) => {
    const row = mustGet(d, id);
    const detail = row.detail ? `${row.detail}\n${line}` : line;
    let links = [];
    try { links = JSON.parse(row.links) || []; } catch { /* 坏 JSON 重建 */ }
    links = mergeUrlsFromText(links, line);
    d.prepare(`UPDATE todos SET detail=?, links=?, updated_at=? WHERE id=?`).run(detail, JSON.stringify(links), nowMs(), id);
    logEvent(d, id, actor, 'note', { text: line });
    return { id };
  });
}

export function addLink(db, id, url, actor = 'web') {
  const u = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('链接需以 http(s):// 开头');
  return tx((d) => {
    const row = mustGet(d, id);
    let links = [];
    try { links = JSON.parse(row.links) || []; } catch { /* 坏 JSON 重建 */ }
    if (!links.includes(u)) links.push(u);
    d.prepare(`UPDATE todos SET links=?, updated_at=? WHERE id=?`).run(JSON.stringify(links), nowMs(), id);
    logEvent(d, id, actor, 'link', { url: u });
    return { id, links };
  });
}

// 组内排序：拖到 afterId 之后（afterId=null → 置顶）。fractional key，绝不重写全组。
export function reorderTodo(db, id, afterId, actor = 'web') {
  return tx((d) => {
    const row = mustGet(d, id);
    const peers = d.prepare(
      `SELECT id, sort_key FROM todos WHERE scheduled_day=? AND status='open' AND id != ? ORDER BY sort_key ASC`
    ).all(row.scheduled_day, id);
    let newKey;
    if (afterId == null) {
      newKey = peers.length ? peers[0].sort_key - 1 : 1;
    } else {
      const idx = peers.findIndex((p) => p.id === Number(afterId));
      if (idx === -1) throw new Error(`同组里没有 id=${afterId}（可能已完成或在别的日子）`);
      const next = peers[idx + 1];
      newKey = next ? (peers[idx].sort_key + next.sort_key) / 2 : peers[idx].sort_key + 1;
    }
    d.prepare(`UPDATE todos SET sort_key=?, updated_at=? WHERE id=?`).run(newKey, nowMs(), id);
    logEvent(d, id, actor, 'reorder', { after: afterId ?? null });
    return { id };
  });
}

// ---------------------------------------------------------------------
// 跨天滚动（核心机制）：所有 open 且归属日已过的 → 挪到今天，rollover_count+1。
// 纯代码零 LLM；幂等（当天第二次调用无事发生）；main 每拍调 + API 读前懒调双保险，
// 服务器半夜重启也不会漏掉滚动。
// ---------------------------------------------------------------------
export function rolloverSweep(db = getDb()) {
  const today = cstToday();
  const stale = db.prepare(
    `SELECT id, title, scheduled_day, rollover_count FROM todos WHERE status='open' AND scheduled_day < ?`
  ).all(today);
  if (!stale.length) return [];
  tx((d) => {
    for (const r of stale) {
      d.prepare(`UPDATE todos SET scheduled_day=?, rollover_count=rollover_count+1, updated_at=? WHERE id=?`)
        .run(today, nowMs(), r.id);
      logEvent(d, r.id, 'sweep', 'rollover', { from: r.scheduled_day, to: today });
    }
  });
  return stale;
}

// ---------------------------------------------------------------------
// 提醒打通（拍板：必须打通）。
// 结构：待办自己不长闹钟——提醒复用 durable 的 agentic task + timer（与 schedule_task 同机器），
// 只是 payload 带 todo_id、todos 行记 reminder_task_id，两边互相看得见：
//   完成/放弃待办 → 挂着的提醒自动取消（上面 complete/drop 已接）；
//   提醒触发时待办还 open → agent 收到的任务原文带标题+面板链接，正常提醒。
// ---------------------------------------------------------------------
export function setTodoReminder(db, id, remindAt, { sessionId = null, panelUrl = '', actor = 'web' } = {}) {
  const fireAt = typeof remindAt === 'number' ? remindAt : parseRemindAt(remindAt);
  if (fireAt <= nowMs()) throw new Error(`提醒时刻 ${fmtCst(fireAt)} 已过去`);
  const row = getTodo(db, id);
  if (!row) throw new Error(`没有 id=${id} 的待办`);
  if (row.status !== 'open') throw new Error(`待办#${id} 状态是 ${row.status}（${row.status === 'parked' ? '搁置中，先取回再设提醒' : '已结束，不用提醒了'}）`);
  // 旧提醒还挂着 → 先取消（一条待办同时只有一个提醒，改时间=换新的）。
  if (row.reminder_task_id) cancelReminderTask(db, id, row.reminder_task_id, actor);
  const note = `【待办提醒】「${row.title}」(待办#${id}) 到点了还没划掉，提醒主人。${panelUrl ? `待办面板：${panelUrl}` : ''}`;
  const payload = { note, target: sessionId, todo_id: id };
  const { taskId } = createTask({ kind: 'agentic', payload, nextRunAt: fireAt });
  scheduleTimer({ fireAt, taskId, payload, catchupPolicy: 'once' });
  tx((d) => {
    d.prepare(`UPDATE todos SET reminder_task_id=?, updated_at=? WHERE id=?`).run(taskId, nowMs(), id);
    logEvent(d, id, actor, 'remind_set', { task_id: taskId, fire_at: fireAt, fire_at_cst: fmtCst(fireAt) });
  });
  return { id, task_id: taskId, fire_at: fireAt, fire_at_cst: `${fmtCst(fireAt)} CST` };
}

// 页面/工具主动取消某条待办的提醒（待办本身不动）。
export function cancelTodoReminder(db, id, actor = 'web') {
  const row = getTodo(db, id);
  if (!row) throw new Error(`没有 id=${id} 的待办`);
  if (!row.reminder_task_id) return { id, cancelled: false };
  return { id, cancelled: cancelReminderTask(db, id, row.reminder_task_id, actor) };
}

// 提醒任务还没触发就取消（pending → done(cancelled)，与 cancel_schedule 同语义：
// runDueTasks 不再跑它，绑定 timer 到点只空转记录）。running/done 的不动（正在响/已响过，拦不住了）。
function cancelReminderTask(db, todoId, taskId, actor) {
  const t = db.prepare(`SELECT status FROM tasks WHERE id=?`).get(taskId);
  if (!t || t.status !== 'pending') return false;
  markTaskDone(taskId, { cancelled: true, reason: `待办#${todoId} 已结束，提醒自动取消` });
  tx((d) => logEvent(d, todoId, actor, 'remind_cancelled', { task_id: taskId }));
  return true;
}

// ---------------------------------------------------------------------
// 状态查询（页面 API 与 todo_list 工具共用同一份，两个视图永远一致）。
//   days：open 按归属日分组（今天在前，未来升序）。
//   history：已结束的按【结束那天】分组（近 N 天，降序）——"哪天做完了什么"的正确语义，
//            与归属日无关（提前做完未来的事，记在做完那天）。
// ---------------------------------------------------------------------
export function getState(db = getDb(), { historyDays = 14 } = {}) {
  const today = cstToday();
  const open = db.prepare(
    `SELECT * FROM todos WHERE status='open' ORDER BY scheduled_day ASC, sort_key ASC`
  ).all().map(rowToTodo);

  // 提醒状态一次查齐（避免每条一查）：pending 的才对用户有意义。
  const remindIds = open.filter((t) => t.reminder_task_id).map((t) => t.reminder_task_id);
  const pendingReminders = new Map();
  if (remindIds.length) {
    const qs = remindIds.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, status, next_run_at FROM tasks WHERE id IN (${qs})`).all(...remindIds)) {
      if (r.status === 'pending') pendingReminders.set(r.id, r.next_run_at);
    }
  }
  const withReminder = (t) => {
    const fireAt = t.reminder_task_id ? pendingReminders.get(t.reminder_task_id) : null;
    return { ...t, reminder: fireAt ? { fire_at: fireAt, fire_at_cst: fmtCst(fireAt) } : null };
  };

  const dayMap = new Map();
  for (const t of open) {
    // 归属日在过去 = 还没被 sweep 扫到（调用方读前应先 rolloverSweep；这里防御性归到今天）
    const day = t.scheduled_day < today ? today : t.scheduled_day;
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push(withReminder(t));
  }
  if (!dayMap.has(today)) dayMap.set(today, []); // 今天永远有区块（空也显示，页面有落点）
  const days = [...dayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, todos]) => ({ day, todos }));

  const sinceMs = new Date(`${addDays(today, -Math.max(1, historyDays))}T00:00:00+08:00`).getTime();
  const closed = db.prepare(
    `SELECT * FROM todos WHERE status IN ('done','dropped') AND done_at >= ? ORDER BY done_at DESC`
  ).all(sinceMs).map(rowToTodo);
  const histMap = new Map();
  for (const t of closed) {
    const day = cstDayOf(t.done_at);
    if (!histMap.has(day)) histMap.set(day, []);
    histMap.get(day).push(t);
  }
  const history = [...histMap.entries()].sort((a, b) => (a[0] > b[0] ? -1 : 1))
    .map(([day, todos]) => ({ day, todos }));

  // 搁置区：退出每日时间线的条目，最近动过的在前。
  const parked = db.prepare(
    `SELECT * FROM todos WHERE status='parked' ORDER BY updated_at DESC`
  ).all().map(rowToTodo);

  // 定时/周期区（子淇立的原则："系统里不该有面板看不到的'要发生的事'"，消灭孤儿提醒）：
  //   reminders = 独立的一次性提醒（schedule_task 建的，payload 无 todo_id——待办自己的提醒已显示在待办条目上，不重复）；
  //   recurring = 周期任务（天气/打卡/每天X）。都只读列出 + 可在面板取消，高容错的（天气）列着不催、低容错的（定时提醒）显著标。
  const schedules = { reminders: [], recurring: [] };
  try {
    schedules.reminders = db.prepare(
      `SELECT id, next_run_at, payload FROM tasks WHERE status='pending' AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 50`
    ).all().map((t) => {
      let note = '', todoId = null;
      try { const p = JSON.parse(t.payload) || {}; note = p.note || ''; todoId = p.todo_id || null; } catch { /* payload 坏不拖垮列举 */ }
      return { id: t.id, fire_at: t.next_run_at, fire_at_cst: fmtCst(t.next_run_at), note, todo_id: todoId };
    }).filter((r) => !r.todo_id); // 待办型提醒挂在待办上显示，这里只列独立提醒
  } catch (e) { /* 无 tasks 表等：空列表，不拖垮面板 */ }
  try {
    initRecurringSchema(db);
    schedules.recurring = listJobs(db).filter((j) => j.enabled).map((j) => ({
      id: j.id, name: j.name,
      schedule: `${j.dow == null ? '每天' : '每周' + '日一二三四五六'[j.dow]} ${j.fire_hm}`,
      ...(j.expires_on ? { until: j.expires_on } : {}),
    }));
  } catch (e) { /* 无 recurring 表：空列表 */ }

  const tags = db.prepare(
    `SELECT DISTINCT tag FROM todos WHERE tag IS NOT NULL AND (status IN ('open','parked') OR done_at >= ?) ORDER BY tag`
  ).all(sinceMs).map((r) => r.tag);

  return {
    today,
    days,
    parked,
    schedules,
    history,
    tags,
    stats: {
      open_total: open.length,
      today_open: (dayMap.get(today) || []).length,
      today_done: (histMap.get(today) || []).filter((t) => t.status === 'done').length,
    },
  };
}

// 面板取消一个定时（web actor）：'reminder'=一次性提醒(task) / 'recurring'=周期任务。
// 复用与 cancel_schedule 工具同一套语义：一次性→markTaskDone(cancelled)，runDueTasks 不再跑；
// 周期→setEnabled(0) 禁用留行（可对账/可复活）。取消定时不碰任何待办。
export function cancelScheduleFromPanel(db, kind, id) {
  const nid = Number.parseInt(id, 10);
  if (!Number.isInteger(nid) || nid < 1) throw new Error('id 无效');
  if (kind === 'reminder') {
    const t = db.prepare(`SELECT status FROM tasks WHERE id=?`).get(nid);
    if (!t) throw new Error(`没有 id=${nid} 的提醒`);
    if (t.status !== 'pending') throw new Error(`这条提醒状态是 ${t.status}，不是待触发，取消不了`);
    markTaskDone(nid, { cancelled: true, reason: '面板取消' });
    return { cancelled: 'reminder', id: nid };
  }
  if (kind === 'recurring') {
    initRecurringSchema(db);
    const job = listJobs(db).find((j) => j.id === nid);
    if (!job) throw new Error(`没有 id=${nid} 的周期任务`);
    setEnabled(db, nid, 0);
    return { cancelled: 'recurring', id: nid, name: job.name };
  }
  throw new Error("kind 需 'reminder' 或 'recurring'");
}

// 今日待办轻量摘要（给 context 每轮注入用；取代 #17 死锚点，自动最新）。
// 只返回今天 open 的标题 + 挂账天数，不含备注/链接/历史——那些要详情靠 todo_list 拉（原则8：常驻只放指针）。
export function todaySummary(db = getDb()) {
  const today = cstToday();
  const rows = db.prepare(
    `SELECT title, rollover_count FROM todos WHERE status='open' AND scheduled_day <= ? ORDER BY sort_key ASC LIMIT 30`
  ).all(today);
  return rows.map((r) => ({ title: r.title, days_pending: r.rollover_count >= 1 ? r.rollover_count + 1 : 0 }));
}

// =====================================================================
// --selftest：离线（LLM 不参与——本模块本来就不碰 LLM）。
// 运行：node todo.mjs --selftest
// =====================================================================
if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv.includes('--selftest')) {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { rmSync } = await import('node:fs');
  const dbmod = await import('./db.mjs');

  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };
  const tmp = join(tmpdir(), `xw2-todo-selftest-${process.pid}-${Date.now()}.db`);
  process.env.XW2_DB_PATH = tmp;

  try {
    const db = dbmod.initDb(tmp);
    initTodoSchema(db);
    initTodoSchema(db);
    ok(true, 'initTodoSchema 幂等');

    // 钉死时钟：2026-07-23 10:00 CST
    const T0 = Date.parse('2026-07-23T02:00:00Z');
    dbmod.__setClockForTest(() => T0);
    ok(cstToday() === '2026-07-23', 'cstToday 东八区口径');
    ok(parseDay('明天') === '2026-07-24', "parseDay('明天')");
    let threw = false; try { parseDay('2026-07-01'); } catch { threw = true; }
    ok(threw, 'parseDay 拒绝过去日期');

    // 新建 + 排序键递增
    const a = addTodo(db, { title: '给某客户回邮件', tag: '某客户', source: 'wechat', actor: 'agent' });
    const b = addTodo(db, { title: '看 HRV 论文', detail: '先读方法节', links: ['https://example.com/paper'] });
    const c = addTodo(db, { title: '明天的事', day: '明天' });
    ok(a.id > 0 && a.day === '2026-07-23', 'addTodo 默认排今天');
    ok(c.day === '2026-07-24', 'addTodo 可排明天');
    const rowB = getTodo(db, b.id);
    ok(rowB.links.length === 1 && rowB.detail === '先读方法节', 'links/detail 落库并解析');
    ok(db.prepare(`SELECT COUNT(*) c FROM todo_events WHERE action='add'`).get().c === 3, '每次 add 记流水');

    // 提醒打通：设提醒 → 完成 → 提醒任务自动取消
    const rem = setTodoReminder(db, a.id, '2026-07-23 18:00', { sessionId: 'wecom:OWNER', panelUrl: 'https://x/todo/s', actor: 'agent' });
    ok(rem.task_id > 0 && /2026-07-23 18:00/.test(rem.fire_at_cst), 'setTodoReminder 建 durable 任务');
    const taskRow0 = db.prepare(`SELECT status, payload FROM tasks WHERE id=?`).get(rem.task_id);
    ok(taskRow0.status === 'pending' && JSON.parse(taskRow0.payload).todo_id === a.id, '提醒任务 payload 带 todo_id');
    completeTodo(db, a.id, 'web');
    const taskRow1 = db.prepare(`SELECT status, result FROM tasks WHERE id=?`).get(rem.task_id);
    ok(taskRow1.status === 'done' && JSON.parse(taskRow1.result).cancelled === true, '完成待办 → 挂着的提醒自动取消');
    ok(db.prepare(`SELECT COUNT(*) c FROM todo_events WHERE todo_id=? AND action='remind_cancelled'`).get(a.id).c === 1, '取消提醒记流水');

    // 状态守卫
    threw = false; try { dropTodo(db, a.id); } catch { threw = true; }
    ok(threw, '已完成的不能放弃（状态守卫）');

    // 跨天滚动：时钟拨到次日 → b 滚到今天，count+1；done 的 a 不动；c(今天到期)也在册
    dbmod.__setClockForTest(() => T0 + 86400e3);
    const moved = rolloverSweep(db);
    ok(moved.length === 1 && moved[0].id === b.id, 'rolloverSweep 只滚 open 且过期的');
    const rowB2 = getTodo(db, b.id);
    ok(rowB2.scheduled_day === '2026-07-24' && rowB2.rollover_count === 1 && rowB2.origin_day === '2026-07-23', '滚动后归今天、计数+1、origin_day 不变');
    ok(rolloverSweep(db).length === 0, '同日二次 sweep 幂等');

    // defer 清零挂账计数
    deferTodo(db, b.id, '2026-07-26', 'web');
    ok(getTodo(db, b.id).rollover_count === 0 && getTodo(db, b.id).scheduled_day === '2026-07-26', 'defer 改期并清零 rollover_count');

    // reopen：拨回 open、归到今天
    reopenTodo(db, a.id, 'web');
    const rowA = getTodo(db, a.id);
    ok(rowA.status === 'open' && rowA.scheduled_day === '2026-07-24', 'reopen 回 open 且归今天');

    // 备注里的 URL 自动抽成链接（结构后置）
    const u1 = addTodo(db, { title: '带链接的', detail: '参考 https://arxiv.org/abs/1706.03762 这篇' });
    ok(getTodo(db, u1.id).links.includes('https://arxiv.org/abs/1706.03762'), 'addTodo 从备注抽 URL 进 links');
    appendDetail(db, u1.id, '另见 https://example.com/x，回头看', 'agent');
    ok(getTodo(db, u1.id).links.length === 2 && getTodo(db, u1.id).links[1] === 'https://example.com/x', 'appendDetail 追加时也抽 URL（中文标点截断正确）');

    // 备注追加 / 加链接 / 编辑
    appendDetail(db, a.id, '医院那边说周五前', 'agent');
    appendDetail(db, a.id, '模板在邮箱草稿', 'agent');
    ok(getTodo(db, a.id).detail === '医院那边说周五前\n模板在邮箱草稿', 'appendDetail 逐行追加');
    addLink(db, a.id, 'https://mail.example.com/draft');
    addLink(db, a.id, 'https://mail.example.com/draft');
    ok(getTodo(db, a.id).links.length === 1, 'addLink 去重');
    editTodo(db, a.id, { tag: '某客户', title: '给某客户回邮件(改)' }, 'web');
    ok(getTodo(db, a.id).title === '给某客户回邮件(改)', 'editTodo 局部更新');

    // 排序：新建两条 + 置顶
    const d1 = addTodo(db, { title: '排序1' });
    const d2 = addTodo(db, { title: '排序2' });
    reorderTodo(db, d2.id, null, 'web');
    const ordered = db.prepare(`SELECT id FROM todos WHERE scheduled_day=? AND status='open' ORDER BY sort_key ASC`).all(cstToday()).map((r) => r.id);
    ok(ordered[0] === d2.id, 'reorder afterId=null 置顶');
    reorderTodo(db, d2.id, d1.id, 'web');
    const ordered2 = db.prepare(`SELECT id FROM todos WHERE scheduled_day=? AND status='open' ORDER BY sort_key ASC`).all(cstToday()).map((r) => r.id);
    ok(ordered2.indexOf(d2.id) === ordered2.indexOf(d1.id) + 1, 'reorder 到指定条目之后');

    // getState：分组/历史/统计
    completeTodo(db, d1.id, 'web');
    const st = getState(db, { historyDays: 7 });
    ok(st.today === '2026-07-24', 'getState.today');
    ok(st.days[0].day === '2026-07-24' && st.days.some((g) => g.day === '2026-07-26'), 'days 今天在前+未来分组');
    ok(st.history[0].day === '2026-07-24' && st.history[0].todos.some((t) => t.id === d1.id), 'history 按结束日分组（今天做完记今天）');
    ok(st.tags.includes('某客户'), 'tags 汇总');
    ok(st.stats.today_done === 1, 'stats.today_done');

    // dropped 进历史且与 done 可区分
    const e1 = addTodo(db, { title: '要砍的' });
    dropTodo(db, e1.id, 'agent');
    const st2 = getState(db);
    ok(st2.history[0].todos.some((t) => t.id === e1.id && t.status === 'dropped'), 'dropped 待办进历史（可区分）');

    // 今日待办摘要（context 注入用）：只今天 open，挂账>=2 才标天数
    const summ = todaySummary(db);
    ok(Array.isArray(summ) && summ.some((t) => /给某客户回邮件/.test(t.title)), 'todaySummary 返回今日 open 待办标题');
    ok(summ.every((t) => typeof t.days_pending === 'number'), 'todaySummary 每条带 days_pending');

    // 定时/周期区 + 面板取消：建一条独立提醒(schedule_task 风格：payload 无 todo_id) + 一条周期
    const { createTask: mkTask } = await import('./durable.mjs');
    const rec = await import('./recurring.mjs');
    rec.initRecurringSchema(db);
    const indieTask = mkTask({ kind: 'agentic', payload: { note: '独立提醒(非待办)' }, nextRunAt: nowMs() + 3600e3 });
    const jobId = rec.addJob(db, { name: '喝水', fireHm: '10:00', dow: null, kind: 'agentic', action: { message: '喝水' } });
    const st3 = getState(db);
    ok(st3.schedules.reminders.some((r) => r.id === indieTask.taskId && !r.todo_id), 'getState.schedules.reminders 列出独立提醒（无 todo_id）');
    ok(!st3.schedules.reminders.some((r) => r.todo_id), 'schedules.reminders 不含待办型提醒（那些挂在待办上显示）');
    ok(st3.schedules.recurring.some((j) => j.id === jobId && j.name === '喝水'), 'getState.schedules.recurring 列出周期任务');
    cancelScheduleFromPanel(db, 'recurring', jobId);
    ok(!getState(db).schedules.recurring.some((j) => j.id === jobId), '面板取消周期任务（enabled=0 不再列出）');
    cancelScheduleFromPanel(db, 'reminder', indieTask.taskId);
    ok(db.prepare('SELECT status FROM tasks WHERE id=?').get(indieTask.taskId).status === 'done', '面板取消一次性提醒（task done/cancelled）');

    // looksLikeTodoList 特征检测（供 pin_fact 护栏；纯函数）——待办清单命中、普通事实放行
    // 注：该函数在 tools.mjs，这里只在 tools selftest 覆盖，todo 侧不重复。

    // 搁置/取回（泄压阀）：parked 退出时间线、不滚动；unpark 回今天清零挂账
    const p1 = addTodo(db, { title: '搁置候选' });
    parkTodo(db, p1.id, 'web');
    ok(getTodo(db, p1.id).status === 'parked', 'parkTodo → parked');
    ok(getState(db).parked.some((t) => t.id === p1.id), 'getState.parked 列出搁置区');
    dbmod.__setClockForTest(() => T0 + 2 * 86400e3); // 再过一天
    ok(!rolloverSweep(db).some((r) => r.id === p1.id), 'parked 不参与跨天滚动');
    unparkTodo(db, p1.id, 'web');
    const p1row = getTodo(db, p1.id);
    ok(p1row.status === 'open' && p1row.scheduled_day === cstToday() && p1row.rollover_count === 0, 'unpark 回今天且清零挂账');
    completeTodo(db, p1.id, 'web');
    ok(getTodo(db, p1.id).status === 'done', 'parked→open→done 全链可走');

    dbmod.__setClockForTest(null);
  } catch (e) {
    fail++; console.log('  ✗ selftest 异常: ' + e.stack);
  } finally {
    try { (await import('./db.mjs')).__closeForTest(); } catch { /* ignore */ }
    for (const ext of ['', '-wal', '-shm']) { try { rmSync(tmp + ext, { force: true }); } catch { /* ignore */ } }
  }
  console.log(`\n[todo.mjs selftest] PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
