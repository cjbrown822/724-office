// llm.mjs —— LLM 收口：pi-ai 统一多厂商内核（默认）+ 纯 fetch 旧路径（LLM_ENGINE=raw 回滚闸）。
//
// 2026-07-24 起内核换成 @earendil-works/pi-ai（子淇点单：抹平各家模型 API 差异）：
//   - 对外契约不变：chatCompletion / callWithResilience / USE_MOCK / setMockHandler，loop.mjs 零改动。
//   - LLM_ENGINE=pi（默认）走 pi-ai 的 api 层（streamSimple，按 LLM_API_KIND 选协议：
//     openai-completions | anthropic-messages | google-generative-ai）；LLM_ENGINE=raw 走下面
//     保留的纯 fetch 路径 —— 一行 .env 即回滚，不用回代码。
//   - pi-ai 对 DeepSeek 的两个坑有原生处理（源码核实过 0.82.0）：关思考自动发
//     thinking:{type:'disabled'}（T6 防 400），开思考的多轮 reasoning_content 回传也内置。
//     我们仍保留"带 tools 强制关思考"结构护栏（loop 的消息历史不携带思维链，回传链路未启用）。
//   - pi-ai 自带的内部重试不启用（不传 maxRetries）：callWithResilience 是唯一重试权威，避免双层退避叠加。
//
// 致命纪律②：每次外部调用必带 timeout（AbortController + LLM_TIMEOUT_MS），绝不无限等待拖垮 worker tick。
// 致命纪律③：本模块绝不被放进 db 事务里调用（由 loop/worker 保证调用时机；这里只管"发请求"）。
// 失败要响：错误对象保留 statusCode（供 callWithResilience 按 4xx/5xx 分流）和 message，不静默吞。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = import.meta.dirname;

// ---- 环境加载（与 digital-twin 一致：.env 覆盖 process.env） ----
// 为什么自带 loader 而非依赖 db.mjs：llm 是被 loop 依赖的叶子模块，不应反向依赖业务库，
// 且 selftest 要能在不建 db 的情况下单独跑。
function loadEnv() {
  const env = { ...process.env };
  const p = join(DIR, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}
const ENV = loadEnv();

// 集中常量（契约：阈值不散落）
export const LLM_TIMEOUT_MS = parseInt(ENV.LLM_TIMEOUT_MS || '30000', 10);
const LLM_BASE_URL = ENV.LLM_BASE_URL || 'https://api.deepseek.com/v1';
const LLM_API_KEY = ENV.LLM_API_KEY || '';
const LLM_MODEL = ENV.LLM_MODEL || 'deepseek-v4-pro'; // deepseek-chat 已并入 v4-flash 并于 2026-07-24 退名；默认指 pro
const LLM_FALLBACK_BASE_URL = ENV.LLM_FALLBACK_BASE_URL || 'https://api.moonshot.cn/v1';
const LLM_FALLBACK_API_KEY = ENV.LLM_FALLBACK_API_KEY || '';
const LLM_FALLBACK_MODEL = ENV.LLM_FALLBACK_MODEL || 'moonshot-v1-8k';
// 引擎选择：pi（默认，pi-ai 内核）| raw（旧纯 fetch 路径，回滚闸）
const LLM_ENGINE = ENV.LLM_ENGINE === 'raw' ? 'raw' : 'pi';
// 协议选择（pi 引擎才生效）：主/备各自可指定 wire 协议，默认 OpenAI 兼容。
// 换厂商（如将来接 Anthropic/Gemini 端点）只改 .env，不回代码 —— 这就是"抹平差异"的落点。
const PI_API_KINDS = ['openai-completions', 'anthropic-messages', 'google-generative-ai'];
const LLM_API_KIND = PI_API_KINDS.includes(ENV.LLM_API_KIND) ? ENV.LLM_API_KIND : 'openai-completions';
const LLM_FALLBACK_API_KIND = PI_API_KINDS.includes(ENV.LLM_FALLBACK_API_KIND)
  ? ENV.LLM_FALLBACK_API_KIND
  : 'openai-completions';

// ---- 深思队伍（profile:'deep'，PLAN_DEEPTHINK §2④）----
// 未配置（DEEP_LLM_BASE_URL/KEY 缺任一）→ 深思退化为"现役队伍开思考"，不报错。
// 2026-07-24 调研拍板：深思主 glm-5.2（思考态证据最强）+ 备 v4-pro（interleaved thinking 主场）。
// 深思态单轮 5-15s 常态，超时单独放宽（DEEP_LLM_TIMEOUT_MS，默认 60s）。
const DEEP_LLM_TIMEOUT_MS = parseInt(ENV.DEEP_LLM_TIMEOUT_MS || '60000', 10);
const DEEP_PROVIDERS =
  ENV.DEEP_LLM_BASE_URL && ENV.DEEP_LLM_API_KEY
    ? {
        primary: {
          baseUrl: ENV.DEEP_LLM_BASE_URL,
          apiKey: ENV.DEEP_LLM_API_KEY,
          model: ENV.DEEP_LLM_MODEL || 'glm-5.2',
          name: 'primary',
          apiKind: PI_API_KINDS.includes(ENV.DEEP_LLM_API_KIND) ? ENV.DEEP_LLM_API_KIND : 'openai-completions',
        },
        fallback: {
          baseUrl: ENV.DEEP_LLM_FALLBACK_BASE_URL || 'https://api.deepseek.com/v1',
          apiKey: ENV.DEEP_LLM_FALLBACK_API_KEY || '',
          model: ENV.DEEP_LLM_FALLBACK_MODEL || 'deepseek-v4-pro',
          name: 'fallback',
          apiKind: PI_API_KINDS.includes(ENV.DEEP_LLM_FALLBACK_API_KIND)
            ? ENV.DEEP_LLM_FALLBACK_API_KIND
            : 'openai-completions',
        },
      }
    : null;

// MOCK 开关：显式 LLM_MOCK=1 或 无主 key 时离线（不联网），让 selftest/无网环境可跑。
export const USE_MOCK = ENV.LLM_MOCK === '1' || !LLM_API_KEY;

// 主/备 provider 配置（callWithResilience 在主连续失败后切到 fallback）
const PROVIDERS = {
  primary: {
    baseUrl: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
    name: 'primary',
    apiKind: LLM_API_KIND,
  },
  fallback: {
    baseUrl: LLM_FALLBACK_BASE_URL,
    apiKey: LLM_FALLBACK_API_KEY,
    model: LLM_FALLBACK_MODEL,
    name: 'fallback',
    apiKind: LLM_FALLBACK_API_KIND,
  },
};

// ---- mock handler（selftest 注入） ----
// 默认 mock：返回固定无 tool_call 文本，保证 USE_MOCK 下循环能终止。
let mockHandler = (_req) => ({ content: '[mock] 收到，这是离线占位回复。', toolCalls: [] });

export function setMockHandler(fn) {
  if (typeof fn !== 'function') throw new Error('setMockHandler 需要一个函数');
  mockHandler = fn;
}

// ---- chatCompletion：统一入口（mock → pi | raw 分发） ----
// 返回 { content, reasoning, toolCalls, raw, model, provider }，消息进出都是 OpenAI wire 格式
// （loop.mjs 的既有方言）；pi 引擎在内部做双向翻译。
export async function chatCompletion({
  messages,
  tools = null,
  model = null, // null=用所选 provider 的 model（深思 profile 有自己的主力，不能被默认主力覆盖）
  temperature = 0.3,
  thinking = 'off', // 'off'（默认，关思考=快+稳+工具安全）| 'on'（开思考）
  reasoningCarried = false, // true=调用方承诺把 assistant.reasoning 回传进历史（loop 深思分支）→ 才允许 thinking:'on' 与 tools 并存
  profile = 'default', // 'default'=现役队伍 | 'deep'=深思队伍（DEEP_LLM_*，未配置则退化为现役队伍）
  responseFormat = null,
  signal = null,
  // 增量回调（语音链路 2026-07-25）：{type:'text',text} 逐 token 吐字；{type:'discard'} = 本轮改调工具了，
  // 前面吐的字作废（模型偶尔先说半句再决定调工具，那半句不是给用户的答案）。
  // 只有 pi 引擎能吐（raw 回滚路径不流式，回调不触发，回复照常整段返回）。
  onDelta = null,
  _provider = 'primary',
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatCompletion: messages 不能为空');
  }

  // MOCK 模式：不联网，走注入的 mockHandler，便于断言 tool_calls（含深思参数透传，loop selftest 用）。
  if (USE_MOCK) {
    const r = mockHandler({ messages, tools, thinking, profile, reasoningCarried }) || {};
    return {
      content: r.content ?? '',
      reasoning: r.reasoning ?? '',
      toolCalls: Array.isArray(r.toolCalls) ? r.toolCalls : [],
      raw: { mock: true, ...r },
      model: model || 'mock',
      provider: 'mock',
    };
  }

  // 深思 profile 只在 pi 引擎生效：raw 路径无思维链回传能力，且不发 thinking 字段会踩
  // GLM 默认开思考的坑 —— LLM_ENGINE=raw 回滚时深思退化为普通调用（保底小王能用，PLAN §5）。
  const group = profile === 'deep' && LLM_ENGINE === 'pi' && DEEP_PROVIDERS ? DEEP_PROVIDERS : PROVIDERS;
  const prov = group[_provider] || group.primary;
  if (!prov.apiKey) {
    // 没 key 又非 mock：明确报错而不是发空 Authorization 静默 401
    const e = new Error(`provider ${prov.name} 缺少 API key`);
    e.statusCode = 0;
    throw e;
  }

  const timeoutMs = profile === 'deep' ? DEEP_LLM_TIMEOUT_MS : LLM_TIMEOUT_MS;
  const args = { messages, tools, model, temperature, thinking, reasoningCarried, responseFormat, signal, timeoutMs, onDelta };
  return LLM_ENGINE === 'raw' ? rawChatCompletion(args, prov) : piChatCompletion(args, prov);
}

// ---- timeout + 外部 signal 合流（致命纪律②，pi/raw 两路共用；深思 profile 传更宽的 timeoutMs） ----
function makeTimeoutSignal(signal, timeoutMs = LLM_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onExtAbort = () => ac.abort(signal?.reason || new Error('aborted'));
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener('abort', onExtAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onExtAbort);
  };
  return { ac, cleanup };
}

// ============================================================================
// pi 引擎（默认）：@earendil-works/pi-ai 的 api 层直连
// 不走它的 createModels/auth 机器（key 显式随请求传，确定性），只用协议实现本身。
// ============================================================================

// 协议模块懒加载 + 缓存：装包失败要给出可操作的修复提示（npm i 或 LLM_ENGINE=raw），
// 且 raw/mock 路径完全不 import pi-ai —— 包不在也能跑（回滚闸真正独立）。
const piApiCache = new Map();
async function loadPiApi(kind) {
  if (!piApiCache.has(kind)) {
    piApiCache.set(
      kind,
      import(`@earendil-works/pi-ai/api/${kind}`).catch((err) => {
        piApiCache.delete(kind); // 失败不缓存，下次可重试
        throw new Error(
          `pi-ai 协议模块 ${kind} 加载失败（未 npm install？）：${err.message}。临时回滚：.env 设 LLM_ENGINE=raw 后重启`,
        );
      }),
    );
  }
  return piApiCache.get(kind);
}

// provider id 只影响 pi-ai 的 compat 自动检测（baseUrl 也参与检测）和报错前缀，不影响鉴权。
function derivePiProviderId(baseUrl) {
  if (/deepseek/i.test(baseUrl)) return 'deepseek';
  if (/moonshot/i.test(baseUrl)) return 'moonshot';
  if (/bigmodel\.cn|api\.z\.ai/i.test(baseUrl)) return 'zai'; // 智谱 GLM（大陆 open.bigmodel.cn / 国际 api.z.ai）
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'custom';
  }
}

// 从 .env 的 provider 配置拼 pi-ai Model 字面量。
// contextWindow/maxTokens 只是元数据（不传 options.maxTokens 就不会上 wire —— 源码核实），
// 填保守值即可；cost 全 0（我们不用它的计费）。
function buildPiModel(prov, modelId) {
  const providerId = derivePiProviderId(prov.baseUrl);
  const isDeepseek = providerId === 'deepseek';
  const isZai = providerId === 'zai';
  return {
    id: modelId,
    name: modelId,
    api: prov.apiKind,
    provider: providerId,
    baseUrl: prov.baseUrl.replace(/\/$/, ''),
    // reasoning=true 才会让 pi-ai 管思考开关。DeepSeek 必须 true：v4-pro 默认开思考，
    // 不显式发 thinking:{type:'disabled'} 会踩 T6（带工具第二轮 400）。
    // 智谱 GLM（zai）同理：4.5+ 混合思考默认开，显式关掉才有关思考的速度（pi-ai zai 分支发 thinking:{type}）。
    // 其它 openai 兼容端（如 Kimi fallback）保持 false = 不发任何思考字段（与 raw 路径一致）。
    reasoning: isDeepseek || isZai || prov.apiKind !== 'openai-completions',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
    // DeepSeek 只认 thinking:{type}；官方思考模式没说支持 reasoning_effort，别让 pi-ai 顺手带上。
    compat: isDeepseek ? { supportsReasoningEffort: false } : undefined,
  };
}

// OpenAI wire messages → pi-ai Context。
// loop.mjs 的方言：system 在头部；assistant 可带 tool_calls（arguments 是 JSON 字符串）；
// 工具结果是 role:'tool' + tool_call_id（无工具名 —— 从前文 assistant 的 tool_calls 反查）。
function openaiMessagesToContext(messages, tools) {
  const ts = Date.now();
  const systemParts = [];
  const out = [];
  const toolNameById = new Map();

  for (const m of messages) {
    const role = m?.role;
    if (role === 'system') {
      if (m.content) systemParts.push(String(m.content));
      continue;
    }
    if (role === 'user') {
      out.push({ role: 'user', content: String(m.content ?? ''), timestamp: ts });
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      // 深思模式的思维链回传（T6 正面解决，PLAN §2③）：loop 把上一轮的 reasoning 存回 assistant 消息，
      // 这里译成 thinking block —— pi-ai 按各家格式序列化（DeepSeek=reasoning_content，GLM=对应字段）。
      if (typeof m.reasoning === 'string' && m.reasoning) blocks.push({ type: 'thinking', thinking: m.reasoning });
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of tcs) {
        const name = tc?.function?.name || 'unknown';
        toolNameById.set(tc?.id, name);
        let args = {};
        try {
          args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {}; // 参数 JSON 坏掉：loop 已经用错误回灌处理过这轮，历史重放给个空对象即可
        }
        blocks.push({ type: 'toolCall', id: tc?.id || '', name, arguments: args });
      }
      out.push({
        role: 'assistant',
        content: blocks,
        api: 'openai-completions',
        provider: 'replay', // 历史重放占位；pi-ai 序列化按当前请求的 model/compat 走，不看这两个字段的语义
        model: 'replay',
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: tcs.length > 0 ? 'toolUse' : 'stop',
        timestamp: ts,
      });
      continue;
    }
    if (role === 'tool') {
      out.push({
        role: 'toolResult',
        toolCallId: m.tool_call_id || '',
        toolName: toolNameById.get(m.tool_call_id) || 'unknown',
        content: [{ type: 'text', text: String(m.content ?? '') }],
        isError: false, // 业务层的 ok:false 已编码在 content JSON 里，协议层不重复标错
        timestamp: ts,
      });
      continue;
    }
    // 未知 role：丢弃比拼错格式安全（当前 loop 只产上面四种）
    console.warn('[llm] pi 翻译遇到未知 role=%s，已跳过', role);
  }

  const ctx = { systemPrompt: systemParts.join('\n\n') || undefined, messages: out };
  if (Array.isArray(tools) && tools.length > 0) {
    // OpenAI [{type:'function', function:{name,description,parameters}}] → pi [{name,description,parameters}]
    // parameters 本来就是 JSON Schema，pi-ai 直接接受（"TypeBox already generates JSON Schema"）。
    ctx.tools = tools.map((t) => ({
      name: t?.function?.name || t?.name || 'unknown',
      description: t?.function?.description || t?.description || '',
      parameters: t?.function?.parameters || t?.parameters || { type: 'object', properties: {} },
    }));
  }
  return ctx;
}

// pi-ai AssistantMessage → 本模块契约返回值（OpenAI 形状的 toolCalls，arguments 回到 JSON 字符串）。
function assistantMessageToResult(msg, prov, requestModel) {
  const texts = [];
  const thinkings = [];
  const toolCalls = [];
  for (const b of msg?.content || []) {
    if (b?.type === 'text') texts.push(b.text);
    else if (b?.type === 'thinking') thinkings.push(b.thinking);
    else if (b?.type === 'toolCall') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) },
      });
    }
  }
  return {
    content: texts.join('\n'),
    reasoning: thinkings.join('\n'),
    toolCalls,
    raw: msg, // 含 usage（tokens/cost）——pi-ai 白送的观测数据，要看就在这
    model: msg?.responseModel || msg?.model || requestModel,
    provider: prov.name,
  };
}

// pi-ai 出错不 reject，resolve 出 stopReason:'error'|'aborted' + errorMessage（源码核实）。
// HTTP status 藏在 formatProviderError 的文案里（"429: ..." / "xx (503): ..." / "400 status code ..."），
// 抠出来喂给 callWithResilience 的分流逻辑；抠不到就按网络错（可重试）处理。
function statusFromErrorMessage(text) {
  const m = String(text || '').match(/\b([45]\d\d)\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

async function piChatCompletion({ messages, tools, model, temperature, thinking, reasoningCarried, responseFormat, signal, timeoutMs, onDelta }, prov) {
  const api = await loadPiApi(prov.apiKind);
  const isPrimary = prov.name === 'primary';
  const requestModel = isPrimary ? model || prov.model : prov.model;
  const piModel = buildPiModel(prov, requestModel);

  // 结构护栏（原则2）：开思考 + 带 tools = 多轮需逐轮回传思维链。放开的唯一钥匙是
  // reasoningCarried=true —— 调用方（loop 深思分支）结构性承诺"assistant.reasoning 会回传"，
  // 翻译层才有 thinking block 可序列化。没这个承诺仍强制关（T6 类 400 从结构上不可能）。
  // 门禁不再限 primary：深思备位（v4-pro）也走思考态；不支持思考的端（piModel.reasoning=false，
  // 如 Kimi）天然关——思考开关只对受管模型有意义。
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const forcedOff = thinking === 'on' && hasTools && !reasoningCarried;
  if (forcedOff) {
    console.warn('[llm] thinking=on 与 tools 同时出现且未承诺回传（reasoningCarried≠true）→ 已强制关思考（防缺 reasoning_content 400）');
  }
  const wantThinking = thinking === 'on' && piModel.reasoning === true && !forcedOff;

  const ctx = openaiMessagesToContext(messages, tools);
  const { ac, cleanup } = makeTimeoutSignal(signal, timeoutMs);

  const options = {
    apiKey: prov.apiKey,
    signal: ac.signal,
    // 开思考不发 temperature（DeepSeek 官方思考模式不支持该参数，与 raw 路径一致）
    ...(wantThinking ? {} : { temperature }),
    // streamSimple 的统一思考口径：undefined=关（DeepSeek 会显式收到 thinking:{type:'disabled'}），
    // 'medium'=开（DeepSeek 只有开关语义，档位值不下发 —— compat.supportsReasoningEffort=false 挡住）。
    ...(wantThinking ? { reasoning: 'medium' } : {}),
    // response_format 不在 pi-ai 的统一 options 里，用 onPayload 逃生舱兜住契约面
    ...(responseFormat
      ? { onPayload: (params) => ({ ...params, response_format: responseFormat }) }
      : {}),
  };

  let msg;
  try {
    const stream = api.streamSimple(piModel, ctx, options);
    // 事件流与 result() 是同一条流的两个视图（EventStream 内部各自持有队列/终值），
    // 不订阅就是今天的行为；订阅了才逐 token 吐字。异常不外抛——吐字失败不该让整轮挂掉。
    if (onDelta) {
      // 每次尝试开头先作废：主力挂了换备位重答时，上一次吐到一半的字不该和新答案拼在一起。
      onDelta({ type: 'discard' });
      (async () => {
        let sawToolCall = false;
        for await (const ev of stream) {
          if (ev.type === 'toolcall_start' && !sawToolCall) {
            sawToolCall = true;
            onDelta({ type: 'discard' });
          } else if (ev.type === 'text_delta' && ev.delta && !sawToolCall) {
            onDelta({ type: 'text', text: ev.delta });
          }
        }
      })().catch((e) => console.error('[llm] onDelta 订阅异常（不影响本轮结果）: %s', e.message));
    }
    msg = await stream.result();
  } catch (err) {
    // 正常错误走 stopReason:'error'；这里兜同步抛（如 key 校验）——按网络类可重试处理
    const e = new Error(`[${prov.name}] pi-ai 调用失败: ${err.message}`);
    e.statusCode = statusFromErrorMessage(err.message);
    e.cause = err;
    throw e;
  } finally {
    cleanup();
  }

  if (msg?.stopReason === 'aborted') {
    const e = new Error(`[${prov.name}] fetch 失败: ${msg.errorMessage || 'aborted'}`);
    e.statusCode = 408; // 超时/中止归入可重试，与 raw 路径同码
    throw e;
  }
  if (msg?.stopReason === 'error') {
    const e = new Error(`[${prov.name}] ${msg.errorMessage || 'provider error'}`);
    e.statusCode = statusFromErrorMessage(msg.errorMessage);
    throw e;
  }
  return assistantMessageToResult(msg, prov, requestModel);
}

// ============================================================================
// raw 引擎（回滚闸）：纯 fetch 调 OpenAI 兼容 /chat/completions，2026-07-24 前的原路径逐字保留
// ============================================================================

async function rawChatCompletion({ messages, tools, model, temperature, thinking, responseFormat, signal, timeoutMs }, prov) {
  const url = prov.baseUrl.replace(/\/$/, '') + '/chat/completions';
  // DeepSeek 思考模式（thinking_mode）：只对主 provider 且确为 DeepSeek 端点时才发 thinking 字段
  //   —— Kimi/其它 OpenAI 兼容端不认这个字段，发了会 400，故用 isDeepseek 守住。
  // v4-pro 默认 thinking=enabled；若不显式关，带工具的主循环第二轮会因缺 reasoning_content 报 400（实测 T6）。
  // 规则：关思考显式发 {type:'disabled'}；开思考发 {type:'enabled'} 且【不发 temperature】（官方思考模式不支持该参数）。
  const isPrimary = prov.name === 'primary';
  const isDeepseek = /deepseek/i.test(prov.baseUrl || '');
  // 结构护栏（原则2：用结构让错误不可能）：开思考 + 带 tools = 多轮工具循环需逐轮回传 reasoning_content，
  // 当前 loop 未实现该回传（Phase 2 才做）。故只要带 tools 就强制关思考，让 T6 类 400 从结构上不可能发生。
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (isPrimary && isDeepseek && thinking === 'on' && hasTools) {
    console.warn('[llm] thinking=on 与 tools 同时出现 → 已强制关思考（避免工具循环缺 reasoning_content 报 400）；Phase 2 实现回传后再放开');
  }
  const wantThinking = isPrimary && isDeepseek && thinking === 'on' && !hasTools;
  const body = {
    model: isPrimary ? model || prov.model : prov.model,
    messages,
  };
  if (isPrimary && isDeepseek) body.thinking = { type: wantThinking ? 'enabled' : 'disabled' };
  if (!wantThinking) body.temperature = temperature; // 关思考/非 DeepSeek：正常发 temperature；开思考：不发
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (responseFormat) body.response_format = responseFormat;

  // 致命纪律②：内部 AbortController 控 timeout；外部 signal 也能取消（两者任一触发即中止）。
  const { ac, cleanup } = makeTimeoutSignal(signal, timeoutMs);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${prov.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    // 网络层失败（含 abort/timeout）：归类为可重试（无 statusCode → callWithResilience 视作可退避）
    const e = new Error(`[${prov.name}] fetch 失败: ${err.message}`);
    e.statusCode = err.name === 'AbortError' ? 408 : undefined; // 408=超时，归入可重试
    e.cause = err;
    throw e;
  } finally {
    cleanup();
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const e = new Error(`[${prov.name}] HTTP ${resp.status}: ${text.slice(0, 300)}`);
    e.statusCode = resp.status; // 供 callWithResilience 按 429/5xx vs 4xx 分流
    throw e;
  }

  const data = await resp.json();
  const msg = data?.choices?.[0]?.message || {};
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    // 开思考时 DeepSeek 把思维链放这里（与 content 同级）；关思考时为空。捕获出来供将来"深想"能力回传用。
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    raw: data,
    model: data?.model || body.model,
    provider: prov.name,
  };
}

// ---- callWithResilience：指数退避 + 错误码分流 + DeepSeek↔Kimi fallback ----
// 退避：1→2→4s，每次叠加 30% jitter，封顶 retries=2 次（即最多 3 次尝试）。
// 错误码分流：err.statusCode 429/5xx/408 → 退避重试；其它 4xx → 直接抛（重了也没用）。
// fallback：把 _provider 在主连续失败后切 'fallback'（主备穷尽才放弃）；不做三态熔断。
// fn 约定：接收 { provider } 提示当前该用哪个 provider，返回 Promise。
// 配合 chatCompletion 用法：callWithResilience(({provider}) => chatCompletion({...args, _provider: provider}))
export async function callWithResilience(fn, { retries = 2, baseMs = 1000, profile = 'default' } = {}) {
  if (typeof fn !== 'function') throw new Error('callWithResilience: fn 必须是函数');

  // 尝试顺序：先 primary 把 retries 次退避用完，仍失败且 fallback 有 key → 再给 fallback 试一轮。
  // 深思 profile 看深思队伍的备位 key（与 chatCompletion 的 group 选择同一判据，二者必须一致）。
  const useDeep = profile === 'deep' && LLM_ENGINE === 'pi' && !!DEEP_PROVIDERS;
  const fallbackKey = useDeep ? DEEP_PROVIDERS.fallback.apiKey : LLM_FALLBACK_API_KEY;
  const haveFallback = !USE_MOCK && !!fallbackKey;
  const providers = haveFallback ? ['primary', 'fallback'] : ['primary'];

  let lastErr;
  for (const provider of providers) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn({ provider, attempt });
      } catch (err) {
        lastErr = err;
        const code = err?.statusCode;
        const retriable =
          code === undefined || code === 408 || code === 429 || (code >= 500 && code < 600);

        if (!retriable) {
          // 4xx（认证/参数错误等）：换 provider 也大概率同样错，但 401/403 可能是单 provider key 问题
          // → 鉴权类（401/403）允许切下一个 provider；其余 4xx 直接抛（不浪费退避）。
          if ((code === 401 || code === 403) && provider !== providers[providers.length - 1]) {
            console.warn('[llm] %s 鉴权失败(%s)，切换 provider', provider, code);
            break; // 跳出 attempt 循环，进入下一个 provider
          }
          console.warn('[llm] 不可重试错误(%s)，放弃: %s', code, err.message);
          throw err;
        }

        if (attempt < retries) {
          const backoff = Math.round(baseMs * 2 ** attempt * (1 + Math.random() * 0.3));
          console.warn(
            '[llm] %s 第%d次失败(%s)，%dms 后重试: %s',
            provider,
            attempt + 1,
            code ?? 'net',
            backoff,
            err.message,
          );
          await sleep(backoff);
        } else {
          console.warn(
            '[llm] %s 重试耗尽(%d次)，%s',
            provider,
            retries + 1,
            haveFallback && provider === 'primary' ? '切换到 fallback' : '无更多 provider',
          );
        }
      }
    }
  }
  // 所有 provider 都失败：抛最后一个错（保留证据，含 statusCode）
  throw lastErr || new Error('callWithResilience: 未知失败');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 自检：mock 路径 + 退避分流 + pi 翻译层纯函数（全部不联网） ----
const IS_MAIN =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (process.argv.includes('--selftest') && IS_MAIN) {
  (async () => {
    let pass = 0,
      fail = 0;
    const ok = (c, m) => {
      console.log(`  ${c ? '✓' : '✗'} ${m}`);
      c ? pass++ : fail++;
    };
    console.log(`llm.mjs selftest (USE_MOCK=${USE_MOCK}, ENGINE=${LLM_ENGINE})\n`);

    // 1. mock handler 注入 → tool_calls 可断言
    setMockHandler((req) => {
      if (req.messages.some((m) => m.content?.includes('用工具'))) {
        return {
          content: '',
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'query_db', arguments: '{}' } },
          ],
        };
      }
      return { content: '最终回复', toolCalls: [] };
    });

    if (USE_MOCK) {
      const r1 = await chatCompletion({ messages: [{ role: 'user', content: '请用工具查一下' }] });
      ok(r1.toolCalls.length === 1 && r1.toolCalls[0].function.name === 'query_db', 'mock 返回 tool_call 可断言');
      ok(r1.provider === 'mock', 'mock 模式 provider=mock，不联网');

      const r2 = await chatCompletion({ messages: [{ role: 'user', content: '随便聊聊' }] });
      ok(r2.content === '最终回复' && r2.toolCalls.length === 0, 'mock 无 tool_call 路径');
    } else {
      ok(true, '(非 mock 环境，跳过 mock 断言)');
    }

    // 2. callWithResilience：4xx 不重试，直接抛
    let calls = 0;
    try {
      await callWithResilience(
        async () => {
          calls++;
          const e = new Error('bad request');
          e.statusCode = 400;
          throw e;
        },
        { retries: 2, baseMs: 1 },
      );
      ok(false, '4xx 应抛出');
    } catch (e) {
      ok(e.statusCode === 400 && calls === 1, '400 错误不重试（只调 1 次）');
    }

    // 3. callWithResilience：5xx 退避重试，第3次成功
    calls = 0;
    const r = await callWithResilience(
      async () => {
        calls++;
        if (calls < 3) {
          const e = new Error('server error');
          e.statusCode = 503;
          throw e;
        }
        return 'recovered';
      },
      { retries: 2, baseMs: 1 },
    );
    ok(r === 'recovered' && calls === 3, '503 退避重试，第3次成功');

    // 4. callWithResilience：网络错误（无 statusCode）也重试
    // 期望次数随环境变：配了 fallback key（如服务器生产 .env）= 主备各 3 次 = 6；否则 3。
    // 旧断言写死 3，在带 Kimi key 的机器上必红 —— 按环境算期望值。
    calls = 0;
    const expectedAttempts = !USE_MOCK && LLM_FALLBACK_API_KEY ? 6 : 3;
    try {
      await callWithResilience(
        async () => {
          calls++;
          throw new Error('ECONNRESET'); // 无 statusCode
        },
        { retries: 2, baseMs: 1 },
      );
      ok(false, '应耗尽重试后抛');
    } catch {
      ok(calls === expectedAttempts, `网络错误（无 code）按可重试处理，主备共尝试 ${expectedAttempts} 次`);
    }

    // 5. pi 翻译层：OpenAI wire → pi Context（system 归拢 / tool_calls / toolResult 反查工具名）
    {
      const ctx = openaiMessagesToContext(
        [
          { role: 'system', content: '你是小王' },
          { role: 'user', content: '明早8点提醒我' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'schedule_task', arguments: '{"at":"08:00"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
          { role: 'assistant', content: '设好了' },
        ],
        [{ type: 'function', function: { name: 'schedule_task', description: '设提醒', parameters: { type: 'object', properties: {} } } }],
      );
      ok(ctx.systemPrompt === '你是小王', 'pi 翻译：system → systemPrompt');
      ok(ctx.messages.length === 4, 'pi 翻译：非 system 消息 4 条');
      const asst = ctx.messages[1];
      ok(
        asst.role === 'assistant' &&
          asst.stopReason === 'toolUse' &&
          asst.content[0].type === 'toolCall' &&
          asst.content[0].arguments.at === '08:00',
        'pi 翻译：tool_calls → toolCall block（arguments 已解析）',
      );
      const tr = ctx.messages[2];
      ok(
        tr.role === 'toolResult' && tr.toolCallId === 'c1' && tr.toolName === 'schedule_task',
        'pi 翻译：role:tool → toolResult（工具名按 id 反查）',
      );
      ok(ctx.tools.length === 1 && ctx.tools[0].name === 'schedule_task' && !!ctx.tools[0].parameters, 'pi 翻译：工具定义拆掉 function 包装');
    }

    // 5b. 深思回传：assistant.reasoning → thinking block（块序：thinking 在最前）
    {
      const ctx = openaiMessagesToContext(
        [
          { role: 'user', content: '深想一下' },
          {
            role: 'assistant',
            content: '先查天气',
            reasoning: '用户要深度分析，先拿数据',
            tool_calls: [{ id: 'd1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
          },
          { role: 'tool', tool_call_id: 'd1', content: '{"ok":true}' },
        ],
        null,
      );
      const asst = ctx.messages[1];
      ok(
        asst.content[0].type === 'thinking' && asst.content[0].thinking === '用户要深度分析，先拿数据',
        '深思回传：assistant.reasoning 译成 thinking block 且在块首',
      );
      ok(asst.content[1].type === 'text' && asst.content[2].type === 'toolCall', '深思回传：text/toolCall 顺序不受影响');
      const plain = openaiMessagesToContext([{ role: 'user', content: 'x' }, { role: 'assistant', content: '好' }], null);
      ok(plain.messages[1].content.length === 1 && plain.messages[1].content[0].type === 'text', '无 reasoning 的 assistant 不产生 thinking block（默认路径零变化）');
    }

    // 5c. mock 透传深思参数（loop selftest 依赖此观测口）
    if (USE_MOCK) {
      let seen = null;
      setMockHandler((req) => {
        seen = { thinking: req.thinking, profile: req.profile, reasoningCarried: req.reasoningCarried };
        return { content: 'ok', toolCalls: [] };
      });
      await chatCompletion({ messages: [{ role: 'user', content: 'x' }], thinking: 'on', profile: 'deep', reasoningCarried: true });
      ok(
        seen && seen.thinking === 'on' && seen.profile === 'deep' && seen.reasoningCarried === true,
        'mock 透传 thinking/profile/reasoningCarried（深思参数可被 selftest 观测）',
      );
      await chatCompletion({ messages: [{ role: 'user', content: 'x' }] });
      ok(seen.thinking === 'off' && seen.profile === 'default' && seen.reasoningCarried === false, '默认调用参数不变（thinking=off/profile=default）');
    }

    // 6. pi 翻译层：AssistantMessage → 契约返回值（arguments 回 JSON 字符串）
    {
      const out = assistantMessageToResult(
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想一下' },
            { type: 'text', text: '好' },
            { type: 'toolCall', id: 'c9', name: 'get_weather', arguments: { city: '上海' } },
          ],
          stopReason: 'toolUse',
          model: 'deepseek-v4-pro',
        },
        PROVIDERS.primary,
        'deepseek-v4-pro',
      );
      ok(out.content === '好' && out.reasoning === '想一下', 'pi 回译：text/thinking 分流');
      ok(
        out.toolCalls.length === 1 &&
          out.toolCalls[0].function.name === 'get_weather' &&
          JSON.parse(out.toolCalls[0].function.arguments).city === '上海',
        'pi 回译：toolCall → OpenAI 形状（arguments 字符串化）',
      );
    }

    // 7. 错误文案抠 status（callWithResilience 分流的输入源）
    ok(statusFromErrorMessage('429: {"error":"rate limit"}') === 429, 'status 抠取：前缀形');
    ok(statusFromErrorMessage('DeepSeek (503): upstream busy') === 503, 'status 抠取：括号形');
    ok(statusFromErrorMessage('400 status code (no body)') === 400, 'status 抠取：SDK 文案形');
    ok(statusFromErrorMessage('ECONNRESET') === undefined, 'status 抠取：无码返回 undefined（按可重试）');

    // 8. pi Model 字面量：DeepSeek 拿到 reasoning=true + 挡 reasoning_effort；Kimi 不带思考
    // 用显式字面量而非 PROVIDERS.primary/fallback —— 后者随 .env 变（服务器主力切 GLM 后曾假红）。
    {
      const ds = buildPiModel(
        { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', model: 'deepseek-v4-pro', name: 'primary', apiKind: 'openai-completions' },
        'deepseek-v4-pro',
      );
      const km = buildPiModel(
        { baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'x', model: 'moonshot-v1-8k', name: 'fallback', apiKind: 'openai-completions' },
        'moonshot-v1-8k',
      );
      ok(
        ds.provider === 'deepseek' && ds.reasoning === true && ds.compat?.supportsReasoningEffort === false,
        'pi Model：DeepSeek reasoning=true 且不发 reasoning_effort',
      );
      ok(km.provider === 'moonshot' && km.reasoning === false, 'pi Model：Kimi fallback 不带思考字段');
      const zai = buildPiModel(
        { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-4.6', name: 'primary', apiKind: 'openai-completions' },
        'glm-4.6',
      );
      ok(zai.provider === 'zai' && zai.reasoning === true, 'pi Model：智谱 GLM 识别为 zai 且思考开关受管（默认关）');
    }

    console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
  })();
}
