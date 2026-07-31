// =====================================================================
// adapter.mjs —— D 渠道适配与进程编排（adapter 层）
//
// 职责（契约 §模块接口契约 adapter.mjs）：
//   - relayOutbox()  : worker tick 调用，扫 outbox pending → 真发 → 标 sent
//   - sendWecom()    : 纯 fetch 调企微发消息 API，带 timeout；MOCK 时入内存 SENT
//   - enqueueOutbox(): send_message 工具底层，tx() 内 INSERT OR IGNORE（dedup_hash 去重）
//   - startAdapter() : CLI（stdin readline→runLoop→stdout）/ wecom（8090 http 回调→runLoop）
//   - 轮次装配层     : inboundText/inboundMedia → 安静窗口+下载栅栏攒齐"一轮"→ processTurn 一次回复
//                     （成串消息处理；边界原则「协议层 vs 对话层」见该节注释与 ARCHITECTURE.md）
//
// 三条致命纪律落地：
//   ① 副作用唯一出口是 outbox，enqueueOutbox 经 dedup_hash UNIQUE 去重（INSERT OR IGNORE）
//   ② 每个外部调用（sendWecom 的 fetch）都带 AbortController + timeout，绝不无限等待
//   ③ fetch（真发）在 tx 外，落库（status/sent_at）才进 tx，LLM/HTTP 不占 DB 锁
//
// 依赖方向（契约 §共享约定）：db ← adapter。只 import db.mjs，绝不反向 import loop/main。
// =====================================================================

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, tx, nowMs } from './db.mjs';
import { handleMedia } from './media.mjs';
import { handleEsmInbound } from './esm.mjs';
import { deepthinkEnabled, deepthinkIntercept, deepthinkTurnState } from './deepthink.mjs';
import {
  initTodoSchema, getState as getTodoState, rolloverSweep,
  addTodo, completeTodo, reopenTodo, dropTodo, parkTodo, unparkTodo,
  deferTodo, editTodo, appendDetail, addLink, reorderTodo,
  setTodoReminder, cancelTodoReminder, cancelScheduleFromPanel,
} from './todo.mjs';

// ---- 常量（契约 §常量集中：禁止魔法数散落）----
// HTTP/企微 timeout 复用 HTTP_TIMEOUT_MS；outbox 重试上限独立常量。
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15000);
const MAX_OUTBOX_ATTEMPTS = 5;
const HTTP_PORT = Number(process.env.HTTP_PORT || 8788);
let ADAPTER_MOCK = process.env.ADAPTER_MOCK === '1'; // let：selftest 自包含强制 mock，不依赖外部 env

// 企微发送凭证（契约 §环境变量）。沿用现有 e云企微(QIWE) doApi token 体系：
//   WECOM_API_URL = doApi 端点，WECOM_TOKEN = X-QIWEI-TOKEN，WECOM_GUID = 设备 guid。
// 若未来切官方企微（corpid/secret/agentid），在 sendWecom 内分支即可，对外签名不变。
const WECOM_API_URL = process.env.WECOM_API_URL || 'http://manager.qiweapi.com/qiwe/api/qw/doApi';
const WECOM_TOKEN = process.env.WECOM_TOKEN || '';
const WECOM_GUID = process.env.WECOM_GUID || '';
const WECOM_TARGET_ID = process.env.WECOM_TARGET_ID || ''; // owner 收件人 id（n=1）
// owner 门禁基准（n=1 只服务子淇）：优先 OWNER_ID，回落 WECOM_TARGET_ID。非 owner 入站直接丢。
const OWNER_ID = String(process.env.OWNER_ID || WECOM_TARGET_ID || '');
// 回调密钥路径：e云回调不签名，公网端口任何人可 POST → 配 secret 则 POST 必须命中 /cb/<secret>（防伪造注入·工具校验层）。
const WECOM_CALLBACK_SECRET = process.env.WECOM_CALLBACK_SECRET || '';
const CALLBACK_PATH = WECOM_CALLBACK_SECRET ? `/cb/${WECOM_CALLBACK_SECRET}` : null;
// PC 桥通知密钥路径：子淇电脑上的控制面（Happier daemon 等）向 owner 微信推事件通知的入口。
// 与企微回调分开配密钥（不同信任域）；不配 BRIDGE_SECRET 则该入口不存在（其他租户实例零变化）。
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const BRIDGE_PATH = BRIDGE_SECRET ? `/bridge/${BRIDGE_SECRET}` : null;
// 语音入口密钥路径（家里 Jetson 的语音链路，2026-07-25）：音箱听到的话经 SSH 隧道 POST 进来，
// 同步把回复文本还回去念。capability URL 纪律与 /cb /bridge 同款——不配 VOICE_SECRET 该入口就不存在
// （朋友实例连 404 都和旧版一模一样，零感知）。端口不对公网开，只走隧道（隐私红线）。
const VOICE_SECRET = process.env.VOICE_SECRET || '';
const VOICE_PATH = VOICE_SECRET ? `/voice/${VOICE_SECRET}` : null;
// 待办面板（capability URL 纪律与 /cb /bridge 同款）：TODO_SECRET 配了路由才存在、表才会建——
// 未配置的实例（如朋友）连 404 都和旧版一模一样，零感知。页面文件每次热读（改样式不用重启）。
const TODO_SECRET = process.env.TODO_SECRET || '';
const TODO_BASE = TODO_SECRET ? `/todo/${TODO_SECRET}` : null;
const TODO_PAGE_FILE = join(import.meta.dirname, 'todo_page.html');
// 面板公网链接（发给 owner / 提醒任务里引用）。复用 publish_page 的 PUBLIC_BASE_URL。
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
export const TODO_PANEL_URL = TODO_BASE && PUBLIC_BASE ? `${PUBLIC_BASE}${TODO_BASE}` : '';
// 轮次装配·安静窗口：每来一条消息重置计时，窗口内没有新消息才认为"这一串说完了"（迁 live 4s）。
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '4000', 10);
// 轮次装配·下载栅栏上限：安静窗口到了但媒体还在下载/识别时最多再等这么久（媒体卡死不无限扣住整轮）。
const FENCE_MAX_MS = parseInt(process.env.MEDIA_FENCE_MAX_MS || '30000', 10);
// 拆气泡上限（对话层连发）：agent 回复按空行拆成至多这么多条依次发；超上限把多出的段并进最后一条（不塌成大长串）。
const MAX_BUBBLES = parseInt(process.env.MAX_BUBBLES || '5', 10);
// 气泡节奏：同一次 relay 连发多条时，条与条之间至少隔这么久（不瞬发一堆，更像真人打字）。
const BUBBLE_PACE_MS = parseInt(process.env.BUBBLE_PACE_MS || '1500', 10);
// pacing 上限保护：单次 relay 最多给前这么多条之间加 sleep（防积压时 relay 拖太久占住 tick），之后快速发。
const BUBBLE_PACE_CAP = parseInt(process.env.BUBBLE_PACE_CAP || '5', 10);
// 签名字符（扑克小王）：splitBubbles 用它做"末段只剩签名→并回上一条，不单独成泡"的结构兜底。
// 与 prompt.mjs 人格签名保持一致；若签名变更（曾 🦞→🃏），这里同步改。
const SIGNATURE = '🃏';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// msgType 分类（e云 cmd 15000）：文本 / 图片 / 语音 / 文件。
const TEXT_TYPES = new Set([0, 2]);
const IMAGE_TYPES = new Set([7, 14, 101]);
const VOICE_TYPES = new Set([16]);
// 收微信文件（ziqi-only 结构开关，默认关）：e云文件消息的 msgType 未在文档明确，故不硬编一个魔法数——
// 用"载荷长得像文件"(fileId/文件 URL + fileName/fileSize)启发式识别，比猜数字稳。朋友实例 friend.env 无此
// flag → onFile 不接线 → 文件仍按旧版静默放过，行为零变化（隔离靠结构，不靠指令）。
const INBOUND_FILES_ENABLED = process.env.INBOUND_FILES_ENABLED === '1' || process.env.INBOUND_FILES_ENABLED === 'true';
// 载荷是否是"带字节的文件"：有文件通道(fileId/各类 fileUrl/fileAeskey) 且有文件名或声明大小。
// 图片/语音已被各自 type 集先分流，走到这里的只剩其它 msgType；文档(md/pdf/docx/xlsx…)即命中这里。
function looksLikeFile(d) {
  if (!d || typeof d !== 'object') return false;
  const hasChannel = d.fileId || d.fileBigHttpUrl || d.fileMiddleHttpUrl || d.fileThumbHttpUrl || d.fileHttpUrl || d.fileUrl || d.fileAeskey || d.fileAesKey;
  const hasMeta = (typeof d.fileName === 'string' && d.fileName.length > 0) || d.fileSize || d.fileBigSize;
  return !!(hasChannel && hasMeta);
}

// MOCK/selftest 下真发被拦截，发出的消息进这个内存数组，供断言去重（同 hash 只发一次）。
// 导出供 selftest 读取。watchdog 报警也复用 sendWecom，故这里集中持有。
export const SENT = [];

// relayOutbox 进程内单飞闸：worker tick(5s) 与 wecom adapter pollOutbox(10s) 是两个独立定时器、
// 同进程同事件循环，会在 await sendWecom 处交错读到同一 pending 行→重复发送。此布尔保证同一时刻
// 只有一个 relay 在跑，另一个直接早返回（被跳过的 pending 下一拍≤10s 必被消费，送达无实质延迟）。
let _relaying = false;

// ---------------------------------------------------------------------
// 带 timeout 的 fetch（致命纪律②）：任何外部调用绝不允许无限等待拖垮 worker tick。
// 超时抛 Error('timeout')，调用方计入证据（不静默吞）。
// ---------------------------------------------------------------------
async function fetchWithTimeout(url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS, externalSignal = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  // 外部 signal（如 watchdog 传入）与内部超时谁先触发都中止。
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', () => ctrl.abort(externalSignal.reason), { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    // AbortError 在超时场景下统一报成 timeout，便于 callWithResilience / 日志识别。
    if (e.name === 'AbortError') { const err = new Error('timeout'); err.statusCode = 408; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// sendWecom(target, content, {signal}) —— 纯 fetch 调企微发消息 API（契约签名）。
// 返回 { ok, error? }。失败不抛穿（relay 需要据返回值决定 attempts/last_error）。
//
// MOCK/selftest（ADAPTER_MOCK==='1'）：不真发，push 到内存 SENT 返回 ok:true。
// 为什么 push 到 SENT：selftest 断言"同 dedup_hash 只发一次"靠数 SENT.length。
// ---------------------------------------------------------------------

// 手机微信不渲染 Markdown：所有对外文本在真发出口统一剥离常见 md 符号（粗体/标题/代码/列表符），
// 避免 **/#/反引号在子淇手机上显示成难看的符号。这是结构层兜底——不指望模型每次都不吐 md（原则2）。
// 保守：只动明确是 md 语法的（粗体 **x**、行首标题井号、代码围栏/行内反引号、行首 -/* 列表符→•），不碰普通标点与中文。
export function stripMarkdownForPhone(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/```[^\n]*\n?/g, '')             // 代码围栏行 → 去围栏，保留其中文字
    .replace(/`([^`]+)`/g, '$1')               // 行内代码 → 去反引号
    .replace(/\*\*(.+?)\*\*/gs, '$1')          // 粗体 **x** → x
    .replace(/^#{1,6}[ \t]+/gm, '')            // 行首标题井号 → 去掉
    .replace(/^([ \t]*)[-*][ \t]+/gm, '$1• '); // 行首 -/* 列表符 → •
}

export async function sendWecom(target, content, { signal = null } = {}) {
  content = stripMarkdownForPhone(content); // 出口统一剥 md，覆盖 reply/send_message/ESM/图片回执所有路径
  if (ADAPTER_MOCK) {
    SENT.push({ target: String(target), content });
    return { ok: true };
  }
  if (!WECOM_TOKEN || !WECOM_GUID) {
    // 凭证缺失：响亮报错，不假装成功（失败要响，团队原则）。
    return { ok: false, error: 'wecom credentials missing (WECOM_TOKEN/WECOM_GUID)' };
  }
  try {
    const r = await fetchWithTimeout(
      WECOM_API_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-QIWEI-TOKEN': WECOM_TOKEN },
        // e云企微 doApi 发文本格式（移植自 digital-twin/wecom_esm_bot.mjs qiweSendText）。
        body: JSON.stringify({ method: '/msg/sendText', params: { guid: WECOM_GUID, toId: String(target), content } }),
      },
      HTTP_TIMEOUT_MS,
      signal
    );
    const j = await r.json().catch(() => ({}));
    if (j.code !== 0 && j.errcode !== 0 && j.code !== undefined) {
      return { ok: false, error: `wecom api code=${j.code} msg=${j.msg || j.errmsg || ''}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------
// enqueueOutbox({channel,target,content,dedupHash}) —— send_message 工具底层（契约签名）。
// tx() 内 INSERT OR IGNORE outbox(dedup_hash UNIQUE)。受影响行数=0 → deduped=true（已派过，幂等）。
//
// 致命纪律①：副作用入队是唯一出口，dedupHash 由调用方按 conventions 算好传入（这里不重算，
// 保持职责单一——本函数只负责"按 hash 幂等入库"）。
// ---------------------------------------------------------------------
// 微信不渲染 Markdown：`**加粗**`、`# 标题`、`- 列表`、代码围栏在手机上原样显示成一堆符号。
// 人设里写了"别用"，但 07-31 早上那条待办清单还是带着 `**某客户**` 发出去了——**叮嘱管不住偶发**（原则2）。
// 所以在唯一出口做确定性剥离：模型爱怎么写怎么写，微信这一侧永远干净。
// 只剥"标记符号"，不动任何文字内容；表格不处理（转换有损，宁可原样也不猜他想表达什么）。
const WECOM_MD_STRIP = [
  [/^[ \t]*```[^\n]*\n?/gm, ''], // 代码围栏行整行删（围栏里的正文保留）
  [/^[ \t]*#{1,6}[ \t]+/gm, ''], // 行首标题标记（要求 # 后有空格，不误伤「#快记」）
  [/^[ \t]*[-*+][ \t]+/gm, ''], // 行首列表符（要求后有空格，不误伤「**加粗**」「——破折号」）
  [/\*\*([\s\S]+?)\*\*/g, '$1'], // 加粗
  [/__([\s\S]+?)__/g, '$1'], // 加粗（下划线写法）
  [/`([^`\n]+)`/g, '$1'], // 行内代码
];
export function stripMarkdownForWecom(text) {
  const raw = String(text ?? '');
  let s = raw;
  for (const [re, rep] of WECOM_MD_STRIP) s = s.replace(re, rep);
  // 剥完只剩空白（如整条就是一个代码围栏）→ 退回原文。清理绝不能把一条真消息变成空气。
  return s.trim() ? s : raw;
}

export function enqueueOutbox({ channel = 'wecom', target, content, dedupHash }) {
  if (!dedupHash) throw new Error('enqueueOutbox: dedupHash required');
  if (!target) throw new Error('enqueueOutbox: target required');
  // 落库即落"实际会被发出去的样子"（outbox 是投递流水，存原始 Markdown 会让事后对账对不上屏幕）。
  // dedupHash 由调用方按原文算好，这里不重算——剥离不改变去重语义。
  const body = channel === 'wecom' ? stripMarkdownForWecom(content) : String(content ?? '');
  return tx((db) => {
    const now = nowMs();
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO outbox (channel, target, content, dedup_hash, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`
      )
      .run(channel, String(target), body, dedupHash, now);
    // changes=0 → 命中 UNIQUE，说明同 hash 已入队（尽力去重，at-least-once，不假装 effectively-once）。
    if (info.changes === 0) {
      const row = db.prepare('SELECT id FROM outbox WHERE dedup_hash = ?').get(dedupHash);
      return { id: row ? row.id : null, deduped: true };
    }
    return { id: Number(info.lastInsertRowid), deduped: false };
  });
}

// ---------------------------------------------------------------------
// relayOutbox() —— worker tick 调用（契约签名）。
// 扫 outbox status='pending'，逐条经 channel 真发：
//   成功 → tx() 置 status='sent'+sent_at；失败 → attempts+1+last_error，超上限置 'failed'。
//
// 致命纪律②③：fetch（真发）在 tx 外，仅落库在 tx 内（不占 DB 锁 + 不在事务里 await）。
// at-least-once：dedup_hash 已保证不重复入队；这里发送本身可能重试（崩在标 sent 前会重发，靠去重兜底）。
// ---------------------------------------------------------------------
export async function relayOutbox() {
  // 单飞闸：已有 relay 在跑就跳过本次（防跨定时器交错双发）。try/finally 保证异常路径也释放。
  if (_relaying) return { sent: 0, failed: 0, skipped: true };
  _relaying = true;
  try {
  const db = getDb();
  let sent = 0;
  let failed = 0;

  // 先把待发行读出（只读，不开事务），逐条在事务外发送，再单条落库。
  // 限制单 tick 处理量避免某 tick 过长（轻量机器，TICK_MS=5s）。
  const rows = db
    // id ASC 兜底：同一轮拆出的气泡常同毫秒入队，created_at 打平时靠自增 id 保证按拆出顺序依次发（不乱序）。
    .prepare(`SELECT id, channel, target, content, attempts FROM outbox WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 50`)
    .all();

  let sentInCall = 0; // 本次 relay 已成功发出的条数——用于气泡节奏（条间隔）与上限保护。
  for (const row of rows) {
    // 气泡节奏：连发多条时（拆气泡/晨间打卡+天气等），条与条之间至少隔 BUBBLE_PACE_MS，不瞬发一堆。
    //   首条立即发（sentInCall==0 不 sleep）；MOCK/selftest 不 sleep（不拖慢测试）；
    //   只给前 BUBBLE_PACE_CAP 条加 sleep（积压时后续快速发，不长时间占住 tick）。
    //   安全：watchdog SILENCE_MS=10min ≫ 此处 pacing，绝不会饿死 heartbeat（heartbeat 是 tick 末步）。
    if (sentInCall > 0 && sentInCall <= BUBBLE_PACE_CAP && !ADAPTER_MOCK) await sleep(BUBBLE_PACE_MS);
    let result;
    if (row.channel === 'wecom') {
      result = await sendWecom(row.target, row.content); // ← fetch 在 tx 外（致命纪律③）
    } else {
      // 未知 channel：响亮失败，不静默吞，计入 attempts 走失败分支。
      result = { ok: false, error: `unknown channel: ${row.channel}` };
    }

    if (result.ok) {
      tx((d) => {
        d.prepare(`UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?`).run(nowMs(), row.id);
      });
      sent++;
      sentInCall++;
    } else {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_OUTBOX_ATTEMPTS;
      tx((d) => {
        d.prepare(`UPDATE outbox SET attempts = ?, last_error = ?, status = ? WHERE id = ?`).run(
          attempts,
          String(result.error || 'unknown'),
          dead ? 'failed' : 'pending',
          row.id
        );
      });
      failed++;
      // 失败要响（留证据，不静默吞）。
      console.error('[adapter] outbox send failed id=%d attempts=%d: %s', row.id, attempts, result.error);
    }
  }

  return { sent, failed };
  } finally {
    _relaying = false;
  }
}

// ---------------------------------------------------------------------
// startAdapter(mode, {onMessage, pollOutbox}) —— 进程入站编排（契约职责）。
//
//   mode='cli'   : stdin readline → onMessage(text) → 把 reply 写 stdout（起步/本地调试）。
//   mode='wecom' : 8090(HTTP_PORT) http 回调 → onMessage(text) → runLoop；并定期 pollOutbox() relay。
//
// onMessage(payload) 由 main 注入 = handleIncoming 的薄包装，返回 reply 文本。
// pollOutbox() 由 main 注入 = relayOutbox 的薄包装（worker tick 已在 relay，这里 wecom 模式下
//   也兜一个低频 relay，保证回调进程独立存活时 outbox 仍被消费）。
//
// 返回 { stop } 句柄，便于优雅退出（main 注册 SIGTERM/SIGINT 时调用）。
// ---------------------------------------------------------------------
export function startAdapter(mode, { onMessage, pollOutbox = null } = {}) {
  if (typeof onMessage !== 'function') throw new Error('startAdapter: onMessage required');

  if (mode === 'cli') return startCliAdapter({ onMessage });
  if (mode === 'wecom') return startWecomAdapter({ onMessage, pollOutbox });
  throw new Error(`startAdapter: unknown mode '${mode}' (expected 'cli'|'wecom')`);
}

// ---- CLI adapter：stdin readline → runLoop → stdout（最小起步形态）----
function startCliAdapter({ onMessage }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  console.error('[adapter:cli] ready. type a line and press enter (ctrl-d to exit).');

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      const reply = await onMessage({ sessionId: 'cli', userInput: text });
      process.stdout.write((reply ?? '') + '\n');
    } catch (e) {
      // 失败要响：把错误写 stderr，不假装回复成功。
      console.error('[adapter:cli] onMessage failed: %s', e.message);
      process.stdout.write('[error] ' + e.message + '\n');
    }
  });

  rl.on('close', () => console.error('[adapter:cli] stdin closed.'));

  return {
    mode: 'cli',
    stop() {
      rl.close();
    },
  };
}

// ---- 待办面板 HTTP 面（仅 TODO_SECRET 配置的实例存在）----
// 页面点勾/微信里让小王记，最终都落 todo.mjs 同一张表——这里只是页面那一侧的门。
// 写操作单一入口 applyTodoOp（工具校验层：op 白名单 + 参数由 todo.mjs 各函数守卫），
// actor 恒为 'web'（流水可区分"页面上点的"和"agent 干的"）。
let _todoSchemaReady = false;
function ensureTodoSchema() {
  if (!_todoSchemaReady) { initTodoSchema(getDb()); _todoSchemaReady = true; }
}

export function applyTodoOp(db, p) {
  const actor = 'web';
  const idOf = (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1) throw new Error('id 无效');
    return n;
  };
  const ownerSession = OWNER_ID ? `wecom:${OWNER_ID}` : null;
  switch (String(p.op || '')) {
    case 'add': {
      const r = addTodo(db, { title: p.title, detail: p.detail ?? '', links: p.links ?? [], tag: p.tag ?? null, day: p.day, source: 'web', actor });
      if (p.remind_at) setTodoReminder(db, r.id, p.remind_at, { sessionId: ownerSession, panelUrl: TODO_PANEL_URL, actor });
      return r;
    }
    case 'done': return completeTodo(db, idOf(p.id), actor);
    case 'reopen': return reopenTodo(db, idOf(p.id), actor);
    case 'drop': return dropTodo(db, idOf(p.id), actor);
    case 'park': return parkTodo(db, idOf(p.id), actor);
    case 'unpark': return unparkTodo(db, idOf(p.id), actor);
    case 'defer': return deferTodo(db, idOf(p.id), p.day, actor);
    case 'edit': return editTodo(db, idOf(p.id), { title: p.title, detail: p.detail, tag: p.tag }, actor);
    case 'note': return appendDetail(db, idOf(p.id), p.text, actor);
    case 'link': return addLink(db, idOf(p.id), p.url, actor);
    case 'reorder': return reorderTodo(db, idOf(p.id), p.after ?? null, actor);
    case 'remind': return setTodoReminder(db, idOf(p.id), p.at, { sessionId: ownerSession, panelUrl: TODO_PANEL_URL, actor });
    case 'remind_cancel': return cancelTodoReminder(db, idOf(p.id), actor);
    case 'schedule_cancel': return cancelScheduleFromPanel(db, String(p.kind || ''), p.id); // 取消面板"提醒/周期"区的一条定时
    default: throw new Error(`未知 op「${p.op}」`);
  }
}

const jsonRes = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

// 返回 true=该请求属于待办面板（无论成败都已应答）。
function handleTodoRequest(req, res, pathname) {
  if (!TODO_BASE || !(pathname === TODO_BASE || pathname.startsWith(TODO_BASE + '/'))) return false;
  ensureTodoSchema();
  const sub = pathname.slice(TODO_BASE.length).replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && sub === '/') {
      // 页面壳：数据全走 /api/state（页面与工具共用同一 getState，两个视图永远一致）
      const html = readFileSync(TODO_PAGE_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(html);
      return true;
    }
    if (req.method === 'GET' && sub === '/api/state') {
      rolloverSweep(getDb()); // 懒滚动：读到新的一天先滚再答（与 worker 每拍 sweep 双保险）
      const hd = Math.min(90, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('history')) || 14));
      jsonRes(res, 200, { ok: true, state: getTodoState(getDb(), { historyDays: hd }) });
      return true;
    }
    if (req.method === 'POST' && sub === '/api/op') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 128_000) req.destroy(); });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const result = applyTodoOp(getDb(), p);
          rolloverSweep(getDb());
          jsonRes(res, 200, { ok: true, result, state: getTodoState(getDb()) });
        } catch (e) {
          jsonRes(res, 400, { ok: false, error: e.message });
        }
      });
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  } catch (e) {
    console.error('[adapter:todo] %s %s failed: %s', req.method, sub, e.message);
    jsonRes(res, 500, { ok: false, error: e.message });
    return true;
  }
}

// ---- 企微 adapter：HTTP 回调（P3 接）+ outbox relay 低频兜底 ----
// 回调进程读 POST body 提取文本 → onMessage → 把 reply 入 outbox（由 relay 真发，不在回调里阻塞发）。
// 为什么回调里不直接 sendWecom：回调要快返 200 给企微平台，发送走 outbox 异步 relay（解耦 + 去重 + 自愈）。
function startWecomAdapter({ onMessage, pollOutbox }) {
  // 轮次装配层的生产接线（selftest 用 mock deps 直测装配逻辑，见 inboundText/inboundMedia）。
  const turnDeps = {
    debounceMs: DEBOUNCE_MS,
    fenceMs: FENCE_MAX_MS,
    processMedia: (args) => handleMedia(args),
    esmInbound: (text, sessionId) => handleEsmInbound(getDb(), text, sessionId),
    sendReceipt: (target, content, idx = 0) => maybeReplyToOutbox(target, content, idx),
    onMessage,
  };
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'xiaowang-v2-adapter' }));
      return;
    }
    // 待办面板（GET 页面/状态 + POST 操作）：路径不命中时零影响，走原有逻辑。
    if (TODO_BASE && handleTodoRequest(req, res, new URL(req.url, 'http://x').pathname)) return;
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }

    // PC 桥通知（控制面事件 → owner 微信）：POST /bridge/<secret>，body {text, key?}。
    // 收件人恒为 owner（Schema 层：路径上不可表达任意收件人）；出站走 outbox 唯一出口（去重+崩溃可重发）。
    // key 为调用方幂等键（如会话id+事件类型），掺入 dedup_hash 让"同文本不同事件"不被误去重。
    if (BRIDGE_PATH && new URL(req.url, 'http://x').pathname === BRIDGE_PATH) {
      let bridgeBody = '';
      req.on('data', (c) => {
        bridgeBody += c;
        if (bridgeBody.length > 64_000) req.destroy();
      });
      req.on('end', () => {
        let out;
        try {
          const payload = JSON.parse(bridgeBody || '{}');
          const text = String(payload.text ?? '').trim().slice(0, 4000);
          if (!text) throw new Error('text required');
          if (!OWNER_ID) throw new Error('owner not configured');
          const norm = ['wecom', OWNER_ID, text, 'bridge', String(payload.key ?? '')]
            .map((p) => String(p ?? '').trim())
            .join(' ');
          const hash = createHash('sha256').update(norm).digest('hex').slice(0, 16);
          out = enqueueOutbox({ channel: 'wecom', target: OWNER_ID, content: text, dedupHash: hash });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: out.id, deduped: out.deduped }));
      });
      return;
    }

    // 语音轮入口：POST /voice/<secret>，body {text}（ASR 转写好的一句话），同步返回 {reply}。
    // 与 /cb 的根本差别是【同步 + 不进 outbox】：音箱把话念出来就是送达，再往微信刷一条是重复打扰。
    // 说话人恒为 owner（路径上不可表达任意人，与 /bridge 同款 Schema 层锁）；会话 id 复用他的微信会话，
    // 语音和微信因此共享同一份逐字近窗/召回/摘要/工具——是同一个小王换了张嘴，不是第二个大脑。
    if (VOICE_PATH && new URL(req.url, 'http://x').pathname === VOICE_PATH) {
      let voiceBody = '';
      req.on('data', (c) => {
        voiceBody += c;
        if (voiceBody.length > 64_000) req.destroy();
      });
      req.on('end', async () => {
        const t0 = nowMs();
        let text = '';
        let wantStream = false;
        try {
          const payload = JSON.parse(voiceBody || '{}');
          text = String(payload.text ?? '').trim().slice(0, 2000);
          wantStream = payload.stream === true;
          if (!text) throw new Error('text required');
          if (!OWNER_ID) throw new Error('owner not configured');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }

        // 流式（stream:true）：逐句 SSE 推出去，音箱收到第一句就能开口，不用等整段跑完。
        // 分句在服务端做——客户端只管收到一句念一句，forSpeech 这把尺也只有一处。
        // 非流式路径原样保留：老客户端 / curl 调试不受影响。
        let flusher = null;
        let sent = '';
        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          flusher = createSentenceFlusher((s) => { sent += s; sse({ type: 'sentence', text: s }); });
        }

        try {
          // 与微信轮共用 senderId 串行闸：同一个人不会同时跑两个 agentic（边打字边对音箱说话）。
          const reply = await chainTurn(OWNER_ID, () =>
            onMessage({
              sessionId: _sess(OWNER_ID),
              userInput: text,
              rawUserInput: text,
              voice: true,
              onDelta: flusher
                ? (ev) => { if (ev.type === 'text') flusher.push(ev.text); else if (ev.type === 'discard') flusher.discard(); }
                : null,
            }));
          const spoken = forSpeech(reply);
          console.log('[adapter:voice]%s %dms「%s」→「%s」',
            wantStream ? ' stream' : '', nowMs() - t0, text.slice(0, 30), spoken.slice(0, 40));

          if (!wantStream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, reply: spoken, ms: nowMs() - t0 }));
            return;
          }
          // 收尾：缓冲里剩的半句先吐掉（flush 会累进 sent）。
          flusher.flush();
          // 一个字都没流出去（raw 引擎不流式 / mock / 模型只调工具没说话）→ 整段补发，别让用户听个寂寞。
          if (!sent && spoken) res.write(`data: ${JSON.stringify({ type: 'sentence', text: spoken })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done', reply: spoken, ms: nowMs() - t0 })}\n\n`);
          res.end();
        } catch (e) {
          console.error('[adapter:voice] failed: %s', e.message);
          if (wantStream) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
            res.end();
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        }
      });
      return;
    }

    // 回调密钥路径校验（防伪造注入）：配了 secret 则 POST 必须命中 /cb/<secret>，否则 404。
    if (CALLBACK_PATH) {
      const pth = new URL(req.url, 'http://x').pathname;
      if (pth !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
    }

    let body = '';
    req.on('data', (c) => {
      body += c;
      // 简单防超大 body（轻量机器自我保护），超 1MB 直接断。
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      // 先快速 ack，避免企微平台重投（回调要求快返）。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        console.error('[adapter:wecom] bad json body: %s', e.message);
        return;
      }

      // 解析 e云 data 数组 → 自环过滤 + owner 门禁 → 全部模态进轮次装配层（攒齐一轮再交模型）。
      routeInbound(payload, {
        ownerId: OWNER_ID,
        onText: (senderId, text) => inboundText(senderId, text, turnDeps),
        onMedia: (senderId, msgData, kind) => inboundMedia(senderId, msgData, kind, turnDeps),
        // 文件走同一条媒体轮次装配管线（kind='file'）。onFile 只在开关打开时接线（ziqi），
        // 否则为 null → routeInbound 里文件按旧版静默放过（朋友零变化）。
        onFile: INBOUND_FILES_ENABLED ? (senderId, msgData) => inboundMedia(senderId, msgData, 'file', turnDeps) : null,
        onAccount: (d) => console.log('[adapter:wecom] account status:', d && d.code),
      });
    });
  });

  server.on('error', (e) => console.error('[adapter:wecom] server error: %s', e.message));
  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.error('[adapter:wecom] listening :%d (target=%s)', HTTP_PORT, WECOM_TARGET_ID ? 'set' : 'unset');
  });

  // outbox relay 兜底：回调进程独立存活时，低频 relay 消费 outbox。
  // worker tick 已在 relay（main.startWorker），这里是 wecom 进程的额外保险，间隔放宽到 10s。
  let relayTimer = null;
  if (typeof pollOutbox === 'function') {
    relayTimer = setInterval(async () => {
      try {
        await pollOutbox();
      } catch (e) {
        console.error('[adapter:wecom] pollOutbox failed: %s', e.message);
      }
    }, 10_000);
    relayTimer.unref?.(); // 不阻止进程退出
  }

  return {
    mode: 'wecom',
    server,
    stop() {
      if (relayTimer) clearInterval(relayTimer);
      server.close();
    },
  };
}

// =====================================================================
// 入站路由（e云 data 数组）：normalizeWecomMessages 拆包 → routeInbound 过滤分流。
// 抽成纯函数便于 selftest 断言；HTTP 回调与 selftest 共用同一逻辑。
// =====================================================================
function normalizeWecomMessages(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.testMsg) return []; // e云连通性测试包，无业务消息
  let msgs = payload.data;
  if (!Array.isArray(msgs)) msgs = msgs ? [msgs] : [];
  // 兼容官方企微单对象（无 data 数组但有 MsgType/Content）
  if (msgs.length === 0 && (payload.MsgType || payload.content || payload.Content)) msgs = [payload];
  return msgs.filter((m) => m && typeof m === 'object');
}

// 路由：自环过滤(senderId===userId) + owner 门禁(非 owner 丢) + msgType 分流。
// onText(senderId,text) / onMedia(senderId,msgData,kind) / onAccount(msgData) 由调用方注入。
export function routeInbound(payload, { ownerId = OWNER_ID, onText, onMedia, onFile, onAccount } = {}) {
  for (const m of normalizeWecomMessages(payload)) {
    const cmd = m.cmd;
    const senderId = m.senderId != null ? m.senderId : extractWecomSender(m);
    const userId = m.userId;
    const msgType = m.msgType;
    const msgData = m.msgData && typeof m.msgData === 'object' ? m.msgData : m;

    // 自环过滤：自己发的（senderId===userId）跳过，不回自己。
    if (userId != null && senderId != null && String(senderId) === String(userId)) continue;
    // 账号状态等非消息 cmd
    if (cmd === 11016) { onAccount && onAccount(msgData); continue; }
    if (cmd != null && cmd !== 15000) continue;
    // owner 门禁（不信任缺失=owner，安全靠结构·团队原则3）：配了 ownerId 时，senderId 必须【显式等于】
    // ownerId 才放行；缺失或不等一律丢（n=1 只服务子淇，senderId 缺失=不可信，不再兜底当 owner）。
    // e云 doApi 回调恒带 senderId；这条只会挡掉伪造/无主消息，不影响正常收信。
    if (ownerId && String(senderId ?? '') !== String(ownerId)) continue;

    if (msgType == null || TEXT_TYPES.has(msgType)) {
      const text = (typeof msgData.content === 'string' ? msgData.content : '') || extractWecomText(m);
      if (text && onText) onText(String(senderId ?? ownerId), text);
    } else if (IMAGE_TYPES.has(msgType)) {
      onMedia && onMedia(String(senderId ?? ownerId), msgData, 'image');
    } else if (VOICE_TYPES.has(msgType)) {
      onMedia && onMedia(String(senderId ?? ownerId), msgData, 'voice');
    } else if (onFile && looksLikeFile(msgData)) {
      onFile(String(senderId ?? ownerId), msgData);
    } else if (msgType != null) {
      // 未处理的 msgType 记一行（原则4 可观测）：下次真发文件/视频能查到 e云 真实 msgType + 载荷字段，
      // 不再像文件那样"静默丢弃、连排查线索都没有"。仅日志，不改行为。
      console.error('[adapter:wecom] 未处理 msgType=%s keys=%s', msgType, Object.keys(msgData || {}).join(','));
    }
  }
}

// =====================================================================
// 轮次装配层 —— 微信把主人的一个意思拆成一串独立到达的事件（连发短句/图配文/语音），
// 这里把"这一轮"机械攒齐，再交给模型一次理解、一次回复。
//
// 边界（原则11 + ARCHITECTURE.md「协议层 vs 对话层」）：
//   harness 只做【确定性装配】——安静窗口攒消息、下载栅栏等媒体就位、给每条记录
//   到达时刻/模态/顺序。"这串是一个意思还是几件事、图配哪句、是不是修正"这类模糊
//   判断全部留给模型，绝不在 loop 之前用规则判意图。
//   协议层例外：# 快记是显式语法，逐条抽出走确定性 fast-path；媒体失败即时确定性回执
//   （像朋友说"图挂了再发下"）；媒体成功不单独回执——回应由模型在整轮回复里一次说清。
//
// deps 注入（debounceMs/fenceMs/processMedia/esmInbound/sendReceipt/onMessage）：
//   生产接线在 startWecomAdapter（turnDeps）；selftest 传 mock deps + 短窗口离线直测。
// =====================================================================

const _turns = new Map();  // senderId → { items, pending, timer, windowDone, fenceTimer }
const _chains = new Map(); // senderId → Promise（轮次串行闸：上一轮回完才跑下一轮，回复不乱序）

const _sess = (senderId) => (senderId ? `wecom:${senderId}` : 'wecom');

function _getTurn(senderId) {
  let t = _turns.get(senderId);
  if (!t) {
    t = { items: [], pending: 0, timer: null, windowDone: false, fenceTimer: null, fenceDeadline: null };
    _turns.set(senderId, t);
  }
  return t;
}

// 每来一条消息重置安静窗口；栅栏【计时器】跟着撤（等窗口再到时重挂），
// 但栅栏【deadline】保留——它是硬上限，用户持续说话不能无限延长媒体等待（审查发现5）。
function _armWindow(senderId, deps) {
  const turn = _getTurn(senderId);
  clearTimeout(turn.timer);
  clearTimeout(turn.fenceTimer);
  turn.fenceTimer = null;
  turn.windowDone = false;
  const t = setTimeout(() => {
    turn.windowDone = true;
    _tryFlush(senderId, deps);
  }, deps.debounceMs);
  t.unref?.();
  turn.timer = t;
}

function _tryFlush(senderId, deps) {
  const turn = _turns.get(senderId);
  if (!turn || !turn.windowDone) return;
  if (turn.pending > 0) {
    // 下载栅栏：媒体还没就位不 flush（修"文字先跑 agent、看不到图"的竞态）。
    // deadline 只在首次进入等待时定死（绝对时刻），之后窗口怎么重置都不延长——上限兜底不无限等。
    if (turn.fenceDeadline == null) turn.fenceDeadline = nowMs() + deps.fenceMs;
    if (!turn.fenceTimer) {
      const ft = setTimeout(() => _flushTurn(senderId, deps), Math.max(0, turn.fenceDeadline - nowMs()));
      ft.unref?.();
      turn.fenceTimer = ft;
    }
    return;
  }
  _flushTurn(senderId, deps);
}

// 排进某人的轮次串行闸并拿回结果（语音轮用；微信轮走 _flushTurn 里的同一个 _chains）。
// 为什么共用一张表：语音和微信是同一个人对同一个 session 说话，两条 agentic 并发跑会让
// episodes 交错、逐字近窗错乱。上一轮失败不该卡住下一轮，故 prev 先吞异常再接。
export function chainTurn(senderId, run) {
  const prev = _chains.get(senderId) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  const guard = next.catch(() => {});
  _chains.set(senderId, guard);
  guard.finally(() => { if (_chains.get(senderId) === guard) _chains.delete(senderId); });
  return next;
}

// 出站口语化（结构兜底，不指望 prompt 每次都克制——原则2）：markdown/表情/链接念出来是噪音。
// 只在语音入口用；微信回复一个字都不动。
export function forSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')                      // 代码块：念不出来，整段丢
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')            // markdown 链接：只留可读文字
    .replace(/https?:\/\/\S+/g, '链接我发你微信')            // 裸链接：念 URL 是灾难
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')  // 表情（含签名🃏）与变体选择符/零宽连接符
    .replace(/^\s*[-*>#]+\s*/gm, '')                      // 行首列表/标题标记
    .replace(/[*_`|]/g, '')                               // 行内 markdown 标记
    .replace(/\s+/g, ' ')                                 // 换行折成一句：TTS 不需要排版
    .trim();
}

// 流式分句（语音）：逐 token 攒到一句完整的话才交出去——TTS 按句合成，半句喂进去断得很难听。
// 句末标点切；没有标点但攒够 SPEECH_FLUSH_LEN 就在逗号处切（模型偶尔一口气不打标点）。
// 每句出门前过 forSpeech（结构兜底，与非流式路径同一把尺）。
const SPEECH_ENDS = /[。！？!?\n]/;
const SPEECH_BREAKS = /[，,；;、—]/;
const SPEECH_FLUSH_LEN = 40;
// 第一句用更短的闸：先出声比说得整齐重要——人等"它开口"，不等"它说完第一句"。
// 后面的句子攒长一点更连贯（TTS 逐句合成，切太碎反而听着一顿一顿）。
const SPEECH_FIRST_FLUSH_LEN = 14;

export function createSentenceFlusher(emit) {
  let buf = '';
  let emitted = 0;
  const cut = (i) => {
    const s = forSpeech(buf.slice(0, i + 1));
    buf = buf.slice(i + 1);
    if (s) { emitted++; emit(s); }
  };
  return {
    push(text) {
      buf += text;
      for (;;) {
        const end = buf.search(SPEECH_ENDS);
        if (end >= 0) { cut(end); continue; }
        const limit = emitted === 0 ? SPEECH_FIRST_FLUSH_LEN : SPEECH_FLUSH_LEN;
        if (buf.length >= limit) {
          const br = buf.search(SPEECH_BREAKS);
          if (br >= 6) { cut(br); continue; }
        }
        break;
      }
    },
    discard() { buf = ''; },       // 这一轮改调工具了，没念的作废
    flush() { const s = forSpeech(buf); buf = ''; if (s) { emitted++; emit(s); } return s; },
  };
}

function _flushTurn(senderId, deps) {
  const turn = _turns.get(senderId);
  if (!turn) return;
  _turns.delete(senderId);
  clearTimeout(turn.timer);
  clearTimeout(turn.fenceTimer);
  // 栅栏超时仍未就位的媒体标记为孤儿：resolve 后作为新一轮的料送达，内容不丢。
  for (const it of turn.items) if (!it.ready) it.orphaned = true;
  const ready = turn.items.filter((it) => it.ready);
  const prev = _chains.get(senderId) || Promise.resolve();
  const next = prev
    .then(() => processTurn(senderId, ready, deps))
    .catch((e) => console.error('[adapter:wecom] processTurn failed: %s', e.message));
  _chains.set(senderId, next);
  next.finally(() => { if (_chains.get(senderId) === next) _chains.delete(senderId); });
}

// 文本入轮（导出供 selftest 离线直测）。
export function inboundText(senderId, text, deps) {
  _getTurn(senderId).items.push({ at: nowMs(), kind: 'text', text: String(text), ready: true, mediaLogId: null });
  _armWindow(senderId, deps);
}

// 媒体入轮：先占位（pending 栅栏计数），后台下载/识别/转写完成后原位填回——顺序按到达时刻保留。
export function inboundMedia(senderId, msgData, kind, deps) {
  const turn = _getTurn(senderId);
  const item = { at: nowMs(), kind, text: null, ready: false, mediaLogId: null, orphaned: false, turn };
  turn.items.push(item);
  turn.pending++;
  _armWindow(senderId, deps);
  // 两参 then（不是 .then().catch()）：catch 只兜 processMedia 的 rejection，
  // 绝不把 _resolveMediaItem 自身的异常再喂回 _resolveMediaItem（双 resolve → pending 双扣变负，审查发现3）。
  deps.processMedia({ senderId, sessionId: _sess(senderId), msgData, kind }).then(
    (out) => _resolveMediaItem(senderId, item, out, deps),
    (e) => {
      console.error('[adapter:wecom] media processing failed: %s', e.message);
      const receipt = kind === 'image' ? '图片没处理成，再发一次？' : kind === 'file' ? '文件没处理成，再发一次？' : '语音没处理成，再发一次？';
      _resolveMediaItem(senderId, item, { mediaLogId: null, receipt, feedText: null, desc: null }, deps);
    }
  );
}

function _resolveMediaItem(senderId, item, out, deps) {
  if (item.ready) return; // 幂等闸：同一 item 绝不二次 resolve（防未来改动引入双扣 pending 计数）
  // 成功：图→客观描述入轮，语音→转写文本入轮（打字等价）。失败：协议层即时回执，本轮不含这条。
  if (item.kind === 'image' && out && out.desc) {
    item.text = out.desc;
    item.mediaLogId = out.mediaLogId;
  } else if ((item.kind === 'voice' || item.kind === 'file') && out && out.feedText) {
    // 文件与语音同构：都把一段【文本】喂进本轮（语音=转写；文件="收到文件X已存沙箱path"的系统告知）。
    item.text = out.feedText;
    item.mediaLogId = out.mediaLogId;
  } else {
    item.text = null;
    if (out && out.receipt && senderId) deps.sendReceipt(senderId, out.receipt);
  }
  item.ready = true;
  if (item.orphaned) {
    // 所属轮已被栅栏超时 flush 掉：迟到的内容作为新料进当前缓冲（紧接着的下一轮送达，不丢）。
    if (item.text != null) {
      _getTurn(senderId).items.push({ at: item.at, kind: item.kind, text: item.text, ready: true, mediaLogId: item.mediaLogId });
      _armWindow(senderId, deps);
    }
    return;
  }
  item.turn.pending--;
  if (_turns.get(senderId) === item.turn) _tryFlush(senderId, deps);
}

// 装配一轮的输入（纯函数，导出供 selftest 直测）。返回 { llmText, rawUserText }：
//   llmText     给模型看的。单条文字/语音原样直通（日常单发零脚手架零噪声、# 与打卡行为不变）；
//               多条则带 [HH:MM:SS 模态] 的到达时间事实——"一个意思还是几件事"由模型判断。
//   rawUserText 主人的纯原话（文字+语音转写，不含图片描述这类机器产物）：
//               供 record_checkin 等不可逆登记（esm_raw 绝不混入装配脚手架）+ 召回检索词。
export function buildTurnInput(items) {
  const live = (items || []).filter((it) => it && typeof it.text === 'string' && it.text.trim() !== '');
  if (!live.length) return { llmText: null, rawUserText: null };
  // 纯图轮 rawUserText='' 而非 null：'' 顺 ?? 传到 ctx.userInput，让 record_checkin 的空原话守卫生效——
  // 若回退成 userInput，机器产物（图片描述+脚手架）会被登记进 esm_raw 不可逆层（审查发现4）。
  // 图片描述、文件告知都是机器产物，不进 rawUserText（否则会被 record_checkin 登记进 esm_raw 不可逆层）。
  const rawUserText = live.filter((it) => it.kind !== 'image' && it.kind !== 'file').map((it) => it.text).join('\n');
  if (live.length === 1) {
    const it = live[0];
    if (it.kind === 'image') return { llmText: `[图片 media#${it.mediaLogId ?? '?'}] ${it.text}`, rawUserText: '' };
    if (it.kind === 'file') return { llmText: it.text, rawUserText: '' }; // 文件告知自带说明，原样进 llm；不进 esm_raw
    return { llmText: it.text, rawUserText: it.text }; // 文字/语音直通：与旧行为逐字一致
  }
  const KIND_LABEL = { text: '文字', image: '图片', voice: '语音转写', file: '文件' };
  const fmt = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 19); // CST HH:MM:SS（与 esm cstShift 同口径）
  const lines = live.map((it) => {
    const tag = it.kind === 'image' ? `图片 media#${it.mediaLogId ?? '?'}` : (KIND_LABEL[it.kind] || it.kind);
    return `[${fmt(it.at)} ${tag}] ${it.text}`;
  });
  return { llmText: `【${live.length} 条连发消息｜按到达顺序】\n${lines.join('\n')}`, rawUserText };
}

// 拆气泡（对话层 · buildTurnInput 的输出侧镜像）——导出供 selftest 直测。
// 边界（原则11 + 「协议层 vs 对话层」）：断点是【软判断】，归模型——它想像真人连发几条时用空行标出来；
// harness 只做【确定性投递】：按空行把 agent 回复拆成几条依次发。协议层回执（#/打卡/媒体失败）不走这里。
// 护栏（防刷屏，harness 兜底不指望模型每次克制·原则2）：
//   - 只按【空行】(2+换行)拆：单换行的「1.」「2.」列表、连贯段落里的软换行都不拆，留一条。
//   - 段数 > MAX_BUBBLES 就整段发一条：多段结构化解释本就一条读得顺，连发 5 条是刷屏。
// 返回 1..N 段（各自 trim、去空段）；单段/短回复原样一条（日常单发零变化）。
export function splitBubbles(text) {
  if (typeof text !== 'string') return text == null ? [] : [String(text)];
  const trimmed = text.trim();
  if (!trimmed) return [];
  const segs = trimmed.split(/\n[ \t]*\n+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length <= 1) return [trimmed];
  // 签名兜底：拆出的末段若只剩签名（🃏）——人格偶尔带签名，但它绝不该自成一条光秃秃的气泡。
  // 并回上一条（"…事？ 🃏"），而非单独发。结构兜底，不指望模型每次都不把签名另起一段（原则2）。
  if (segs.length > 1 && isSignatureOnly(segs[segs.length - 1])) {
    const sig = segs.pop();
    segs[segs.length - 1] = `${segs[segs.length - 1]} ${sig}`;
  }
  // 超上限：把多出的段【并进最后一条】，不再整条塌回。
  // 真机教训：旧逻辑"超上限就发一整条"会让 4-5 段的亲密长回复退化成一大长串（比多几条气泡更糟）。
  // 现在既封顶 ≤MAX 条（不刷屏），又永不退化成一整条长消息。
  if (segs.length > MAX_BUBBLES) {
    const head = segs.slice(0, MAX_BUBBLES - 1);
    const tail = segs.slice(MAX_BUBBLES - 1).join('\n\n');
    return [...head, tail];
  }
  return segs;
}

// 段落是否"只由签名 + 空白构成"（如 "🃏"、" 🃏 "）。精确匹配当前签名，
// 避免误并合法的单表情反应气泡（"哈哈"、"😂" 该独立成条时仍独立）。
function isSignatureOnly(s) {
  return new RegExp(`^[\\s${SIGNATURE}]*${SIGNATURE}[\\s${SIGNATURE}]*$`, 'u').test(s);
}

// 一轮就绪：逐条过 深思口令 / ESM 显式语法 fast-path（# 混在连发里也逐条识别，不再被合并吞掉）→ 剩余装配跑 agent。
export async function processTurn(senderId, items, deps) {
  const sessionId = _sess(senderId);
  const rest = [];
  for (const it of items) {
    // 语音=打字等价，转写文本同样过显式语法检查；图片描述、文件告知是机器产物，不过。
    if (it.kind !== 'image' && it.kind !== 'file') {
      // 深思口令 fast-path（DEEPTHINK_ENABLED 才在场；精确全等，# 快记同级的显式语法·原则11）。
      // 放 ESM 之前：pending 打卡在场时口令也绝不能被吞（07-26 ESM 吞命令事故的同款防线）。
      if (deepthinkEnabled()) {
        try {
          const dt = deepthinkIntercept(it.text);
          if (dt.handled) {
            if (dt.receipt && senderId) await deps.sendReceipt(senderId, dt.receipt);
            continue;
          }
        } catch (e) {
          console.error('[adapter:wecom] deepthink intercept failed, fall through: %s', e.message);
        }
      }
      try {
        const esm = await deps.esmInbound(it.text, sessionId);
        if (esm && esm.handled) {
          for (const r of esm.replies || []) if (r && senderId) await deps.sendReceipt(senderId, r);
          continue;
        }
      } catch (e) {
        // 拦截失败不能吞消息：记错误后落到 agent（宁可当普通聊天，也不丢主人的话）。
        console.error('[adapter:wecom] ESM intercept failed, fall through to agent: %s', e.message);
      }
    }
    rest.push(it);
  }
  // 深思状态推进（口令拦截之后：刚进入的态生效、过期的懒清理+提示、活跃的按本轮消息续期）。
  let deepthink = false;
  if (deepthinkEnabled()) {
    try {
      const st = deepthinkTurnState();
      if (st.expiredReceipt && senderId) await deps.sendReceipt(senderId, st.expiredReceipt);
      deepthink = st.active;
    } catch (e) {
      console.error('[adapter:wecom] deepthink state failed（按普通轮继续）: %s', e.message);
    }
  }
  const { llmText, rawUserText } = buildTurnInput(rest);
  if (!llmText) return;
  try {
    const reply = await deps.onMessage({ sessionId, userInput: llmText, rawUserInput: rawUserText, deepthink });
    // 对话层：agent 回复按模型标的空行拆成气泡，逐条依次连发（更像真人）。序号入 dedup（同轮相同气泡不被吞）。
    // 只拆这条 agent 回复；上面 ESM/媒体失败的协议层回执不经这里、保持确定性单条。
    // 深思轮每条气泡带 🧠 前缀（确定性出站标识，PLAN §2⑤；episodes 里的 reply 不带，记忆干净）。
    if (reply && senderId) {
      const mark = deepthink ? '🧠 ' : '';
      const bubbles = splitBubbles(reply);
      for (let i = 0; i < bubbles.length; i++) await deps.sendReceipt(senderId, mark + bubbles[i], i);
    }
  } catch (e) {
    console.error('[adapter:wecom] processTurn onMessage failed: %s', e.message);
  }
}

// 回复/回执的 dedup_hash 掺【分钟桶】（导出供 selftest 直测）。
// 为什么：outbox 行永不删除，纯内容 hash 会让同一段固定文案（"记下了 ✓"、"图片没收完整，再发一次？"）
// 终身只发得出第一次——协议层反馈从第二次起被 INSERT OR IGNORE 静默吞掉（审查发现1）。
// 分钟桶保留"同一分钟内意外重复入队（如 e云回调重投）只发一次"的短窗保护，跨轮次相同文案照常送达。
// idx=气泡序号：一条回复拆成多气泡时，同分钟内两条【内容相同】的气泡（如都回"好"）纯内容 hash 会撞
//   → 第二条被 INSERT OR IGNORE 静默吞掉。掺序号让同轮相同气泡各自入队；单条回执 idx=0 行为不变。
export function replyDedupHash(target, content, at = nowMs(), idx = 0) {
  const norm = ['wecom', String(target), String(content), 'm' + Math.floor(at / 60000), 'b' + idx]
    .map((p) => String(p ?? '').trim())
    .join(' ');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// 回调直发兜底：把 reply/气泡入 outbox（dedup_hash 见 replyDedupHash；idx=气泡序号，协议层回执默认 0）。
async function maybeReplyToOutbox(target, content, idx = 0) {
  try {
    enqueueOutbox({ channel: 'wecom', target, content, dedupHash: replyDedupHash(target, content, nowMs(), idx) });
  } catch (e) {
    console.error('[adapter:wecom] enqueue reply failed: %s', e.message);
  }
}

// 从企微回调 payload 里提取文本。兼容 e云企微 doApi 回调 与 官方企微 xml-json 两种常见结构。
function extractWecomText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  // e云企微：{ data: { content, msgType } } 或顶层 content
  if (payload.data && typeof payload.data.content === 'string' && (payload.data.msgType === 'text' || !payload.data.msgType)) {
    return payload.data.content;
  }
  if (typeof payload.content === 'string') return payload.content;
  // 官方企微：{ MsgType:'text', Content:'...' }
  if (payload.MsgType === 'text' && typeof payload.Content === 'string') return payload.Content;
  if (payload.Text && typeof payload.Text.Content === 'string') return payload.Text.Content;
  return '';
}

function extractWecomSender(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.data && (payload.data.fromId || payload.data.senderId)) return String(payload.data.fromId || payload.data.senderId);
  if (payload.FromUserName) return String(payload.FromUserName);
  if (payload.fromId || payload.senderId) return String(payload.fromId || payload.senderId);
  return '';
}

// =====================================================================
// --selftest：离线（ADAPTER_MOCK）验证 outbox 入队去重 + relay 真发只发一次。
// 不联网、不真发；用临时 db。断言风格 ok(cond,msg) 打 ✓/✗，结尾 PASS/FAIL 计数，退出码=fail?1:0。
// =====================================================================
async function selftest() {
  // 必须在 import db.mjs 前不可能改 env（top-level import 已固化），故 selftest 用临时 db 路径需提前设。
  // 这里假定运行命令已设 XW2_DB_PATH 指向 scratchpad 临时文件 + ADAPTER_MOCK=1（见文件头注释）。
  const { initDb } = await import('./db.mjs');
  initDb(); // 幂等建表
  ADAPTER_MOCK = true; // selftest 强制 mock：自包含、不真发、不依赖外部 env（与其它模块自检一致）

  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; console.log('  ✓ ' + msg); }
    else { fail++; console.log('  ✗ ' + msg); }
  };

  const { createHash } = await import('node:crypto');
  const dedup = (parts) => createHash('sha256').update(parts.map((p) => String(p ?? '').trim()).join(' ')).digest('hex').slice(0, 16);

  console.log('adapter selftest (ADAPTER_MOCK=%s)\n', ADAPTER_MOCK ? '1' : '0');
  ok(ADAPTER_MOCK, 'ADAPTER_MOCK=1 (selftest must not really send)');

  // 1) enqueueOutbox：首次入队 deduped=false，相同 hash 再入队 deduped=true。
  const h1 = dedup(['wecom', 'owner1', 'hello world', '']);
  const r1 = enqueueOutbox({ channel: 'wecom', target: 'owner1', content: 'hello world', dedupHash: h1 });
  ok(r1.deduped === false && r1.id, 'enqueueOutbox first insert (deduped=false, id set)');
  const r2 = enqueueOutbox({ channel: 'wecom', target: 'owner1', content: 'hello world', dedupHash: h1 });
  ok(r2.deduped === true, 'enqueueOutbox same dedup_hash → deduped=true (致命纪律①)');

  // 1b) Markdown 剥离（微信不渲染；07-31 早上 `**某客户**` 原样进了手机屏幕，人设叮嘱没管住）。
  ok(stripMarkdownForWecom('**某客户**（全逾期了）：') === '某客户（全逾期了）：', '剥加粗（07-31 实录形态）');
  ok(stripMarkdownForWecom('__重点__看这里') === '重点看这里', '剥加粗（下划线写法）');
  ok(stripMarkdownForWecom('## 今天安排\n正文') === '今天安排\n正文', '剥行首标题标记');
  ok(stripMarkdownForWecom('- 甲\n* 乙\n+ 丙') === '甲\n乙\n丙', '剥行首列表符');
  ok(stripMarkdownForWecom('```js\nconst a=1\n```') === 'const a=1\n', '剥代码围栏行（正文保留）');
  ok(stripMarkdownForWecom('跑 `npm test` 看看') === '跑 npm test 看看', '剥行内代码反引号');
  ok(stripMarkdownForWecom('#快记 这条不动') === '#快记 这条不动', '「#快记」不被当标题误剥（# 后无空格）');
  ok(stripMarkdownForWecom('挂了8天 —— 7/27截止') === '挂了8天 —— 7/27截止', '破折号/正常文字零改动');
  ok(stripMarkdownForWecom('```') === '```', '剥完只剩空白 → 退回原文（绝不发空消息）');

  // 2) relayOutbox：pending 只有 1 条（去重后），真发（mock）入 SENT 一次，行被标 sent。
  SENT.length = 0;
  const relayed = await relayOutbox();
  ok(relayed.sent === 1 && relayed.failed === 0, 'relayOutbox sent=1 failed=0');
  ok(SENT.length === 1 && SENT[0].content === 'hello world', 'sendWecom (mock) pushed exactly once → at-least-once+去重生效');

  // 3) 再 relay 一次：已 sent，无 pending，不重发。
  SENT.length = 0;
  const relayed2 = await relayOutbox();
  ok(relayed2.sent === 0 && SENT.length === 0, 'second relay sends nothing (status=sent, not re-sent)');

  // 4) 不同内容 → 不同 hash → 真发一次。
  const h2 = dedup(['wecom', 'owner1', 'second message', '']);
  enqueueOutbox({ channel: 'wecom', target: 'owner1', content: 'second message', dedupHash: h2 });
  SENT.length = 0;
  const relayed3 = await relayOutbox();
  ok(relayed3.sent === 1 && SENT.length === 1, 'distinct content → new hash → sent once');

  // 5) sendWecom mock 返回 ok:true 且入 SENT。
  SENT.length = 0;
  const sw = await sendWecom('owner1', 'direct', {});
  ok(sw.ok === true && SENT.length === 1, 'sendWecom mock returns ok and records SENT');

  // 5.5) 单飞闸：并发两个 relayOutbox 不重复发送（修双发竞态）。
  //   Promise.all 同时发起 A/B：A 先同步跑到首个 await sendWecom 置 _relaying，B 紧接着看到 _relaying 直接 skip。
  SENT.length = 0;
  enqueueOutbox({ channel: 'wecom', target: 'owner1', content: 'concA', dedupHash: dedup(['wecom', 'owner1', 'concA', '']) });
  enqueueOutbox({ channel: 'wecom', target: 'owner1', content: 'concB', dedupHash: dedup(['wecom', 'owner1', 'concB', '']) });
  const [ra, rb] = await Promise.all([relayOutbox(), relayOutbox()]);
  ok(SENT.length === 2, '并发 relay：两条各发一次（不是四次）—— 单飞闸消除跨定时器双发');
  ok(ra.skipped === true || rb.skipped === true, '并发其中一个 relay 被单飞闸跳过(skipped=true)');

  // 5.6) 剥离发生在唯一出口：落库即落"实际发出去的样子"（各调用方不用各自记得剥）。
  SENT.length = 0;
  const mdIn = '**甲**\n- 乙';
  enqueueOutbox({ channel: 'wecom', target: 'ownerMd', content: mdIn, dedupHash: dedup(['wecom', 'ownerMd', mdIn, '']) });
  await relayOutbox();
  ok(SENT.some((s) => s.target === 'ownerMd' && s.content === '甲\n乙'), 'enqueueOutbox 出口统一剥 Markdown（库里与屏幕上一致）');

  // 6) routeInbound：e云 data 数组路由 + 自环过滤 + owner 门禁 + msgType 分流。
  const got = { texts: [], media: [] };
  routeInbound(
    {
      data: [
        { cmd: 15000, msgType: 0, senderId: 'OWNER', userId: 'BOT', msgData: { content: '你好' } },
        { cmd: 15000, msgType: 0, senderId: 'BOT', userId: 'BOT', msgData: { content: '自己发的应跳过' } },
        { cmd: 15000, msgType: 7, senderId: 'OWNER', userId: 'BOT', msgData: { fileId: 'i' } },
        { cmd: 15000, msgType: 16, senderId: 'OWNER', userId: 'BOT', msgData: { fileId: 'v' } },
        { cmd: 15000, msgType: 0, senderId: 'STRANGER', userId: 'BOT', msgData: { content: '陌生人' } },
        { cmd: 11016, senderId: 'OWNER', userId: 'BOT', msgData: { code: 0 } },
      ],
    },
    {
      ownerId: 'OWNER',
      onText: (s, t) => got.texts.push([s, t]),
      onMedia: (s, d, k) => got.media.push([s, k]),
    },
  );
  ok(got.texts.length === 1 && got.texts[0][1] === '你好', 'routeInbound 只路由 OWNER 的一条文本');
  ok(got.media.some((m) => m[1] === 'image') && got.media.some((m) => m[1] === 'voice'), 'routeInbound 图片/语音分流到 onMedia');
  ok(!got.texts.some((t) => /自己发的|陌生人/.test(t[1])), 'routeInbound 跳过自环(senderId===userId)+非owner');

  // 7) buildTurnInput：装配纯函数（直通 / 时间事实 / 原话分离）
  const T0 = Date.UTC(2026, 6, 1, 6, 32, 5); // = 14:32:05 CST
  const single = buildTurnInput([{ at: T0, kind: 'text', text: '帮我看下日程' }]);
  ok(single.llmText === '帮我看下日程' && single.rawUserText === '帮我看下日程', 'buildTurnInput 单条文字原样直通（零脚手架，G 场景不变）');
  const singleVoice = buildTurnInput([{ at: T0, kind: 'voice', text: '睡得还行' }]);
  ok(singleVoice.llmText === '睡得还行' && singleVoice.rawUserText === '睡得还行', 'buildTurnInput 单条语音转写直通（打字等价，ESM 打卡行为不变）');
  const multi = buildTurnInput([
    { at: T0, kind: 'text', text: '帮我看看这个' },
    { at: T0 + 3000, kind: 'image', text: '一盘沙拉', mediaLogId: 41 },
    { at: T0 + 9000, kind: 'text', text: '中午吃这个够吗' },
  ]);
  ok(
    /【3 条连发消息/.test(multi.llmText) &&
    multi.llmText.includes('[14:32:05 文字] 帮我看看这个') &&
    multi.llmText.includes('[14:32:08 图片 media#41] 一盘沙拉') &&
    multi.llmText.includes('[14:32:14 文字] 中午吃这个够吗'),
    'buildTurnInput 多条带到达时刻/模态/顺序（CST，时序事实给模型判断）'
  );
  ok(multi.rawUserText === '帮我看看这个\n中午吃这个够吗', 'rawUserText=纯原话（文字+语音转写），不含图片描述——不可逆层不被脚手架污染');
  const imgOnly = buildTurnInput([{ at: T0, kind: 'image', text: '一张图', mediaLogId: 5 }]);
  ok(imgOnly.llmText === '[图片 media#5] 一张图' && imgOnly.rawUserText === '', '纯图轮 rawUserText=空串——顺 ?? 传到 ctx 触发 record_checkin 空守卫，机器产物进不了 esm_raw（审查发现4）');

  // 7.5) replyDedupHash 分钟桶：同分钟同 hash（短窗防重投），跨分钟不同 hash（固定文案回执不被终身 dedup 吞掉，审查发现1）
  const atA = Date.UTC(2026, 6, 2, 6, 0, 10);
  ok(replyDedupHash('owner1', '记下了 ✓', atA) === replyDedupHash('owner1', '记下了 ✓', atA + 20_000), 'replyDedupHash 同分钟同 hash（保留回调重投保护）');
  ok(replyDedupHash('owner1', '记下了 ✓', atA) !== replyDedupHash('owner1', '记下了 ✓', atA + 120_000), 'replyDedupHash 跨分钟不同 hash（固定回执跨轮次照常送达）');

  // 8) 装配层集成：文字连发攒成一轮 → onMessage 只跑一次、一条回复
  const calls = [];
  const receipts = [];
  const mkDeps = (over = {}) => ({
    debounceMs: 40,
    fenceMs: 200,
    processMedia: async () => ({ mediaLogId: 9, receipt: null, feedText: null, desc: 'mock图' }),
    esmInbound: async (text) => (text.startsWith('#') && text.slice(1).trim() ? { handled: true, replies: ['记下了 ✓'] } : { handled: false }),
    sendReceipt: async (t, c) => { receipts.push(c); },
    onMessage: async ({ sessionId, userInput, rawUserInput }) => { calls.push({ sessionId, userInput, rawUserInput }); return 'ok回复'; },
    ...over,
  });
  const deps8 = mkDeps();
  inboundText('S8', '第一条', deps8);
  inboundText('S8', '第二条', deps8);
  await new Promise((r) => setTimeout(r, 150));
  ok(calls.length === 1 && /第一条/.test(calls[0].userInput) && /第二条/.test(calls[0].userInput), '连发两条文字攒成一轮，onMessage 只跑一次');
  ok(/【2 条连发消息/.test(calls[0].userInput), '多条装配带时间结构头');
  ok(calls[0].rawUserInput === '第一条\n第二条', 'rawUserInput=纯原话透传');
  ok(receipts.includes('ok回复'), '一轮一条回复入 outbox');

  // 9) 下载栅栏：文字先到、图还在识别 → 窗口到仍扣住，图就位后同轮给模型（修竞态）
  calls.length = 0; receipts.length = 0;
  let resolveImg;
  const deps9 = mkDeps({ processMedia: () => new Promise((r) => { resolveImg = r; }) });
  inboundText('S9', '看看这个', deps9);
  inboundMedia('S9', { fileId: 'x' }, 'image', deps9);
  await new Promise((r) => setTimeout(r, 120)); // 窗口(40ms)已过，图未就位
  ok(calls.length === 0, '窗口到但媒体未就位 → 栅栏扣住不 flush（修"文字先跑 agent 看不到图"竞态）');
  resolveImg({ mediaLogId: 7, receipt: null, feedText: null, desc: '一碗牛肉面' });
  await new Promise((r) => setTimeout(r, 60));
  ok(calls.length === 1 && /牛肉面/.test(calls[0].userInput) && /看看这个/.test(calls[0].userInput), '媒体就位后一轮 flush：图描述与文字同轮');
  ok(!receipts.some((c) => /📷/.test(c)), '图片成功不再发独立 📷 回执（对话层边界）');

  // 10) 栅栏超时：媒体卡死不无限扣轮；迟到内容作为新一轮送达不丢
  calls.length = 0; receipts.length = 0;
  let resolveLate;
  const deps10 = mkDeps({ processMedia: () => new Promise((r) => { resolveLate = r; }) });
  inboundText('S10', '先说句话', deps10);
  inboundMedia('S10', { fileId: 'y' }, 'image', deps10);
  await new Promise((r) => setTimeout(r, 350)); // 窗口40 + 栅栏200 之后
  ok(calls.length === 1 && /先说句话/.test(calls[0].userInput), '栅栏超时 → 先 flush 已就位的（不无限等）');
  resolveLate({ mediaLogId: 8, receipt: null, feedText: null, desc: '迟到的图' });
  await new Promise((r) => setTimeout(r, 120));
  ok(calls.length === 2 && /迟到的图/.test(calls[1].userInput), '迟到媒体作为新一轮送达（内容不丢）');

  // 11) # 快记混在连发里逐条抽出（旧版 \n 合并后 # 被吞）
  calls.length = 0; receipts.length = 0;
  const deps11 = mkDeps();
  inboundText('S11', '#中午跑了5km', deps11);
  inboundText('S11', '对了明天提醒我带伞', deps11);
  await new Promise((r) => setTimeout(r, 150));
  ok(receipts.includes('记下了 ✓'), '# 快记逐条走确定性 fast-path（混在连发里不丢）');
  ok(calls.length === 1 && calls[0].userInput === '对了明天提醒我带伞', '剩余单条直通 agent（不带脚手架）');

  // 12) 轮次串行：上一轮处理中来的新消息排队为下一轮，回复顺序不乱、追发不丢
  calls.length = 0; receipts.length = 0;
  let releaseFirst;
  const deps12 = mkDeps({
    onMessage: async ({ userInput }) => {
      calls.push({ userInput });
      if (calls.length === 1) await new Promise((r) => { releaseFirst = r; });
      return 'r' + calls.length;
    },
  });
  inboundText('S12', '第一轮', deps12);
  await new Promise((r) => setTimeout(r, 80)); // 第一轮 flush，onMessage 挂起
  inboundText('S12', '第二轮', deps12);
  await new Promise((r) => setTimeout(r, 80)); // 第二轮窗口到，进串行链排队
  ok(calls.length === 1, '上一轮未完成时新一轮排队（同 sender 不并发跑 agent）');
  releaseFirst();
  await new Promise((r) => setTimeout(r, 80));
  ok(calls.length === 2 && calls[1].userInput === '第二轮', '第二轮在第一轮完成后按序跑（追发不丢、回复不乱序）');

  // 13) 媒体失败：协议层即时确定性回执，不进装配轮
  calls.length = 0; receipts.length = 0;
  const deps13 = mkDeps({ processMedia: async () => ({ mediaLogId: null, receipt: '图片没收完整，再发一次？', feedText: null, desc: null }) });
  inboundMedia('S13', {}, 'image', deps13);
  await new Promise((r) => setTimeout(r, 150));
  ok(receipts.includes('图片没收完整，再发一次？'), '媒体失败 → 协议层即时回执（不等栅栏）');
  ok(calls.length === 0, '失败媒体不进装配轮（不产生空 agent 轮）');

  // 14) 栅栏是硬上限：用户持续说话不延长媒体等待（deadline 首次进入等待即定死，审查发现5）
  calls.length = 0; receipts.length = 0;
  const deps14 = mkDeps({ debounceMs: 50, fenceMs: 150, processMedia: () => new Promise(() => {}) }); // 媒体永不就位
  inboundText('S14', '开头', deps14);
  inboundMedia('S14', { fileId: 'z' }, 'image', deps14);
  await new Promise((r) => setTimeout(r, 120)); // 窗口50ms已到 → 栅栏 deadline≈t50+150=t200 定死
  inboundText('S14', '还在说', deps14);         // 窗口重置（未修复版会把栅栏重新起算到 ~t320）
  await new Promise((r) => setTimeout(r, 150)); // 现在 ≈t270：deadline t200 已过 → 必须已 flush
  ok(calls.length === 1 && /开头/.test(calls[0].userInput) && /还在说/.test(calls[0].userInput),
     '栅栏硬上限：窗口重置不延长媒体等待，超时照 flush 已就位的两条文字');

  // 15) splitBubbles 纯函数：单段直通 / 空行拆多条 / 超上限不拆 / 单换行不拆 / 各段 trim
  ok(JSON.stringify(splitBubbles('就一句话')) === JSON.stringify(['就一句话']), 'splitBubbles 单段→一条（日常单发零变化）');
  const two = splitBubbles('懂了\n\n这就去办');
  ok(two.length === 2 && two[0] === '懂了' && two[1] === '这就去办', 'splitBubbles 空行→拆两条并各自 trim');
  ok(splitBubbles('a\n\nb\n\nc\n\nd').length === 4, 'splitBubbles 4 段 ≤ MAX(5) → 拆 4 条（不再塌成一整条·真机教训）');
  const over = splitBubbles('a\n\nb\n\nc\n\nd\n\ne\n\nf'); // 6 段 > MAX(5)
  ok(over.length === 5 && over[4] === 'e\n\nf', 'splitBubbles 段数>MAX → 封顶 5 条、多出的并进最后一条（永不退化成大长串）');
  ok(splitBubbles('1. 甲\n2. 乙\n3. 丙').length === 1, 'splitBubbles 单换行列表不拆（只按空行拆）');
  ok(splitBubbles('连贯一段\n软换行同一句').length === 1, 'splitBubbles 连贯段落里的软换行不拆');
  ok(splitBubbles('   ').length === 0, 'splitBubbles 纯空白→空数组（不发空气泡）');
  ok(splitBubbles('甲\n \n乙').length === 2, 'splitBubbles 空行含空格也算断点');
  // 签名兜底：末段只剩🃏 → 并回上一条，绝不单独成泡（治真机暴露的"光秃秃一个🃏"问题）
  ok(JSON.stringify(splitBubbles('身体累就早点睡\n\n🃏')) === JSON.stringify(['身体累就早点睡 🃏']), 'splitBubbles 末段只剩签名🃏→并回上一条（不单独成泡）');
  const sig3 = splitBubbles('周四晚上\n\n早点睡别硬撑\n\n🃏');
  ok(sig3.length === 2 && sig3[1] === '早点睡别硬撑 🃏', 'splitBubbles 三段末尾签名→并回，实发两条');
  ok(splitBubbles('哈哈\n\n😂').length === 2 && splitBubbles('哈哈\n\n😂')[1] === '😂', 'splitBubbles 合法单表情反应(😂)不被当签名并掉');

  // 16) processTurn：多段 agent 回复拆成多条依次连发（对话层）；单段回复仍一条（G 场景不变）
  calls.length = 0; receipts.length = 0;
  const deps16 = mkDeps({ onMessage: async () => '懂了\n\n这就去办' });
  inboundText('S16', '帮我弄下', deps16);
  await new Promise((r) => setTimeout(r, 150));
  ok(receipts.length === 2 && receipts[0] === '懂了' && receipts[1] === '这就去办', 'processTurn 空行回复→拆两条依次连发（对话层更像人）');
  calls.length = 0; receipts.length = 0;
  const deps16b = mkDeps({ onMessage: async () => '就回一句' });
  inboundText('S16b', '在吗', deps16b);
  await new Promise((r) => setTimeout(r, 150));
  ok(receipts.length === 1 && receipts[0] === '就回一句', 'processTurn 单段回复仍一条（日常单发零变化）');

  // 16.5) 深思口令 fast-path（env 开关惰性读 → selftest 可切换；测完清 env 保证后续用例零影响）
  {
    const dt = await import('./deepthink.mjs');
    process.env.DEEPTHINK_ENABLED = '1';
    process.env.DEEPTHINK_ENTER = '小王变身';
    process.env.DEEPTHINK_EXIT = '小王下班';
    const dtCalls = [];
    const dtReceipts = [];
    const depsDT = mkDeps({
      sendReceipt: async (t, c) => { dtReceipts.push(c); },
      onMessage: async ({ userInput, deepthink }) => { dtCalls.push({ userInput, deepthink }); return '深思后的回答'; },
    });
    inboundText('S18', '小王变身', depsDT);
    await new Promise((r) => setTimeout(r, 150));
    ok(dtCalls.length === 0 && dtReceipts.length === 1 && dtReceipts[0] === dt.RECEIPT_ENTER, '深思口令被 fast-path 消费：变身回执、不进 agent');
    inboundText('S18', '帮我想个大问题', depsDT);
    await new Promise((r) => setTimeout(r, 150));
    ok(dtCalls.length === 1 && dtCalls[0].deepthink === true, '深思态内消息：onMessage 收到 deepthink=true');
    ok(dtReceipts.length === 2 && dtReceipts[1] === '🧠 深思后的回答', '深思轮回复气泡带 🧠 前缀（确定性出站标识）');
    inboundText('S18', '小王下班', depsDT);
    await new Promise((r) => setTimeout(r, 150));
    ok(dtReceipts.length === 3 && dtReceipts[2] === dt.RECEIPT_EXIT, '退出口令：复原回执');
    inboundText('S18', '现在随便聊', depsDT);
    await new Promise((r) => setTimeout(r, 150));
    ok(dtCalls.length === 2 && dtCalls[1].deepthink === false && dtReceipts[3] === '深思后的回答', '退出后：deepthink=false、无 🧠 前缀');
    delete process.env.DEEPTHINK_ENABLED;
    inboundText('S18', '小王变身', depsDT);
    await new Promise((r) => setTimeout(r, 150));
    ok(dtCalls.length === 3 && dtCalls[2].deepthink === false && dtCalls[2].userInput === '小王变身', '未开启实例（朋友形态）：口令当普通消息进 agent，零拦截');
    delete process.env.DEEPTHINK_ENTER;
    delete process.env.DEEPTHINK_EXIT;
  }

  // 17) 拆气泡 dedup 掺序号：同分钟同内容不同序号→不同 hash → 同轮相同气泡各自真发（不被 INSERT OR IGNORE 吞）
  const at17 = Date.UTC(2026, 6, 2, 8, 0, 0);
  ok(replyDedupHash('o', '好', at17, 0) !== replyDedupHash('o', '好', at17, 1), 'replyDedupHash 掺气泡序号：同内容不同序号→不同 hash');
  ok(replyDedupHash('o', '好', at17, 0) === replyDedupHash('o', '好', at17 + 20_000, 0), 'replyDedupHash 同序号同分钟仍同 hash（回调重投保护不变）');
  SENT.length = 0;
  enqueueOutbox({ channel: 'wecom', target: 'o17', content: '好', dedupHash: replyDedupHash('o17', '好', at17, 0) });
  enqueueOutbox({ channel: 'wecom', target: 'o17', content: '好', dedupHash: replyDedupHash('o17', '好', at17, 1) });
  await relayOutbox();
  ok(SENT.filter((s) => s.target === 'o17' && s.content === '好').length === 2, '同轮两条相同气泡"好"靠序号各自发出（相同内容不被去重吞掉）');

  // 18) 语音出站口语化（forSpeech）：markdown/表情/链接是给眼睛的，念出来是噪音
  ok(forSpeech('好的🃏') === '好的', 'forSpeech 去签名表情');
  ok(forSpeech('**重点**是这样') === '重点是这样', 'forSpeech 去 markdown 强调');
  ok(forSpeech('- 第一条\n- 第二条') === '第一条 第二条', 'forSpeech 列表折成一句');
  ok(forSpeech('看这个 https://a.b/c?d=1 吧') === '看这个 链接我发你微信 吧', 'forSpeech 裸链接不念 URL');
  ok(forSpeech('见[面板](https://x.y/z)') === '见面板', 'forSpeech markdown 链接只留文字');
  ok(forSpeech(null) === '' && forSpeech(undefined) === '', 'forSpeech 空输入不崩');

  // 18.5) 流式分句（语音）：攒够一句才交出去，且每句出门都过 forSpeech
  {
    const got = [];
    const f = createSentenceFlusher((s) => got.push(s));
    f.push('好的');
    ok(got.length === 0, 'sentenceFlusher 半句不吐（TTS 吃半句会断得难听）');
    f.push('，这就去办。剩下的');
    ok(got.length === 1 && got[0] === '好的，这就去办。', 'sentenceFlusher 见句号才切一句');
    f.flush();
    ok(got.length === 2 && got[1] === '剩下的', 'sentenceFlusher flush 吐出尾巴');

    const got2 = [];
    const f2 = createSentenceFlusher((s) => got2.push(s));
    f2.push('**加粗**要去掉🃏');
    f2.flush();
    ok(got2[0] === '加粗要去掉', 'sentenceFlusher 每句都过 forSpeech');

    const got3 = [];
    const f3 = createSentenceFlusher((s) => got3.push(s));
    f3.push('一二三四五六七八九十，' + '一二三四五六七八九十'.repeat(4) + '，后面还有');
    ok(got3.length === 2 && got3[0] === '一二三四五六七八九十，', '首句短闸：14 字就在逗号处切，先出声');
    ok(got3[1].endsWith('，') && got3[1].length > 20, '后续句攒长一点（40 字闸）再切');

    const got4 = [];
    const f4 = createSentenceFlusher((s) => got4.push(s));
    f4.push('我先查一下');
    f4.discard();
    f4.flush();
    ok(got4.length === 0, 'sentenceFlusher discard 丢掉没念的（这轮改调工具了）');
  }

  // 19) 语音轮与微信轮共用 senderId 串行闸：不并发跑两个 agentic（episodes 不交错）
  {
    const order = [];
    const slow = (tag, ms) => () => new Promise((r) => setTimeout(() => { order.push(tag); r(tag); }, ms));
    const p1 = chainTurn('S19', slow('a', 60));
    const p2 = chainTurn('S19', slow('b', 10)); // 更快但排在后面 → 必须等 a 跑完
    ok((await p1) === 'a' && (await p2) === 'b', 'chainTurn 各自拿回自己的结果');
    ok(order.join('') === 'ab', 'chainTurn 串行：后来的轮等前一轮跑完');
    const p3 = chainTurn('S19b', () => Promise.reject(new Error('boom')));
    await p3.catch(() => {});
    ok((await chainTurn('S19b', async () => 'next')) === 'next', 'chainTurn 上一轮失败不卡死后续轮');
  }

  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

// CLI 入口（契约：import.meta.url === pathToFileURL(process.argv[1]).href）。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    // 直接运行 adapter.mjs（无 main 编排）= 起一个最小 CLI adapter，回声 onMessage 不接 loop。
    // 真实部署由 main.mjs startAdapter 注入 onMessage=handleIncoming。
    console.error('[adapter] standalone CLI echo mode (no loop). use main.mjs for full agent.');
    startAdapter('cli', {
      onMessage: async ({ userInput }) => `echo: ${userInput}`,
    });
  }
}
