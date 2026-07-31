// loop.mjs —— 手写 agentic 工具循环（while），小王的"思考-调工具-回灌-再思考"主循环。
//
// 致命纪律③：LLM 调用全在 db 事务外。本循环只编排"组上下文→chatCompletion→callTool→回灌"，
//   chatCompletion 经 callWithResilience 走纯 fetch（带 timeout），绝不在 tx() 里跑。
// 工具调用经 tools.callTool（致命纪律①的统一 wrapper），副作用去重在那里发生。
// 护栏（自愈原则）：maxTurns20 + wallclock180s + no-progress（相同 tool+params hash 连续 2 次）。
//   崩溃恢复靠 worker 整体重跑 + outbox dedup_hash，这里只防"单次循环跑飞/打转烧 token"。

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { nowMs } from './db.mjs';
import { chatCompletion, callWithResilience } from './llm.mjs';
import { TOOLS, toOpenAITools, callTool } from './tools.mjs';
import { buildSystemPrompt, buildMessages, fmtNowZh } from './prompt.mjs';
import { appendEpisode } from './memory.mjs';

// ---- 护栏常量（契约：阈值不散落，集中导出） ----
export const GUARDS = {
  maxTurns: 20, // 单次循环最多 20 轮 LLM 往返
  wallclockMs: 180000, // 墙钟 180s 上限（防卡死/慢 provider 拖垮）
  noProgressRepeats: 2, // 相同 (tool_name+params) 连续 2 次即判打转
};

const RENDERED_TOOLS = toOpenAITools(TOOLS);

// 工具调用指纹：tool_name + 规范化 params 的 hash，用于 no-progress 检测。
function toolCallFingerprint(name, argsRaw) {
  let normArgs = '';
  try {
    // 规范化：把 JSON 解析再排序键序列化，避免键顺序/空白造成"看似不同实则同"
    const obj = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : argsRaw || {};
    normArgs = JSON.stringify(sortKeys(obj));
  } catch {
    normArgs = String(argsRaw ?? '');
  }
  return createHash('sha256').update(`${name}\0${normArgs}`).digest('hex').slice(0, 16);
}

function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return o;
}

// ---- runAgentic：单次完整 agentic 循环 ----
// 返回 { reply, turns, stopReason }。stopReason ∈ 'done'|'max_turns'|'wallclock'|'no_progress'|'error'。
export async function runAgentic({
  taskId = null,
  sessionId = null,
  userInput,
  rawUserInput = null, // 主人的纯原话（成串装配时与 userInput 分离；null=二者相同；''=纯媒体轮无原话，让 record_checkin 空守卫生效）
  history = [],
  summary = '',
  anchors = [],
  recalled = [],
  recallWeak = false,
  pendingCheckin = null,
  sinceLastMs = null, // 距上一轮对话的间隔（assembleContext 算好传入）：进 system「现在」段，治轮间时间盲
  filesLedger = '', // 沙箱文件台账（assembleContext 读 FILES.md 传入）：索引层每轮在场，正文靠 read_file 按需拉
  todayTodos = [], // 今日待办摘要（assembleContext 从面板表生成）：常驻指针，详情靠 todo_list 拉；取代旧"周待办"死锚点
  deepthink = false, // 深思模式（口令态，PLAN_DEEPTHINK）：走思考态深思队伍 + 思维链逐轮回传（T6 正面解决）
  voice = false, // 语音轮（Jetson 语音入口）：只改 system 段的表达约束（口语/短/无 markdown），模型/护栏不变
  onDelta = null, // 逐 token 回调（语音流式）：透传给 llm 层，每一轮都挂——最后那轮无工具的文本才是要念的
}) {
  const startedAt = nowMs();
  // 深思态单轮 5-15s 常态 × 多工具轮，墙钟单独放宽（env 可调）；普通轮护栏不动。
  const wallclockMs = deepthink
    ? Math.max(GUARDS.wallclockMs, parseInt(process.env.DEEPTHINK_WALLCLOCK_MS || '360000', 10) || 360000)
    : GUARDS.wallclockMs;

  // 上下文由 context.assembleContext 在上游组好（top-k 注入，绝不整份塞库——原则8），这里直接用、不再自查库。
  // system 段在循环【外】一次构建：单次 runAgentic 内 anchors/summary/recalled 冻结，
  // 移出 while 避免每轮重传同一块（3Mbps 上是真延迟），也让 system 前缀稳定 → provider context caching 可命中。
  const system = buildSystemPrompt({ anchors, summary, recalled, recallWeak, pendingCheckin, now: nowMs(), sinceLastMs, filesLedger, todayTodos, deepthink, voice });

  // working 上下文：从逐字近窗 history 起步，循环内 append 每轮的 assistant/tool 消息。
  // 注意 working 不落库（durable 状态在 tasks/steps/outbox），这里只是内存消息栈。
  const working = Array.isArray(history) ? [...history] : [];

  // 当前轮的用户输入只在第一轮注入（后续轮靠 working 里的 tool 结果驱动）。
  // 〔此刻…〕时间戳钉在当前消息上（仅 API 视图，不进 episodes/esm_raw）：实测 system 末尾的
  // 「# 现在」段会被近窗里模型自己说过的旧时间压过（错答一次即自我固化）——紧贴问题的时间戳
  // 是最高显著性位置，结构性防沿用（原则2：不指望模型自觉跨长距离对齐权威时间）。
  const nowStamp = `〔此刻 ${fmtNowZh(nowMs())}〕\n`;
  let pendingUserInput = userInput != null && userInput !== '' ? nowStamp + userInput : userInput;

  // ctx 带 userInput：record_checkin 这类工具要拿"用户这条真实原话"做不可逆登记（不信任模型复述）。
  // 成串消息时模型看的是带时间脚手架的装配文本（userInput），不可逆层只认纯原话（rawUserInput）。
  const ctx = { taskId, sessionId, userInput: rawUserInput ?? userInput };
  let lastFingerprint = null;
  let repeatCount = 0;
  let stopReason = 'done';
  let reply = '';
  let turns = 0;
  // 「口头完成 vs 实际动作」一致性（原则11·执行回灌：杜绝"说做了其实没做"）。
  // 线上实证：deepseek 对"把X设回来"直接回"设好了"、整轮零工具调用、库里什么都没变。
  // sideEffectDone=本次 runAgentic 内是否有成功的副作用工具；actionNudged=Nudge 只打一次防打转。
  // "这句算不算声称完成"由 claimsCompletedAction 判（模型判，非词表——见该函数注释）。
  let sideEffectDone = false;
  let actionNudged = false;

  while (true) {
    // ---- 护栏 1：轮数 ----
    if (turns >= GUARDS.maxTurns) {
      stopReason = 'max_turns';
      console.warn('[loop] 触发 maxTurns(%d) 终止', GUARDS.maxTurns);
      break;
    }
    // ---- 护栏 2：墙钟 ----
    if (nowMs() - startedAt > wallclockMs) {
      stopReason = 'wallclock';
      console.warn('[loop] 触发 wallclock(%dms) 终止', wallclockMs);
      break;
    }

    // 组上下文：system 段已在循环外构建一次（本轮冻结），这里只拼 messages（working 每轮增长）。
    const messages = buildMessages({
      system,
      history: working,
      userInput: turns === 0 ? pendingUserInput : null,
    });
    // 第一轮的 userInput 一旦进了 messages，就并入 working，后续轮不再单独注入。
    if (turns === 0 && pendingUserInput != null && pendingUserInput !== '') {
      working.push({ role: 'user', content: String(pendingUserInput) });
      pendingUserInput = null;
    }

    // ---- LLM 调用（致命纪律③：tx 外；带 timeout + 弹性重试 + provider fallback） ----
    let resp;
    try {
      // 墙钟剩余时间做为本次调用的外层 signal，避免单次 LLM 超 wallclock。
      const remain = wallclockMs - (nowMs() - startedAt);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(new Error('wallclock')), Math.max(1, remain));
      try {
        resp = await callWithResilience(
          ({ provider }) =>
            chatCompletion({
              messages,
              tools: RENDERED_TOOLS,
              signal: ac.signal,
              _provider: provider,
              onDelta, // 语音轮逐字吐给音箱；非语音轮为 null = 今天的行为
              // 深思分支：思考态 + 深思队伍 + 承诺回传思维链（working 里的 assistant 消息带 reasoning）。
              ...(deepthink ? { thinking: 'on', profile: 'deep', reasoningCarried: true } : {}),
            }),
          deepthink ? { profile: 'deep' } : undefined,
        );
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      // 墙钟 signal 主动中止 LLM ≠ "出错"。区分开：被墙钟砍断走 wallclock 兜底文案，别对子淇说"内部出错"。
      const aborted = /wallclock|aborted/i.test(err.message || '');
      stopReason = aborted ? 'wallclock' : 'error';
      reply = aborted ? '' : `（小王内部出错：${err.message}）`;
      console.error('[loop] LLM 调用%s: %s', aborted ? '被墙钟中止' : '最终失败', err.message);
      break;
    }

    turns++;
    const toolCalls = resp.toolCalls || [];
    // 深思轮证据日志（E2E 验收口：reasoning 真实非空 + 用的哪个模型）。思维链只进 working（API 视图），
    // 绝不落 episodes（记忆只留结论——与 Nudge 不落 episodes 同一纪律，PLAN §2③）。
    if (deepthink) {
      console.log('[loop] 深思轮 turn=%d model=%s provider=%s reasoning=%d字 toolCalls=%d', turns, resp.model, resp.provider, (resp.reasoning || '').length, toolCalls.length);
    }
    // 深思模式下 assistant 消息统一携带本轮思维链：下一轮翻译层译成 thinking block 回传（T6 契约）。
    const carry = deepthink && resp.reasoning ? { reasoning: resp.reasoning } : {};

    // ---- 无 tool_call：把 content 作为最终 reply 终止 ----
    if (toolCalls.length === 0) {
      const content = resp.content || '';
      // 一致性 Nudge：整轮没有任何成功的副作用工具调用、回复却声称"已完成操作"→ 不放行，
      // 回灌一条系统检查逼它二选一：真调工具执行，或改口说实情。只打一次（防打转），
      // Nudge 消息只进本轮 API 视图（working），不落 episodes——主人和记忆都看不到。
      if (!sideEffectDone && !actionNudged && (await claimsCompletedAction(content))) {
        actionNudged = true;
        console.warn('[loop] 一致性 Nudge：回复声称已完成但本轮零副作用工具调用，回灌自查');
        working.push({ role: 'assistant', content, ...carry });
        working.push({
          role: 'user',
          content: '【系统一致性检查（主人看不到这条）】你上一条回复声称操作已完成，但这一轮你没有调用任何工具，实际什么都没发生。若这件事需要真的执行（设/改/取消提醒、记录事项等），现在就调用对应工具执行完再回复；若不需要执行或做不到，就重新回复实情，不要声称已完成。',
        });
        continue;
      }
      reply = content;
      stopReason = 'done';
      // 记 assistant 终态到 working（episodes 由 main.handleIncoming 负责落，循环内不重复落）
      working.push({ role: 'assistant', content: reply, ...carry });
      break;
    }

    // ---- 有 tool_call：先把 assistant 的 tool_calls 消息入栈（OpenAI 协议要求） ----
    working.push({
      role: 'assistant',
      content: resp.content || null,
      tool_calls: toolCalls,
      ...carry,
    });

    // no-progress 检测用第一个 tool_call 的指纹（多工具同轮则用整批拼一起）
    const batchFp = toolCalls
      .map((tc) => toolCallFingerprint(tc.function?.name, tc.function?.arguments))
      .join('|');
    if (batchFp === lastFingerprint) {
      repeatCount++;
      if (repeatCount >= GUARDS.noProgressRepeats) {
        stopReason = 'no_progress';
        console.warn('[loop] 触发 no-progress（相同工具调用重复 %d 次）终止', GUARDS.noProgressRepeats);
        // 给 LLM 一个收尾机会：回灌一条提示后不再循环
        reply = resp.content || '（小王在重复同一个动作，已停止避免空转。）';
        break;
      }
    } else {
      lastFingerprint = batchFp;
      repeatCount = 0;
    }

    // ---- 逐个执行 tool_call，结果以 role:'tool' 回灌 ----
    let terminalHit = false;
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (e) {
        // 参数 JSON 坏掉：回灌错误让 LLM 重试，不崩循环
        working.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `参数 JSON 解析失败: ${e.message}` }),
        });
        // 记到 episodes 供回溯
        safeEpisode({ sessionId, role: 'tool', content: `${name} 参数解析失败`, taskId });
        continue;
      }

      // 致命纪律①：经统一 wrapper callTool（内部算 dedup/过黑名单/包异常）
      const out = await callTool(name, args, ctx);
      if (out.ok && TOOLS.find((t) => t.name === name)?.sideEffect) sideEffectDone = true; // 一致性 Nudge 的事实基准
      const payload = out.ok
        ? { ok: true, deduped: out.deduped === true, result: out.result }
        : { ok: false, error: out.error };

      working.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(payload).slice(0, 8192), // 截断防塞爆上下文
      });

      // 工具结果落 episodes（只追加，供后续召回）
      safeEpisode({
        sessionId,
        role: 'tool',
        content: `${name} → ${out.ok ? 'ok' : 'err:' + out.error}`,
        entity: name,
        taskId,
      });

      // 终止工具（如 record_checkin）：用它的固定中性回执作为最终 reply，丢弃模型本轮自由发挥，立即收尾。
      // 这是 ESM 红线"只问不评"的结构性最后一道闸——不寄望模型自觉不解读（原则2/3/11）。
      if (out.ok && out.result && out.result.terminal) {
        reply = String(out.result.reply ?? '');
        stopReason = 'done';
        terminalHit = true;
        break;
      }
    }
    if (terminalHit) break; // 终止工具触发 → 跳出 while，不再请求 LLM
    // 回到 while 顶，带着 tool 结果再请求一轮
  }

  // 护栏终止（轮数/墙钟/被砍）且没产出文本时，给子淇一个可读兜底，而不是发空消息或"内部出错"。
  // 这是"长任务处理得好"的体验保障：复杂任务超时被截断，也要有意义地交代，而非静默或报错。
  if ((!reply || !reply.trim()) && (stopReason === 'wallclock' || stopReason === 'max_turns' || stopReason === 'no_progress')) {
    reply = '这个事情有点复杂，我处理到一半先停下了。你要我接着弄哪一部分，或者拆成更小的步骤我再来？';
  }

  return { reply, turns, stopReason };
}

// ---------------------------------------------------------------------
// claimsCompletedAction —— 一致性 Nudge 的判定闸：这条回复有没有声称"某个动作已经完成"？
//
// 为什么是模型判、不是词表判（原则11 的分工，也是这个函数存在的全部理由）：
//   旧实现是一张手写正则（"设好了|已取消|记下了…"）。2026-07-27 实录：主人连说三件事交付了、
//   一件事改期，小王四次回"划掉了""帮你推到8/6"、四次零工具调用——**四次全部漏网**，待办库
//   从建表起 8 天没有一条完成记录，直到 07-31 早上照着陈旧的库报出"10件事全逾期"。
//   漏的不是"少写了一个词"，是"靠列词形去覆盖自然语言"这个做法本身不成立（语言无穷、枚举不完）。
//   所以：**模糊的那半（这句话算不算声称完成）交给模型，harness 只给硬事实（这轮实际执行了什么）**。
//   代价是零副作用轮多一次小调用；换来的是覆盖从十几个词变成任何说法、任何语气、任何语言。
//
// 判定偏向：拿不准 → YES（宁可多打一次 Nudge 让它自证，也不放过一次谎报）。
// 失败一律放行（fail-open）：判定器超时/报错/答非所问，绝不能挡住主人的消息——安全网坏了
// 只是回到没有安全网，不能变成消息发不出去。
// ---------------------------------------------------------------------
const JUDGE_TIMEOUT_MS = 10000; // 安全网不配拖慢正常回复：单次判定超此即放行
const JUDGE_SYS = '你是一致性判定器。只输出 YES 或 NO 一个词，不要解释、不要标点。';
const JUDGE_ASK = (content) => `下面这条回复，是一个 AI 助理刚写给主人的。事实：它这一轮【没有调用任何工具，实际什么都没发生】。

判断：这条回复有没有声称（或让主人以为）某件需要真正动手才会生效的事**已经做完或已经安排上了**？
这类事包括但不限于：改待办清单（完成/划掉/改期/新增）、排或取消提醒与定时任务、登记记录、发出消息、写文件、改设置。
只是发表看法、回答问题、闲聊、反问、或说"接下来去做/你要不要我做"——都算 NO。
拿不准就答 YES。

回复原文：
<<<
${content}
>>>`;

async function claimsCompletedAction(content) {
  const text = String(content ?? '').trim();
  if (!text) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('judge timeout')), JUDGE_TIMEOUT_MS);
  try {
    const r = await chatCompletion({
      messages: [
        { role: 'system', content: JUDGE_SYS },
        { role: 'user', content: JUDGE_ASK(text.slice(0, 2000)) },
      ],
      tools: null,
      temperature: 0,
      signal: ac.signal,
    });
    const a = String(r.content ?? '').trim().toUpperCase();
    return /\bYES\b/.test(a) || a.startsWith('YES');
  } catch (e) {
    console.warn('[loop] 一致性判定失败(放行): %s', e.message);
    return false; // fail-open：判定器不可用 ≠ 拦住主人的消息
  } finally {
    clearTimeout(timer);
  }
}

// episodes 落库失败不能拖垮循环（失败要响但降级）
function safeEpisode(args) {
  try {
    appendEpisode(args);
  } catch (e) {
    console.error('[loop] appendEpisode 失败(忽略): %s', e.message);
  }
}

// ---- 自检：mock LLM 驱动一次 tool_call→回灌→终止 + 护栏 ----
// 依赖真实 db/memory/tools，故需临时 db。参照 main.mjs 的 selftest 结构，但这里只测循环本身。
const IS_MAIN =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (process.argv.includes('--selftest') && IS_MAIN) {
  (async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // 用临时 db（WAL 不支持 :memory:，故用临时文件）
    const tmp = mkdtempSync(join(tmpdir(), 'xw2loop-'));
    process.env.XW2_DB_PATH = join(tmp, 'v2.db');
    process.env.XW2_SANDBOX_DIR = join(tmp, 'ws');
    process.env.LLM_MOCK = '1'; // 强制离线
    process.env.ADAPTER_MOCK = '1';

    // 必须在设置 env 后才 import 这些模块（它们读 env 初始化）
    const { initDb } = await import('./db.mjs');
    const llm = await import('./llm.mjs');
    initDb();

    let pass = 0,
      fail = 0;
    const ok = (c, m) => {
      console.log(`  ${c ? '✓' : '✗'} ${m}`);
      c ? pass++ : fail++;
    };
    console.log('loop.mjs selftest (mock LLM + 临时 db)\n');

    // 一致性判定是一次独立的小 LLM 调用（见 claimsCompletedAction）：mock 里必须先认出来单独作答，
    // 否则它会混进主循环的脚本、污染 mockTurn/deepReqs 这类断言基准。
    const isJudge = (req) => req.messages.some((m) => m.role === 'system' && /一致性判定器/.test(String(m.content ?? '')));

    // 脚本化 mock：第1轮发 memory_search tool_call，第2轮（看到 tool 结果后）给最终回复。
    let mockTurn = 0;
    let firstReqUserMsg = null; // 捕获第一轮请求里的当前 user 消息（验〔此刻…〕时间戳注入）
    llm.setMockHandler((req) => {
      if (isJudge(req)) return { content: 'NO', toolCalls: [] };
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        mockTurn++;
        firstReqUserMsg = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? null;
        return {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'memory_search', arguments: JSON.stringify({ query: 'test' }) },
            },
          ],
        };
      }
      return { content: '查完了，这是最终回复。', toolCalls: [] };
    });

    const r1 = await runAgentic({ sessionId: 's1', userInput: '帮我查点东西' });
    ok(r1.stopReason === 'done', '正常路径 stopReason=done');
    ok(r1.reply === '查完了，这是最终回复。', '工具回灌后拿到最终 reply');
    ok(r1.turns === 2, '走了 2 轮（1 工具 + 1 终态）');
    ok(
      typeof firstReqUserMsg === 'string' && /^〔此刻 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（周[日一二三四五六]）〕\n帮我查点东西$/.test(firstReqUserMsg),
      '当前 user 消息带〔此刻…〕时间戳（仅 API 视图，防模型沿用历史旧时间）',
    );

    // no-progress：mock 永远发同一个 tool_call → 应在重复 noProgressRepeats 次后停。
    llm.setMockHandler(() => ({
      content: '',
      toolCalls: [
        {
          id: 'cX',
          type: 'function',
          function: { name: 'memory_search', arguments: JSON.stringify({ query: 'loop' }) },
        },
      ],
    }));
    const r2 = await runAgentic({ sessionId: 's2', userInput: '空转测试' });
    ok(r2.stopReason === 'no_progress', '相同工具重复触发 no_progress 终止');
    ok(r2.turns <= GUARDS.maxTurns, 'no_progress 在 maxTurns 之前就停');

    // max_turns：mock 每轮发"不同 args"的 tool_call（避开 no-progress），应撞 maxTurns。
    let n = 0;
    llm.setMockHandler(() => ({
      content: '',
      toolCalls: [
        {
          id: 'cm' + n,
          type: 'function',
          function: { name: 'memory_search', arguments: JSON.stringify({ query: 'q' + n++ }) },
        },
      ],
    }));
    const r3 = await runAgentic({ sessionId: 's3', userInput: '撞墙测试' });
    ok(r3.stopReason === 'max_turns' && r3.turns === GUARDS.maxTurns, 'maxTurns 护栏生效');
    ok(r3.reply && r3.reply.trim().length > 0, 'maxTurns 终止也给可读兜底文案（不发空消息）');

    // 坏参数 JSON：回灌错误不崩；mock 第二轮收尾。
    let badTurn = 0;
    llm.setMockHandler((req) => {
      if (isJudge(req)) return { content: 'NO', toolCalls: [] };
      const hasTool = req.messages.some((m) => m.role === 'tool');
      if (!hasTool) {
        badTurn++;
        return {
          content: '',
          toolCalls: [{ id: 'cb', type: 'function', function: { name: 'memory_search', arguments: '{bad json' } }],
        };
      }
      return { content: '已处理坏参数', toolCalls: [] };
    });
    const r4 = await runAgentic({ sessionId: 's4', userInput: '坏参数' });
    ok(r4.stopReason === 'done', '坏参数 JSON 回灌错误后循环不崩，正常收尾');

    // 一致性 Nudge：谎报完成（零工具调用 + 判定器说 YES）→ 回灌自查 → 第二轮改口才放行。
    let nudgeSeen = false;
    let judgeSawReply = null;
    llm.setMockHandler((req) => {
      if (isJudge(req)) {
        judgeSawReply = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
        return { content: 'YES', toolCalls: [] };
      }
      const nudged = req.messages.some((m) => m.role === 'user' && /一致性检查/.test(String(m.content ?? '')));
      if (!nudged) return { content: '设好了，每天9点提醒你喝水。', toolCalls: [] };
      nudgeSeen = true;
      return { content: '刚才我其实没设上——要我现在真的设一个吗？', toolCalls: [] };
    });
    const r5 = await runAgentic({ sessionId: 's5', userInput: '把喝水提醒设回来' });
    ok(nudgeSeen && /没设上/.test(r5.reply) && r5.turns === 2, '谎报完成→一致性 Nudge 回灌→第二轮改口才放行');
    ok(/设好了，每天9点提醒你喝水。/.test(judgeSawReply || ''), '判定器拿到的是这一轮回复原文（判定对象正确）');

    // 07-27 实录回归：旧词表拦不住的待办说法（"划掉了"/"推到下周四"）现在必须被拦下。
    // 这是本次结构改动的验收点——判定归模型，不再靠列词形。
    for (const [claim, label] of [['好，用户手册划掉了。', '划掉了'], ['帮你把OMOP推到下周四8/6。', '推到某天']]) {
      let seen = false;
      llm.setMockHandler((req) => {
        if (isJudge(req)) return { content: 'YES', toolCalls: [] };
        const nudged = req.messages.some((m) => m.role === 'user' && /一致性检查/.test(String(m.content ?? '')));
        if (!nudged) return { content: claim, toolCalls: [] };
        seen = true;
        return { content: '我其实没动，要我现在改吗？', toolCalls: [] };
      });
      const rr = await runAgentic({ sessionId: 's5b', userInput: '这件事我做完了' });
      ok(seen && rr.turns === 2, `谎报完成·待办说法「${label}」被拦下（旧词表全漏，07-27 实录）`);
    }

    // 判定器说 NO（纯闲聊/发表看法）→ 不打扰，一轮直出。
    llm.setMockHandler((req) => {
      if (isJudge(req)) return { content: 'NO', toolCalls: [] };
      return { content: '我觉得这事你想多了。', toolCalls: [] };
    });
    const r5c = await runAgentic({ sessionId: 's5c', userInput: '你怎么看' });
    ok(r5c.reply === '我觉得这事你想多了。' && r5c.turns === 1, '判定器说 NO → 不 Nudge，闲聊零打扰');

    // 判定器自己坏掉（超时/报错）→ fail-open 放行，绝不挡住主人的消息。
    llm.setMockHandler((req) => {
      if (isJudge(req)) throw new Error('judge boom');
      return { content: '设好了。', toolCalls: [] };
    });
    const r5d = await runAgentic({ sessionId: 's5d', userInput: '设个提醒' });
    ok(r5d.reply === '设好了。' && r5d.turns === 1, '判定器故障 → fail-open 放行（安全网坏了不等于消息发不出去）');

    // 真调了副作用工具后，同样话术不触发 Nudge（事实基准=sideEffectDone；判定器根本不该被调起）。
    let judgeCalledAfterSideEffect = false;
    llm.setMockHandler((req) => {
      if (isJudge(req)) { judgeCalledAfterSideEffect = true; return { content: 'YES', toolCalls: [] }; }
      const hasTool = req.messages.some((m) => m.role === 'tool');
      if (!hasTool) {
        return {
          content: '',
          toolCalls: [{ id: 'n1', type: 'function', function: { name: 'schedule_task', arguments: JSON.stringify({ note: '喝水', delay_minutes: 60 }) } }],
        };
      }
      return { content: '设好了，一小时后提醒你。', toolCalls: [] };
    });
    const r6 = await runAgentic({ sessionId: 's6', userInput: '一小时后提醒我喝水' });
    ok(/设好了/.test(r6.reply) && r6.turns === 2 && r6.stopReason === 'done', '真调了副作用工具→同样话术不触发 Nudge');
    ok(!judgeCalledAfterSideEffect, '真调了副作用工具→判定器不被调起（不花冤枉调用）');

    // 顽固谎报：Nudge 后仍不改口 → 只 Nudge 一次，第二次照放行（防打转，宁可放过不卡死）。
    llm.setMockHandler((req) => (isJudge(req) ? { content: 'YES', toolCalls: [] } : { content: '设好了，放心。', toolCalls: [] }));
    const r7 = await runAgentic({ sessionId: 's7', userInput: '再设一个提醒' });
    ok(r7.reply === '设好了，放心。' && r7.turns === 2, 'Nudge 只打一次，顽固谎报第二轮放行不卡死');

    // 深思分支：thinking/profile/reasoningCarried 透传 + 思维链逐轮回传进请求历史。
    const deepReqs = [];
    llm.setMockHandler((req) => {
      if (isJudge(req)) return { content: 'NO', toolCalls: [] }; // 判定器是独立小调用，不进深思断言基准
      deepReqs.push(req);
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        return {
          content: '',
          reasoning: '先查记忆再答',
          toolCalls: [{ id: 'dt1', type: 'function', function: { name: 'memory_search', arguments: JSON.stringify({ query: 'deep' }) } }],
        };
      }
      return { content: '深思后的结论', reasoning: '综合工具结果得出', toolCalls: [] };
    });
    const r8 = await runAgentic({ sessionId: 's8', userInput: '深度分析一下', deepthink: true });
    ok(r8.stopReason === 'done' && r8.reply === '深思后的结论', '深思分支：工具轮正常收尾');
    ok(
      deepReqs.every((q) => q.thinking === 'on' && q.profile === 'deep' && q.reasoningCarried === true),
      '深思分支：每轮 LLM 调用带 thinking=on/profile=deep/reasoningCarried=true',
    );
    const carried = deepReqs[1] && deepReqs[1].messages.find((m) => m.role === 'assistant' && m.reasoning);
    ok(!!carried && carried.reasoning === '先查记忆再答', '深思分支：上一轮 reasoning 回传进第二轮请求的 assistant 消息（T6 契约）');

    // 默认路径回归：不传 deepthink → 参数保持旧值，assistant 消息不带 reasoning。
    const plainReqs = [];
    llm.setMockHandler((req) => {
      if (isJudge(req)) return { content: 'NO', toolCalls: [] };
      plainReqs.push(req);
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        return { content: '', reasoning: '不该被携带', toolCalls: [{ id: 'p1', type: 'function', function: { name: 'memory_search', arguments: '{"query":"q"}' } }] };
      }
      return { content: '普通回复', toolCalls: [] };
    });
    const r9 = await runAgentic({ sessionId: 's9', userInput: '随便问问' });
    ok(
      plainReqs.every((q) => q.thinking === 'off' && q.profile === 'default' && q.reasoningCarried === false) &&
        !plainReqs[1].messages.some((m) => m.role === 'assistant' && m.reasoning) &&
        r9.reply === '普通回复',
      '默认路径零变化：thinking=off/profile=default，reasoning 不进历史',
    );

    console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
  })();
}
