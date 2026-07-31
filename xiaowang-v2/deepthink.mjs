// deepthink.mjs —— 深思模式：显式口令进/出思考态（07-01 Phase 2 原案，2026-07-24 立案 PLAN_DEEPTHINK.md）。
//
// 原则11 定位：口令是【显式语法】fast-path（与 #快记 同级的无歧义约定，精确全等匹配），
//   不是"猜意图"——绝不违反"不在 loop 前截断模糊意图"铁律。
// 状态机：bot_state.deepthink_until（epoch ms）。进入=now+窗口；每轮消息续期；
//   过期走【懒检查】（下一条消息到达时清理+提示，零新调度——PLAN §2② 选定方案）。
// 隔离：DEEPTHINK_ENABLED 走 process.env（systemd EnvironmentFile 注入）——friend.env 无此
//   flag → 朋友实例所有函数直接短路，零行为变化。⚠️ 故意不用 llm.mjs 那种"读 DIR/.env 文件"
//   的 loader：那个文件是子淇的 .env，两实例共享，从它读开关会把深思漏给 friend 实例。
//
// 回执全部确定性（不走 LLM）：变身/复原图案是协议层回执（对话层的深思回复由 loop 走思考态）。

import { pathToFileURL } from 'node:url';
import { getDb, nowMs } from './db.mjs';

// env 惰性读取（每次调用现读 process.env）：selftest 可切换，且生产由 systemd 注入无需文件 loader。
export function deepthinkEnabled() {
  return process.env.DEEPTHINK_ENABLED === '1';
}
const enterWord = () => (process.env.DEEPTHINK_ENTER || '小王变身').trim();
const exitWord = () => (process.env.DEEPTHINK_EXIT || '小王下班').trim();
const windowMin = () => Math.max(1, parseInt(process.env.DEEPTHINK_WINDOW_MIN || '30', 10) || 30);

const KEY = 'deepthink_until';

// bot_state 表由 esm.initEsmSchema 建，但深思不该依赖 ESM 初始化顺序（friend 关 ESM 也建表）——
// 自带幂等 DDL，与 esm.mjs 同一张表同一结构。
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_state (k TEXT PRIMARY KEY, v TEXT);`);
}

function readUntil(db) {
  ensureTable(db);
  const r = db.prepare('SELECT v FROM bot_state WHERE k=?').get(KEY);
  const n = r && r.v != null ? parseInt(r.v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

function writeUntil(db, untilMs) {
  ensureTable(db);
  if (untilMs == null) {
    db.prepare('DELETE FROM bot_state WHERE k=?').run(KEY);
  } else {
    db.prepare('INSERT INTO bot_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(KEY, String(untilMs));
  }
}

// ---- 回执（子淇 2026-07-24 拍板：B 能量条风）----
export const RECEIPT_ENTER = [
  '▰▰▰▰▰▰ 100%',
  '🃏 已切换 → 深思形态',
  '▼',
  '(￢‿￢ ) 想好了再答',
].join('\n');

export const RECEIPT_EXIT = [
  '▱▱▱▱▱▱ 0%',
  '深思形态 → 已复原 🃏',
  '( ˘▽˘) 秒回模式',
].join('\n');

export function receiptTimeout() {
  return ['▱▱▱▱▱▱ 0%', `${windowMin()}分钟没动静，深思自动收工 → 已复原 🃏`].join('\n');
}

// ---- 口令拦截：文本精确全等（trim 后）才算，混在句子里不触发 ----
// 返回 { handled, receipt }：handled=true 该条消息被消费（不进 agent）。
export function deepthinkIntercept(text) {
  if (!deepthinkEnabled()) return { handled: false };
  const t = String(text ?? '').trim();
  if (!t) return { handled: false };
  const db = getDb();
  const now = nowMs();
  if (t === enterWord()) {
    const active = (readUntil(db) ?? 0) > now;
    writeUntil(db, now + windowMin() * 60_000);
    return { handled: true, receipt: active ? `已经在深思形态了（退出口令：${exitWord()}）` : RECEIPT_ENTER };
  }
  if (t === exitWord()) {
    writeUntil(db, null); // 无条件清（过期残留也一并清掉，避免之后再冒超时提示）；未在深思时退出也回同款回执，幂等
    return { handled: true, receipt: RECEIPT_EXIT };
  }
  return { handled: false };
}

// ---- 每轮消息的状态推进（懒过期 + 续期），在口令拦截【之后】调 ----
// 返回 { active, expiredReceipt }：
//   active=true → 本轮走深思（并已续期到 now+窗口）；
//   expiredReceipt 非空 → 上次深思已超时，调用方把它作为确定性提示先发出去。
export function deepthinkTurnState() {
  if (!deepthinkEnabled()) return { active: false, expiredReceipt: null };
  const db = getDb();
  const now = nowMs();
  const until = readUntil(db);
  if (until == null) return { active: false, expiredReceipt: null };
  if (now > until) {
    writeUntil(db, null);
    return { active: false, expiredReceipt: receiptTimeout() };
  }
  writeUntil(db, now + windowMin() * 60_000); // 有消息即续期：窗口=最后一条消息后 N 分钟
  return { active: true, expiredReceipt: null };
}

// 只读探针（context/工具侧要看状态时用；不续期不清理）。
export function deepthinkActive() {
  if (!deepthinkEnabled()) return false;
  const until = readUntil(getDb());
  return until != null && nowMs() <= until;
}

// ---- 自检 ----
const IS_MAIN =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (process.argv.includes('--selftest') && IS_MAIN) {
  (async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'xw2dt-'));
    process.env.XW2_DB_PATH = join(tmp, 'v2.db');
    process.env.XW2_SANDBOX_DIR = join(tmp, 'ws');
    const { initDb, __setClockForTest } = await import('./db.mjs');
    initDb();

    let pass = 0, fail = 0;
    const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };
    console.log('deepthink.mjs selftest\n');

    // 未开启：一切短路（朋友实例的默认形态）
    delete process.env.DEEPTHINK_ENABLED;
    ok(deepthinkIntercept('小王变身').handled === false, '未开启：口令不拦截（friend 实例零变化）');
    ok(deepthinkTurnState().active === false && deepthinkActive() === false, '未开启：状态恒 inactive');

    process.env.DEEPTHINK_ENABLED = '1';
    process.env.DEEPTHINK_WINDOW_MIN = '30';

    // 进入
    const r1 = deepthinkIntercept('小王变身');
    ok(r1.handled === true && r1.receipt === RECEIPT_ENTER, '进入口令：拦截 + 变身回执');
    ok(deepthinkActive() === true, '进入后状态 active');
    const s1 = deepthinkTurnState();
    ok(s1.active === true && s1.expiredReceipt === null, '深思中消息：active + 续期无提示');

    // 非口令 / 混在句子里不触发
    ok(deepthinkIntercept('今天小王变身了吗').handled === false, '口令混在句子里：不触发（精确全等）');
    ok(deepthinkIntercept('随便聊聊').handled === false, '普通消息不拦截');

    // 重复进入
    const r2 = deepthinkIntercept('小王变身');
    ok(r2.handled === true && /已经在深思形态/.test(r2.receipt), '深思中再进：幂等 + 提示退出口令');

    // 退出
    const r3 = deepthinkIntercept('小王下班');
    ok(r3.handled === true && r3.receipt === RECEIPT_EXIT, '退出口令：拦截 + 复原回执');
    ok(deepthinkActive() === false, '退出后状态 inactive');
    ok(deepthinkIntercept('小王下班').handled === true, '未在深思时退出：仍拦截（幂等），不进 agent');

    // 超时懒检查
    deepthinkIntercept('小王变身');
    const realNow = Date.now();
    __setClockForTest(() => realNow + 31 * 60_000); // 拨快 31 分钟
    const s2 = deepthinkTurnState();
    ok(s2.active === false && /30分钟没动静/.test(s2.expiredReceipt || ''), '超时懒检查：清状态 + 超时回执');
    ok(deepthinkTurnState().expiredReceipt === null, '超时提示只发一次（状态已清）');
    __setClockForTest(null);

    // 续期语义：临过期前来消息 → 窗口重置
    deepthinkIntercept('小王变身');
    __setClockForTest(() => realNow + 29 * 60_000);
    ok(deepthinkTurnState().active === true, '29分钟时来消息：仍 active（并续期）');
    __setClockForTest(() => realNow + 58 * 60_000); // 距上次续期 29 分钟 < 30
    ok(deepthinkTurnState().active === true, '续期生效：窗口从最后一条消息起算');
    __setClockForTest(null);
    deepthinkIntercept('小王下班'); // 清场

    console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
  })();
}
