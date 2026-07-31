// tools.mjs —— 工具注册表 + 统一执行入口 callTool（致命纪律①的落地处）。
//
// 致命纪律①：每个有副作用的工具调用前，必须经统一 wrapper（callTool）算 dedup_hash 并查/写
//   outbox（或幂等键）去重，命中即不重复执行。这条在 callTool 里强制实现，工具 fn 自身不碰去重。
// 致命纪律②：http_get 的 fetch 必带 timeout（HTTP_TIMEOUT_MS）。
// 致命纪律③：fn 内的 fetch/HTTP 在事务外；最终落库（enqueueOutbox/stageFact/createTask）才进 tx()，
//   且那些 tx() 都在被依赖模块内部，本模块只调它们的同步接口、不在 tx 里 await。
//
// 安全分层（团队原则3）：
//   - Schema 层：query_db 只读、参数化，不暴露任意 SQL（工具定义里就没有"任意 SQL"入口）。
//   - 工具校验层：resolveSandboxPath 防路径穿越；DANGEROUS_PATTERNS 拦非 SELECT / SSRF 内网地址。
//   - 审批层：memory_write 进 staging 等人工确认，不直接写 facts 表。

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDb, nowMs } from './db.mjs';
import { createTask, scheduleTimer, markTaskDone } from './durable.mjs';
import { appendEpisode, retrieve, stageFact, pinFact, unpinFact, pinnedFacts, appendNote, searchFacts, searchNotes } from './memory.mjs';
import { enqueueOutbox } from './adapter.mjs';
import { recordCheckin } from './esm.mjs';
import { weatherBriefing, ADCODE } from './weather.mjs';
import { initRecurringSchema, addJob, listJobs, setEnabled, reviveJob } from './recurring.mjs';
import {
  initTodoSchema, addTodo, completeTodo, reopenTodo, dropTodo, parkTodo, unparkTodo,
  deferTodo, appendDetail, addLink, editTodo, setTodoReminder, cancelTodoReminder,
  getState as getTodoState, rolloverSweep,
} from './todo.mjs';
import { IDENTITY } from './identity.mjs';

const DIR = import.meta.dirname;

// 沙箱根：read_file/write_file 只能在此目录内操作（path traversal 防护）
export const SANDBOX_DIR = resolve(process.env.XW2_SANDBOX_DIR || join(DIR, 'workspace'));

const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);

// ---- 能力开关（ziqi-only 结构隔离）：默认关；只有 .env 显式置 1 的实例才注册对应工具。 ----
// 朋友 friend.env 无这些 flag → 工具不注册、能力卡不放开，行为与旧版逐字一致（隔离靠结构·团队原则3/11）。
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED === '1' || process.env.WEB_SEARCH_ENABLED === 'true';
const PUBLISH_ENABLED = process.env.PUBLISH_ENABLED === '1' || process.env.PUBLISH_ENABLED === 'true';
// 待办面板（ziqi-only）：TODO_SECRET 即开关——它同时是 capability URL 的 secret（adapter 路由）
// 与工具注册条件，一处配置三处一致（工具/路由/能力卡），不会出现"工具在但页面404"的半开状态。
const TODO_ENABLED = !!process.env.TODO_SECRET;
const TODO_PANEL_URL = TODO_ENABLED && process.env.PUBLIC_BASE_URL
  ? `${String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '')}/todo/${process.env.TODO_SECRET}`
  : '';
// 家里设备控制（ziqi-only）：HA_URL+HA_TOKEN 同时配置才开。HA_URL 指家中 Jetson 的
// Home Assistant 经 SSH 反向隧道映射到本机的地址（127.0.0.1:18123，隧道见 Jetson 的
// ssh-tunnel.service），token 是 HA 长期访问令牌——两者都只在 ziqi .env（server-only 不进 git）。
// 朋友 friend.env 无这两项 → 工具不注册、能力卡不提（隔离靠结构·团队原则3/11）。
// 注意：URL/实体 id 全部来自 env（运营者配置），模型只能传 action/mode/temp——
// 结构上不存在"模型指挥 harness 打任意内网地址"的口子，故不走 SSRF 黑名单（那是给模型传 URL 的工具的）。
const HA_ENABLED = !!(process.env.HA_URL && process.env.HA_TOKEN);
const HA_URL = (process.env.HA_URL || '').replace(/\/+$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const HA_AC_ENTITY = process.env.HA_AC_ENTITY || 'climate.lumi_cn_977136240_mcn02';
const HA_AC_POWER_ENTITY = process.env.HA_AC_POWER_ENTITY || '';
// 搜索源：Bing RSS（无需 key；阿里云/国内服务器可达，Jina/DuckDuckGo 被墙实测不可用）。可经 env 换源。
const SEARCH_URL = process.env.SEARCH_URL || 'https://www.bing.com/search';
const SEARCH_UA = process.env.SEARCH_UA || 'Mozilla/5.0 (compatible; xiaowang/1.0)';
// 发布页公网基址（publish_page 拼链接用）。默认走 router 公网端口；无域名先用 IP。
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// 已发布页面落盘目录（router 进程按 token 从这里读并公网服务；两进程共享同一路径）。
const PUBLISHED_DIR = resolve(process.env.PUBLISHED_DIR || join(DIR, 'published'));
const MAX_PAGE_BYTES = parseInt(process.env.MAX_PAGE_BYTES || String(512 * 1024), 10);

// ---- dedup_hash（契约权威算法：sha256 hex 前16，规范化后空格拼接） ----
// 必须与 durable.mjs / adapter.mjs / main.mjs 的 dedupHash 完全一致（同一逻辑消息跨路径
// 算出同一 hash 才能真正去重）。契约规定的分隔符是空格（join(' ')），这里对齐它——
// 之前用 '\0' 会与其它模块算出不同 hash，导致跨路径去重静默失效。
function dedupHash(parts) {
  const norm = parts.map((p) => String(p ?? '').trim()).join(' ');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// ---- 危险操作黑名单（callTool 对 dangerous 工具过这些正则） ----
// query_db：拦一切非 SELECT 开头的语句（写操作不该走只读工具）。
const SQL_WRITE_RE = /^\s*(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum|reindex)/i;
// http_get：拦内网/本地/云元数据地址防 SSRF。覆盖点分私网、链路本地、阿里云元数据(100.100.100.x)、
// IPv6 回环/ULA/链路本地，以及十六/八/十进制 IP 编码绕过（纯正则、不做 DNS 解析——按审计共识不上重型 SSRF 改造）。
const SSRF_PATTERNS = [
  /^https?:\/\/(localhost|127\.|0\.0\.0\.0|169\.254\.|100\.100\.100\.)/i,
  /^https?:\/\/10\./i,
  /^https?:\/\/192\.168\./i,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./i,
  /^https?:\/\/\[(::1|::|::ffff:|f[cd]|fe[89ab])/i,   // IPv6 回环/未指定/IPv4映射/ULA/链路本地
  /^https?:\/\/0x[0-9a-f]+([/:?#]|$)/i,               // 十六进制 IP (0x7f000001)
  /^https?:\/\/0[0-7]+(\.|[/:?#]|$)/i,                // 八进制 IP (0177.0.0.1)
  /^https?:\/\/\d{8,10}([/:?#]|$)/,                   // 纯十进制整数 IP (2130706433)
];

// ---- 沙箱路径解析（read_file/write_file 必经） ----
// 为什么断言 startsWith(SANDBOX_DIR + sep)：单纯 startsWith(SANDBOX_DIR) 会让
// /workspace-evil 通过；加分隔符确保是"目录内"而非"前缀相同"。
export function resolveSandboxPath(p) {
  if (typeof p !== 'string' || p.length === 0) throw new Error('path 不能为空');
  const resolved = resolve(SANDBOX_DIR, p);
  if (resolved !== SANDBOX_DIR && !resolved.startsWith(SANDBOX_DIR + sep)) {
    throw new Error('sandbox escape blocked: ' + p);
  }
  return resolved;
}

// 原子写：临时文件 → fsync → rename（自愈原则的文件产物保护，避免半截文件）
function atomicWrite(absPath, content) {
  const tmp = absPath + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
}

// =====================================================================
// 8 个工具的实现
// =====================================================================

// 1. memory_search —— 召回历史记忆（只读，无副作用）
// 渐进式记忆的按需层：除对话记录(episodes)外，也搜 facts（含被降级 unpin 的锚点原文）
// 和 notes 黑匣子（#快记/归档正文的权威正本）——"索引锚点/台账行只是索引，正文用
// memory_search 拉回"这条承诺在这里兑现。notes 可能是整篇档案，截断防塞爆（原则8）。
async function tool_memory_search(args) {
  const query = String(args.query ?? '');
  const k = clampInt(args.k, 8, 1, 30);
  const hits = retrieve(query, k);
  const facts = searchFacts(query, 6).map((f) => ({ id: f.id, entity: f.entity || null, fact: f.fact }));
  const notes = searchNotes(query, 3).map((n) => ({
    id: n.id,
    ts: n.ts,
    content: n.content.length > 1500 ? n.content.slice(0, 1500) + `…（截断，全文 ${n.content.length} 字，需要余下部分用 query_db 查 notes id=${n.id}）` : n.content,
  }));
  return { count: hits.length + facts.length + notes.length, results: hits, facts, notes };
}

// 2. memory_write —— 写记忆（有副作用：进 facts_staging 等人工确认，不直接入 facts）
async function tool_memory_write(args) {
  const fact = String(args.fact ?? '').trim();
  if (!fact) throw new Error('fact 不能为空');
  const id = stageFact({
    entity: args.entity ? String(args.entity) : null,
    fact,
    source: ['user_said', 'inferred', 'external'].includes(args.source) ? args.source : 'inferred',
  });
  return { staged_id: id, status: 'pending', note: '已进 staging，等人工确认后才入正式 facts' };
}

// 2b. pin_fact —— 子淇【显式】要记住某事时，直接钉成长期锚点（pinned=1，立即注入每轮上下文）。
// 与 memory_write 的边界（原则11，crisp 互不重叠）：
//   memory_write = 模型自己推断的事实 → 进 staging 等人工确认（半自动护栏）。
//   pin_fact     = 子淇明说"记住/钉住" → 直达 pinned 锚点，不经 staging。
// 这两件事此前被挤在一个 memory_write 里，导致"说记住"卡死在 staging（裂缝二）；拆成两个工具。
// 待办清单特征检测（纯代码启发式，零 LLM）：拦"把整张带日期的待办清单 pin 成记忆"这个高危错。
// 定位=堵最明显的整张清单，不是完美分类：宁松勿紧（3+ 日期 + 列表结构才拦，单个日期的事实放行）。
// 不违反原则11（不在 loop 前猜意图）——模型已自己选了 pin_fact，这是工具执行时的校验+回灌，模型仍是决策者。
export function looksLikeTodoList(text) {
  const s = String(text || '');
  // 日期出现次数：YYYY-MM-DD / M月D日 / M/D / 周X（含"下周X"）
  const dateHits = (s.match(/\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号]|\d{1,2}\/\d{1,2}|[下本这]?周[一二三四五六日天]/g) || []).length;
  // 列表结构：多个分隔项（分号/换行/编号/顿号列举）
  const segHits = (s.match(/[；;\n]|\d+[.、)]|[一二三四五]、/g) || []).length;
  // 待办语气词
  const todoWords = /待办|截止|前发群|DDL|deadline|要做|todo/i.test(s);
  // 拦：3+ 日期 且 有列表结构 且 带待办词（三者齐才拦，避免误伤含日期的普通事实）
  return dateHits >= 3 && segHits >= 2 && todoWords;
}

async function tool_pin_fact(args) {
  const fact = String(args.fact ?? '').trim();
  if (!fact) throw new Error('fact 不能为空');
  // 结构护栏（原则2：让错误变难）：整张带日期的待办清单该进面板不该 pin 成记忆——拦下+回灌指路，模型自纠。
  if (TODO_ENABLED && looksLikeTodoList(fact)) {
    throw new Error('这看起来是一整张带日期的待办清单——待办的家是面板，不要 pin 成长期记忆（会占常驻上下文、还会过期）。请改用 todo_add 把每件事分别加进待办面板；只有"关于他的稳定事实/偏好"才 pin_fact。');
  }
  const tier = args.tier === 'index' ? 'index' : 'core';
  const { id, deduped } = pinFact({ entity: args.entity ? String(args.entity) : null, fact, tier });
  return {
    fact_id: id,
    pinned: true,
    tier,
    deduped,
    note: deduped
      ? '已钉过(去重)'
      : tier === 'index'
        ? '已钉成索引锚点：每次对话带这一行索引，正文你到时用 memory_search 拉回'
        : '已钉成核心锚点，以后每次对话都全文记着',
  };
}

// 2c. unpin_fact —— 取消一条记错/过时的锚点（pin_fact 的逆操作，闭合本体"会忘但能纠正"）。
// 精确匹配不到时把当前锚点列出来让模型对准原话再试（原则11#3：要取消 X 先能看见 X，不靠猜 id）。
async function tool_unpin_fact(args) {
  const fact = String(args.fact ?? '').trim();
  if (!fact) throw new Error('fact 不能为空');
  const { unpinned } = unpinFact(fact);
  if (unpinned) return { unpinned: true, note: '已取消这条锚点，以后不再记着了' };
  const current = pinnedFacts().map((f) => f.fact);
  return {
    unpinned: false,
    note: '没找到完全匹配的锚点，没动任何东西。当前钉着的是这些，请用其中的原话再试：',
    current_pins: current,
  };
}

// 3. read_file —— 读沙箱内文件（只读）
async function tool_read_file(args) {
  const abs = resolveSandboxPath(args.path);
  if (!existsSync(abs)) throw new Error('文件不存在: ' + args.path);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error('是目录不是文件: ' + args.path);
  // 上限 256KB，防一次塞爆上下文（原则8）
  if (st.size > 256 * 1024) throw new Error(`文件过大(${st.size}B)，超过 256KB 上限`);
  return { path: args.path, content: readFileSync(abs, 'utf8') };
}

// 4. write_file —— 写沙箱内文件（有副作用：原子写）
async function tool_write_file(args) {
  const abs = resolveSandboxPath(args.path);
  const content = String(args.content ?? '');
  // 确保父目录在沙箱内（resolveSandboxPath 已校验整路径，这里只防父目录不存在）
  const parent = dirname(abs);
  if (!existsSync(parent)) throw new Error('父目录不存在: ' + args.path);
  atomicWrite(abs, content);
  return { path: args.path, bytes: Buffer.byteLength(content, 'utf8') };
}

// 5. http_get —— 外部 GET（有 timeout，无副作用但拦 SSRF）
async function tool_http_get(args) {
  const url = String(args.url ?? '');
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL');
  // 致命纪律②：AbortController + HTTP_TIMEOUT_MS
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'follow' });
    // 防重定向 SSRF（零回归纵深防护）：跟随跳转后，若【最终落点】落在内网/元数据网段，
    // 丢弃响应体不回灌给 agent——正常外网跳转 resp.url 仍是外网、照常返回，合法重定向不受影响。
    const finalUrl = resp.url || url;
    if (SSRF_PATTERNS.some((re) => re.test(finalUrl))) {
      throw new Error(`重定向落点被拦截(SSRF 防护): ${finalUrl}`);
    }
    const text = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      // 截断防塞爆上下文
      body: text.slice(0, 8192),
      truncated: text.length > 8192,
    };
  } catch (err) {
    throw new Error(`http_get 失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// 5b. web_search —— 上网搜索（无副作用）。补齐 http_get 只能"抓已知网址"的缺口：给关键词、拿网页列表。
// 无 SSRF 面：不接收 URL，只把 query 编码进【固定搜索主机】的 query 参数；拿到结果链接后模型再自行 http_get。
// 源=Bing RSS（无 key、国内服务器实测可达；Jina/DDG 被墙）。返回 [{title,url,snippet}]。
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&'); // &amp; 最后解，避免二次解码
}
function parseRssItems(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      if (!mm) return '';
      return decodeXmlEntities(mm[1].replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    };
    const title = pick('title');
    const url = pick('link');
    const snippet = pick('description');
    if (title || url) items.push({ title, url, snippet: snippet.slice(0, 300) });
  }
  return items;
}
// 带 timeout 的 JSON GET（各 JSON 源共用）。429=上游限流（无 key 的公共 API 常见），给可读提示不裸崩。
async function fetchJson(url, { headers = {}, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ac.signal, headers: { 'User-Agent': SEARCH_UA, Accept: 'application/json', ...headers } });
    if (resp.status === 429) throw new Error('上游限流(429)，过会儿再试');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// —— 各语料库检索：统一返回 [{title,url,snippet}]（国内服务器实测可达的源；YouTube/Reddit/X 被墙不在此） ——
async function searchBing(query, count) {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&format=rss&count=${count}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ac.signal, headers: { 'User-Agent': SEARCH_UA, Accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return parseRssItems(await resp.text()).slice(0, count);
  } finally {
    clearTimeout(timer);
  }
}
async function searchGithub(query, count) {
  const j = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${count}&sort=stars`, { headers: { Accept: 'application/vnd.github+json' } });
  return (j.items || []).slice(0, count).map((r) => ({
    title: r.full_name,
    url: r.html_url,
    snippet: `⭐${r.stargazers_count ?? '?'} ${r.language || ''} — ${(r.description || '').slice(0, 200)}`.trim(),
  }));
}
async function searchHuggingface(query, count) {
  // huggingface.co 国内被墙 → 走 hf-mirror.com（实测可达）；链接也给镜像域名，主人手机能打开。
  const base = (process.env.HF_BASE_URL || 'https://hf-mirror.com').replace(/\/+$/, '');
  const j = await fetchJson(`${base}/api/models?search=${encodeURIComponent(query)}&limit=${count}&sort=downloads&direction=-1`);
  return (Array.isArray(j) ? j : []).slice(0, count).map((m) => {
    const id = m.id || m.modelId || '';
    return { title: id, url: `${base}/${id}`, snippet: `↓${m.downloads ?? '?'} ♥${m.likes ?? '?'} ${m.pipeline_tag || ''}`.trim() };
  });
}
// OpenAlex 的 abstract 是"倒排索引"(词→位置数组)防拷贝——按位置还原成前若干词。
function reconstructAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (Array.isArray(positions)) for (const p of positions) words[p] = word;
  }
  return words.filter((w) => w != null).join(' ').trim();
}
async function searchPaper(query, count) {
  // 论文：OpenAlex（无 key、稳定、覆盖 arXiv 预印本——比 Crossref/SS 强；export.arxiv API 国内被墙）。
  // mailto 进"礼貌池"更稳；arXiv 论文优先给 arxiv.org 链接。
  const sel = 'title,doi,publication_year,authorships,primary_location,abstract_inverted_index';
  // 有 premium key 走 api_key（更高速率/更稳）；没 key 也能用（免费开放 + mailto 礼貌池）。
  const key = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : '';
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${count}&select=${sel}&mailto=xiaowang-bot@proton.me${key}`;
  const j = await fetchJson(url);
  return (j.results || []).slice(0, count).map((w) => {
    const authors = (w.authorships || []).slice(0, 3).map((a) => a.author && a.author.display_name).filter(Boolean).join(', ');
    const venue = (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '';
    const doi = (w.doi || '').replace('https://doi.org/', '');
    const arx = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
    const link = arx ? `https://arxiv.org/abs/${arx[1]}` : (w.doi || (w.primary_location && w.primary_location.landing_page_url) || '');
    const abs = reconstructAbstract(w.abstract_inverted_index);
    return {
      title: w.title || '',
      url: link,
      snippet: `${w.publication_year || ''} ${authors}${venue ? ' · ' + venue : ''}${abs ? ' — ' + abs.slice(0, 160) : ''}`.trim(),
    };
  });
}
const SEARCH_SOURCES = { web: searchBing, github: searchGithub, huggingface: searchHuggingface, paper: searchPaper };

// 5b. search —— 外部检索（无副作用）。补 http_get 只能"抓已知网址"的缺口。
// source 选语料库；各源统一返回 [{title,url,snippet}]。无 SSRF 面（不收 URL，query 编码进各源固定主机）。
async function tool_search(args) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query 不能为空');
  const source = ['web', 'github', 'huggingface', 'paper'].includes(args.source) ? args.source : 'web';
  const count = clampInt(args.count, 6, 1, 10);
  try {
    const results = (await SEARCH_SOURCES[source](query, count)).filter((r) => r.title || r.url);
    if (!results.length) return { query, source, count: 0, results: [], note: '没搜到（换关键词，或换 source）' };
    return { query, source, count: results.length, results };
  } catch (err) {
    throw new Error(`search(${source}) 失败: ${err.message}`);
  }
}

// 5c. read_page —— 抓一个网址并抽【可读正文】（无副作用）。比 http_get 强：去脚本/样式/标签，返回全文。
// 治 http_get 返回一坨原始 HTML 塞爆上下文；SSRF 同 http_get（拦内网/元数据 + 跟随重定向后复检最终落点）。
function extractReadableText(html) {
  let s = String(html);
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeXmlEntities(titleM[1]).replace(/\s+/g, ' ').trim() : '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeXmlEntities(s).replace(/[ \t\f\v\r]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return { title, text: s };
}
async function tool_read_page(args) {
  const url = String(args.url ?? '');
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL');
  if (SSRF_PATTERNS.some((re) => re.test(url))) throw new Error('read_page 拦截内网/本地地址(SSRF 防护)');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': SEARCH_UA } });
    const finalUrl = resp.url || url;
    if (SSRF_PATTERNS.some((re) => re.test(finalUrl))) throw new Error(`重定向落点被拦截(SSRF 防护): ${finalUrl}`);
    const raw = (await resp.text()).slice(0, 2 * 1024 * 1024); // 原始 HTML 上限 2MB
    const { title, text } = extractReadableText(raw);
    return { url: finalUrl, title, text: text.slice(0, 12000), truncated: text.length > 12000 };
  } catch (err) {
    throw new Error(`read_page 失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// 5c. publish_page —— 把一段 HTML 发布成一个公网可访问的网页，返回链接（有副作用：原子写文件）。
// 数据分析/图表/报告 → 模型自己写 HTML（图表用 ECharts CDN）→ 这里落盘 + 拼公网链接 → 模型把链接发给主人。
// 安全：token 随机不可枚举；只产出 <token>.html；router 侧服务时再校验 token 白名单字符防穿越。
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 模型只给了 body 片段（没写 <html>/<!doctype>）时，包一层最小骨架：utf-8 + 手机 viewport + 标题。
function wrapHtml(title, inner) {
  if (/<html[\s>]/i.test(inner) || /<!doctype/i.test(inner)) return inner;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${inner}</body></html>`;
}
async function tool_publish_page(args) {
  // base/dir 在调用时读 env（默认取模块常量）：让 selftest 能指向临时值，也与 MEDIA_DIR 同款。
  const baseUrl = (process.env.PUBLIC_BASE_URL || PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const dir = resolve(process.env.PUBLISHED_DIR || PUBLISHED_DIR);
  const title = (String(args.title ?? '').trim()) || '小王报告';
  const raw = String(args.html ?? '');
  if (!raw.trim()) throw new Error('html 不能为空');
  if (!baseUrl) throw new Error('未配置 PUBLIC_BASE_URL，无法发布公网页面');
  const html = wrapHtml(title, raw);
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_PAGE_BYTES) throw new Error(`页面过大(${bytes}B)，超过 ${Math.round(MAX_PAGE_BYTES / 1024)}KB 上限`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const token = randomBytes(9).toString('base64url'); // url-safe，约 12 字符，不可枚举
  atomicWrite(join(dir, `${token}.html`), html);
  const url = `${baseUrl}/p/${token}`;
  return { url, title, bytes, note: `页面已发布：${url} —— 把这个链接发给${IDENTITY.ownerName}，他在手机上点开就能看。` };
}

// 6. schedule_task —— 排定时任务/提醒（有副作用：写 tasks/timers）
//
// 时间参数只收人类单位（原则11：参数 crisp，让错的表达无法写出）。旧版收 delay_ms/fire_at
// 让 LLM 自己换算毫秒，线上被实测证伪：fire_at 传成秒级 epoch（当毫秒解析=1970=过去→立刻触发，
// 两租户共 5 例）、"一小时"传 60000（分钟当毫秒→1 分钟就响）。现在：
//   delay_minutes（1小时=60）或 at（东八区 'HH:MM' / 'YYYY-MM-DD HH:MM'）二选一，
//   算出的触发时刻必须在未来——不满足就把可操作的错误回灌给模型自纠（执行回灌）。
const fmtCst = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
function parseAtCst(s) {
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (m) return new Date(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00+08:00`).getTime();
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    // 'HH:MM' = 今天的这个时刻；已过则算明天（"8点提醒我"的人类语义）
    const dateStr = new Date(nowMs() + 8 * 3600e3).toISOString().slice(0, 10);
    let t = new Date(`${dateStr}T${m[1].padStart(2, '0')}:${m[2]}:00+08:00`).getTime();
    if (t <= nowMs()) t += 86400e3;
    return t;
  }
  throw new Error("at 需 'HH:MM'（今天，已过算明天）或 'YYYY-MM-DD HH:MM'，东八区");
}
async function tool_schedule_task(args, ctx) {
  let fireAt;
  if (args.delay_minutes != null && String(args.delay_minutes).trim() !== '') {
    const m = Number(args.delay_minutes);
    if (!Number.isFinite(m) || m <= 0) throw new Error('delay_minutes 需为正数（单位分钟）：1小时=60、明天此刻≈1440');
    if (m > 60 * 24 * 366) throw new Error(`delay_minutes=${m} 超过一年——确认单位是分钟（1小时=60），不是毫秒/秒`);
    fireAt = nowMs() + Math.round(m * 60000);
  } else if (args.at != null && String(args.at).trim() !== '') {
    fireAt = parseAtCst(String(args.at).trim());
  } else {
    throw new Error("需要 delay_minutes（多少分钟后，1小时=60）或 at（东八区 'HH:MM' / 'YYYY-MM-DD HH:MM'）");
  }
  if (fireAt <= nowMs()) throw new Error(`算出的触发时刻已过去（${fmtCst(fireAt)} CST）——如果想说明天，用 'HH:MM'（自动算明天）或写全日期`);
  const payload = {
    note: String(args.note ?? ''),
    target: ctx?.sessionId ?? null,
    origin_task: ctx?.taskId ?? null,
  };
  // 排一个 agentic 任务承载提醒逻辑，并落 timer 到点唤醒它。
  // 幂等键按 conventions：dedupHash([kind, payload, 业务键(fireAt)])
  const idem = dedupHash(['agentic', JSON.stringify(payload), String(fireAt)]);
  const { taskId, deduped } = createTask({
    kind: 'agentic',
    payload,
    idempotencyKey: idem,
    nextRunAt: fireAt,
  });
  const timerId = scheduleTimer({ fireAt, taskId, payload, catchupPolicy: 'once' });
  // fire_at_cst：给模型一个人类可读时刻，回复主人时不用自己换算（换算正是事故来源）
  return { task_id: taskId, timer_id: timerId, fire_at: fireAt, fire_at_cst: `${fmtCst(fireAt)} CST`, deduped };
}

// 7. send_message —— 给 owner 发消息（有副作用：走 outbox，绝不直发）
async function tool_send_message(args, ctx) {
  const content = String(args.content ?? '').trim();
  if (!content) throw new Error('content 不能为空');
  const channel = args.channel || 'wecom';
  // 安全·Schema 层（团队原则3）：收件人【恒为 owner】，忽略 LLM 给的 target。
  // n=1 只发本实例 owner 自己，杜绝二阶 prompt injection 借小王身份给第三方发消息/外泄；模型也无法误填 target 发错人。
  // 收件人以 OWNER_ID 为单一真相源（跟入站门禁同一个），WECOM_TARGET_ID 仅作历史回落——
  // 二者曾在租户配置里分叉过（friend 的 target 停在老测试号→主动推送发错人），OWNER_ID 优先根治该类。
  const target = String(
    process.env.OWNER_ID ||
    process.env.WECOM_TARGET_ID ||
    (ctx?.sessionId ? String(ctx.sessionId).replace(/^wecom:/, '') : '') ||
    ''
  );
  if (!target) throw new Error('无收件人(owner 未配置 WECOM_TARGET_ID/OWNER_ID)');
  // dedup_hash 按 conventions：[channel, target, content, taskId ?? '']
  const hash = dedupHash([channel, target, content, ctx?.taskId ?? '']);
  const { id, deduped } = enqueueOutbox({ channel, target, content, dedupHash: hash });
  return { outbox_id: id, deduped, status: deduped ? '已派过(去重)' : 'queued' };
}

// 9. record_checkin —— 登记子淇对晨/晚打卡的回复（终止工具：确定性登记 + 固定中性回执，结构守红线）
async function tool_record_checkin(args, ctx) {
  // 原话以 harness 持有的真实输入为准（ctx.userInput），不信任模型对原话的复述（防改写污染不可逆层）。
  const raw = String(ctx?.userInput ?? args?.raw_text ?? '').trim();
  const out = await recordCheckin(getDb(), raw);
  if (!out.ok) throw new Error(out.error);
  return { reply: out.reply, terminal: true }; // terminal:true → loop 用 reply 收尾并丢弃模型自由发挥
}

// 8. query_db —— 只读查库（参数化，黑名单已在 callTool 拦非 SELECT）
async function tool_query_db(args) {
  const sql = String(args.sql ?? '');
  const params = Array.isArray(args.params) ? args.params : [];
  // 双保险：这里再校验一次（callTool 的 dangerous 黑名单是第一道）
  if (SQL_WRITE_RE.test(sql)) throw new Error('query_db 只读，拒绝非 SELECT 语句');
  if (/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''))) throw new Error('不允许多语句(分号拼接)');
  const db = getDb();
  const stmt = db.prepare(sql);
  // 参数化：占位符 ? 由 params 填充，绝不字符串拼接
  const rows = stmt.all(...params);
  // 上限 200 行防塞爆上下文
  return { rows: rows.slice(0, 200), truncated: rows.length > 200, total: rows.length };
}

// 10. get_weather —— 按需查天气（确定性，复用 weather.mjs 高德链路）。
// 为什么要它：子淇随口问"明天天气"时，agent 之前只能用 http_get 去抓天气站（常被挡/超时，
// 线上真出现过"几个气候站都被挡了"），或凭记忆瞎说。这里直接走已验证的高德链路给准数据。
// 边界：这是【按需问答】；每天定点的天气播报是 recurring builtin（不经 agent、无 AI 味），别拿它"设每天播报"。
async function tool_get_weather(args) {
  const defaultCity = (IDENTITY.weatherMorningCities && IDENTITY.weatherMorningCities[0]) || '上海';
  const city = String(args.city ?? defaultCity).trim() || defaultCity;
  if (!ADCODE[city]) throw new Error(`暂只支持 ${Object.keys(ADCODE).join('/')}；「${city}」没有。`);
  const days = clampInt(args.days, 4, 1, 4); // 高德 forecast = 今 + 未来 3 天，最多 4
  const text = await weatherBriefing({ cities: [city], fromIdx: 0, days });
  return { city, days, weather: text };
}

// 11. schedule_recurring —— 排一个【每天/每周固定时刻】重复做的事（复用 recurring.mjs，agentic kind）。
// 与 schedule_task 的边界：schedule_task=一次性（几分钟后/某绝对时刻触发一次）；本工具=重复。
// 到点 worker 会把 task 当一件事派给 agent 去做（可调别的工具，如 get_weather）。
async function tool_schedule_recurring(args) {
  const db = getDb();
  initRecurringSchema(db); // 防御性幂等（正常 main 启动已建表）
  const name = String(args.name ?? '').trim();
  const time = String(args.time ?? '').trim();
  const task = String(args.task ?? '').trim();
  if (!name) throw new Error('name（给周期任务起个短名，如"吃药提醒"）不能为空');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("time 需 24 小时制 'HH:MM'，如 08:30");
  if (!task) throw new Error('task（到点要做/提醒什么）不能为空');
  // weekday 可选：0=周日…6=周六，省略=每天
  let dow = null;
  if (args.weekday != null && String(args.weekday).trim() !== '') {
    const n = Number.parseInt(args.weekday, 10);
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error('weekday 需 0-6(0=周日)，省略=每天');
    dow = n;
  }
  // until 可选：'YYYY-MM-DD' 截止日（含当天），过后 worker 自动禁用。没有它时，"每天提醒直到周六"
  // 的"直到"半截意图会被 schema 静默丢弃、只能建成无限期任务——过了 DDL 继续天天响（2026-07-23 事故根源）。
  let until = null;
  if (args.until != null && String(args.until).trim() !== '') {
    until = String(args.until).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("until 需 'YYYY-MM-DD'，如 2026-07-25");
    const todayCst = new Date(nowMs() + 8 * 3600e3).toISOString().slice(0, 10);
    if (until < todayCst) throw new Error(`until=${until} 已是过去的日期（今天 ${todayCst}）。限期已过的事别再排提醒`);
  }
  // 同名护栏分两种（修线上死锁：cancel 只禁用不删行，旧逻辑连禁用行也挡同名、
  // 而 list_schedules 又不显示禁用行 → 取消过的名字永远建不回来且模型看不见挡路的是谁）：
  //   启用中的同名 → 拦（防重试/口误双发），指引先取消再建；
  //   禁用的同名   → 原地复活+更新时间/内容（"重新设一个同名的"就是用户想要的语义）。
  const existing = listJobs(db).find((j) => j.name === name);
  const when = dow == null ? '每天' : `每周${'日一二三四五六'[dow]}`;
  if (existing && existing.enabled) {
    return { ok: false, recurring_id: existing.id, note: `已有同名周期任务「${name}」(id=${existing.id})正在生效。要改时间/内容，先 cancel_schedule 取消它再重建。` };
  }
  const untilNote = until ? `，${until} 当天过后自动停` : '';
  if (existing) {
    reviveJob(db, existing.id, { fireHm: time, dow, action: { message: task }, expiresOn: until });
    return { recurring_id: existing.id, name, schedule: `${when} ${time}`, task, ...(until ? { until } : {}), note: `「${name}」此前被取消过，已按新时间/内容重新启用${untilNote}` };
  }
  const id = addJob(db, { name, fireHm: time, dow, kind: 'agentic', action: { message: task }, expiresOn: until });
  return { recurring_id: id, name, schedule: `${when} ${time}`, task, ...(until ? { until } : {}), note: `已排定，到点我会自动去做${untilNote}` };
}

// 12. list_schedules —— 列出当前所有定时安排（周期 + 一次性待触发）。只读。
// 原则11#3「要取消/改 X，先得能列出 X」：给模型真实 id，cancel_schedule 才有据可依（不靠猜）。
async function tool_list_schedules() {
  const db = getDb();
  initRecurringSchema(db);
  const recurring = listJobs(db)
    .filter((j) => j.enabled)
    .map((j) => ({ id: j.id, name: j.name, schedule: `${j.dow == null ? '每天' : '每周' + '日一二三四五六'[j.dow]} ${j.fire_hm}`, ...(j.expires_on ? { until: j.expires_on } : {}) }));
  const onetime = db
    .prepare(`SELECT id, next_run_at, payload FROM tasks WHERE status='pending' AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 30`)
    .all()
    .map((t) => {
      let note = '';
      try { note = (JSON.parse(t.payload) || {}).note || ''; } catch { /* payload 坏不拖垮列举 */ }
      return { id: t.id, fire_at: t.next_run_at, fire_at_cst: `${fmtCst(t.next_run_at)} CST`, note };
    });
  // 最近已结束的一次性任务（含被取消的）也给模型看：只列 pending 的话，"排了但已经触发/被取消"
  // 在模型眼里等于"从来没排过"——线上真发生过它据此错误自我诊断"我没调工具"（其实调了、只是立刻触发了）。
  // 状态可见（原则11#3）也要覆盖"刚发生过什么"，不只"接下来有什么"。
  const recentDone = db
    .prepare(`SELECT id, next_run_at, payload, result FROM tasks WHERE status='done' AND next_run_at IS NOT NULL ORDER BY id DESC LIMIT 5`)
    .all()
    .map((t) => {
      let note = '', cancelled = false;
      try { note = (JSON.parse(t.payload) || {}).note || ''; } catch { /* 同上 */ }
      try { cancelled = (JSON.parse(t.result) || {}).cancelled === true; } catch { /* 同上 */ }
      return { id: t.id, fired_at_cst: `${fmtCst(t.next_run_at)} CST`, note, ...(cancelled ? { cancelled: true } : {}) };
    });
  return { recurring, onetime, recent_done: recentDone, empty: recurring.length === 0 && onetime.length === 0 };
}

// 14. report_to_operator —— 把主人的需求/意见/做不到的事上报给运营者（老王=子淇）。
// 为什么存在：朋友提"让王哥把西安天气覆盖一下"，小王只能回"我做不到，你自己跟他说"→需求断链，
// 运营者永远不知道（2026-07-06 实录，多租户第一块反馈闭环）。
// 安全·Schema 层：收件人结构性锁死 OPERATOR_ID，不收 target 参数——与 send_message 锁 owner 同一套
// 思路：本工具只能发运营者、send_message 只能发主人，二阶注入借不到任何第三方通道。
// 副本落本租户 notes 黑匣子（不可逆备查，报了什么何时可对账）。
// 仅在 OPERATOR_ID 配置且 ≠ OWNER_ID 时注册（运营者自己的实例没有"上报自己"的需求——原则7 工具位珍贵）。
const HAS_OPERATOR = !!(process.env.OPERATOR_ID && String(process.env.OPERATOR_ID) !== String(process.env.OWNER_ID || ''));
async function tool_report_to_operator(args, ctx) {
  const operator = String(process.env.OPERATOR_ID || '');
  if (!operator) throw new Error('未配置 OPERATOR_ID，无法上报');
  const content = String(args.content ?? '').trim();
  if (!content) throw new Error('content 不能为空：一两句写清主人想要什么/遇到了什么');
  const text = `【${IDENTITY.ownerName}实例·小王上报】${content}`;
  const hash = dedupHash(['wecom', operator, text, ctx?.taskId ?? '']);
  const { id, deduped } = enqueueOutbox({ channel: 'wecom', target: operator, content: text, dedupHash: hash });
  try { appendNote({ sessionId: ctx?.sessionId ?? null, content: `[上报老王] ${content}`, source: 'report' }); }
  catch (e) { console.error('[tools] report_to_operator notes 副本失败(不阻断上报): %s', e.message); }
  return { outbox_id: id, deduped, note: deduped ? '这条已经报过了（去重，不重复打扰老王）' : '已上报给老王，他看到会评估' };
}

// 13. cancel_schedule —— 取消一个周期任务或一次性提醒（按 list_schedules 给的 type+id）。
// 周期任务：禁用(enabled=0，可逆、不删行——保留台账便于将来恢复/对账)。
// 一次性：pending 任务标 done(cancelled)，runDueTasks 不再跑它；其绑定 timer 因 task_id 在只空转记录、不发送。
async function tool_cancel_schedule(args) {
  const db = getDb();
  initRecurringSchema(db);
  const type = String(args.type ?? '').trim();
  const id = Number.parseInt(args.id, 10);
  if (!Number.isInteger(id) || id < 1) throw new Error('id 无效（用 list_schedules 给出的数字 id）');
  if (type === 'recurring') {
    const job = listJobs(db).find((j) => j.id === id);
    if (!job) throw new Error(`没有 id=${id} 的周期任务（先 list_schedules 看看）`);
    setEnabled(db, id, 0);
    return { cancelled: 'recurring', id, name: job.name, note: `已停掉「${job.name}」` };
  }
  if (type === 'task') {
    const t = db.prepare(`SELECT id, status, payload FROM tasks WHERE id=?`).get(id);
    if (!t) throw new Error(`没有 id=${id} 的一次性提醒`);
    let p = {}; try { p = JSON.parse(t.payload) || {}; } catch { /* ignore */ }
    if (t.status !== 'pending') {
      // 修复指引（2026-07-23）：周期任务每次触发会物化一个 task 行，模型想停"每天都响"时常错拿
      // 已 done 的实例 id 来取消 → 撞死胡同后放弃、周期照响。报错必须指回正确目标，不能只说"取消不了"。
      if (p.recurring_id) {
        throw new Error(`这条是周期任务「${p.recurring_name || ''}」(id=${p.recurring_id})的一次已触发实例（状态 ${t.status}），取消它拦不住以后的重复触发。要彻底停掉，用 cancel_schedule type=recurring id=${p.recurring_id}`);
      }
      throw new Error(`这条提醒状态是 ${t.status}，不是待触发，取消不了。若这件事以后还会重复响，说明它来自某个周期任务——用 list_schedules 找到那条周期任务的 id，再 cancel_schedule type=recurring`);
    }
    markTaskDone(id, { cancelled: true, reason: '用户取消' });
    const extra = p.recurring_id ? `。注意：它来自周期任务「${p.recurring_name || ''}」(id=${p.recurring_id})，只取消了本次；要彻底停掉用 type=recurring id=${p.recurring_id}` : '';
    return { cancelled: 'task', id, note: (p.note || '(一次性提醒)') + extra };
  }
  throw new Error("type 需 'recurring'（周期任务）或 'task'（一次性提醒）");
}

// 15-17. 待办面板三件套（TODO_SECRET 配置的实例才注册）。
// 与调度工具的边界：待办=清单上的一件事（没做完自动滚到明天、页面上可勾可改）；
// schedule_task=纯提醒响一次就完。一件事既上清单又要提醒 → todo_add 带 remind_at，一次搞定。
// 页面（actor=web）与这里（actor=agent）落同一张表，todo_events 流水可区分是谁动的。
async function tool_todo_add(args, ctx) {
  const db = getDb();
  initTodoSchema(db);
  const r = addTodo(db, {
    title: args.title,
    detail: args.detail ?? '',
    links: Array.isArray(args.links) ? args.links : [],
    tag: args.tag ?? null,
    day: args.day,
    source: 'wechat',
    actor: 'agent',
  });
  let reminder = null;
  if (args.remind_at != null && String(args.remind_at).trim() !== '') {
    reminder = setTodoReminder(db, r.id, String(args.remind_at).trim(), { sessionId: ctx?.sessionId ?? null, panelUrl: TODO_PANEL_URL, actor: 'agent' });
  }
  return { id: r.id, day: r.day, ...(reminder ? { reminder: reminder.fire_at_cst } : {}), panel_url: TODO_PANEL_URL };
}

async function tool_todo_update(args, ctx) {
  const db = getDb();
  initTodoSchema(db);
  const id = Number.parseInt(args.id, 10);
  if (!Number.isInteger(id) || id < 1) throw new Error('id 无效（先 todo_list 拿真实 id，别猜）');
  const action = String(args.action ?? '');
  switch (action) {
    case 'done': return completeTodo(db, id, 'agent');
    case 'reopen': return reopenTodo(db, id, 'agent');
    case 'drop': return dropTodo(db, id, 'agent');
    case 'park': return parkTodo(db, id, 'agent');
    case 'unpark': return unparkTodo(db, id, 'agent');
    case 'defer': return deferTodo(db, id, args.day, 'agent');
    case 'note': return appendDetail(db, id, args.text, 'agent');
    case 'link': return addLink(db, id, args.url, 'agent');
    case 'edit': return editTodo(db, id, { title: args.title, tag: args.tag }, 'agent');
    case 'remind': return setTodoReminder(db, id, args.at, { sessionId: ctx?.sessionId ?? null, panelUrl: TODO_PANEL_URL, actor: 'agent' });
    case 'remind_cancel': return cancelTodoReminder(db, id, 'agent');
    default: throw new Error(`action「${action}」不认识（可用：done/reopen/drop/park/unpark/defer/note/link/edit/remind/remind_cancel）`);
  }
}

async function tool_todo_list(args) {
  const db = getDb();
  initTodoSchema(db);
  rolloverSweep(db); // 读前先滚（与 worker 每拍、页面 API 读前同一纪律：谁先碰到新的一天谁负责滚）
  const scope = String(args?.scope ?? 'today');
  const st = getTodoState(db, { historyDays: clampInt(args?.history_days, 7, 1, 90) });
  const brief = (t) => ({
    id: t.id,
    title: t.title,
    ...(t.tag ? { tag: t.tag } : {}),
    ...(t.rollover_count >= 1 ? { days_pending: t.rollover_count + 1 } : {}), // 第N天（挂账）
    ...(t.reminder ? { remind_at: t.reminder.fire_at_cst } : {}),
    ...(t.detail ? { note: t.detail.length > 60 ? t.detail.slice(0, 60) + '…' : t.detail } : {}),
    ...(t.links.length ? { links: t.links } : {}),
  });
  const todayGroup = st.days.find((g) => g.day === st.today);
  const out = {
    today: st.today,
    today_items: (todayGroup?.todos || []).map(brief),
    today_done_count: st.stats.today_done,
    panel_url: TODO_PANEL_URL,
  };
  const future = st.days.filter((g) => g.day !== st.today);
  if (future.length) out.future = future.map((g) => ({ day: g.day, items: g.todos.map((t) => ({ id: t.id, title: t.title })) }));
  if (st.parked.length) out.parked = st.parked.map((t) => ({ id: t.id, title: t.title }));
  if (scope === 'history' || scope === 'all') {
    out.history = st.history.map((g) => ({
      day: g.day,
      done: g.todos.filter((t) => t.status === 'done').map((t) => t.title),
      ...(g.todos.some((t) => t.status === 'dropped') ? { dropped: g.todos.filter((t) => t.status === 'dropped').map((t) => t.title) } : {}),
    }));
  }
  return out;
}

// =====================================================================
// 注册表
// =====================================================================
// home_ac —— 控制家里的空调（经家中 Jetson 上的 Home Assistant，ziqi-only 条件注册）。
// 为什么要它：子淇的核心诉求就是"空调冷了还得从手机里翻 App 切除湿"这类 context-switch 琐碎，
// 现在一句微信话搞定。设备=米家空调伴侣插座（IR 码库控真空调），HA 暴露成 climate 实体。
// 边界：只控 env 配好的这一台实体；模型不能传 URL/实体 id（见 HA_ENABLED 常量注释）。
async function haFetch(path, { method = 'GET', body = null } = {}) {
  // 致命纪律②：AbortController + HTTP_TIMEOUT_MS
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(`${HA_URL}${path}`, {
      method,
      signal: ac.signal,
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!resp.ok) throw new Error(`HA 返回 ${resp.status}（401=令牌失效，404=实体不在了）`);
    return await resp.json();
  } catch (err) {
    throw new Error(`家里的 Home Assistant 没够着：${err.message}（可能家里断网/Jetson 掉线/隧道断了）`);
  } finally {
    clearTimeout(timer);
  }
}

const HA_AC_MODES = ['cool', 'dry', 'heat', 'fan_only', 'auto', 'off'];

async function tool_home_ac(args) {
  const action = String(args.action ?? 'status');
  if (action === 'status') {
    const st = await haFetch(`/api/states/${HA_AC_ENTITY}`);
    const out = {
      mode: st.state, // off/cool/dry/heat/fan_only/auto
      target_temp: st.attributes?.temperature ?? null,
      running: st.attributes?.hvac_action ?? null, // cooling/drying/idle/off——设备正在干什么
      fan: st.attributes?.fan_mode ?? null,
    };
    if (HA_AC_POWER_ENTITY) {
      try {
        const p = await haFetch(`/api/states/${HA_AC_POWER_ENTITY}`);
        out.power_w = Number.parseFloat(p.state) || 0; // 实测功率：交叉验证空调是否真在跑
      } catch { /* 功率传感器读不到不影响主状态 */ }
    }
    return out;
  }
  if (action !== 'set') throw new Error("action 只有 'status'（查状态）和 'set'（改模式/温度）两种");
  const mode = args.mode != null && String(args.mode).trim() !== '' ? String(args.mode).trim() : null;
  const temp = args.temp == null || args.temp === '' ? null : Number.parseFloat(args.temp);
  if (!mode && temp == null) throw new Error('set 至少要给 mode（模式）或 temp（温度）之一');
  if (mode && !HA_AC_MODES.includes(mode)) throw new Error(`mode 需是 ${HA_AC_MODES.join('/')} 之一（除湿=dry，制冷=cool，关=off）`);
  if (temp != null && (!Number.isFinite(temp) || temp < 16 || temp > 30)) throw new Error('temp 需 16-30（℃）');
  const done = [];
  if (mode) {
    await haFetch('/api/services/climate/set_hvac_mode', { method: 'POST', body: { entity_id: HA_AC_ENTITY, hvac_mode: mode } });
    done.push(`模式→${mode}`);
  }
  if (temp != null && mode !== 'off') {
    await haFetch('/api/services/climate/set_temperature', { method: 'POST', body: { entity_id: HA_AC_ENTITY, temperature: Math.round(temp) } });
    done.push(`温度→${Math.round(temp)}℃`);
  }
  // 回读真实状态作为回执——空调伴侣是 IR 单向下发，HA 里的实体状态才是最可信来源，
  // 不凭"指令发出去了"就当成功（谎报教训的结构化落地）。
  const st = await haFetch(`/api/states/${HA_AC_ENTITY}`);
  return { done: done.join('，'), mode: st.state, target_temp: st.attributes?.temperature ?? null };
}

export const TOOLS = [
  {
    name: 'memory_search',
    description: '检索历史记忆：对话记录(results)、事实库(facts，含不再常驻的锚点原文)、黑匣子笔记(notes，#快记与归档正文)。用于回忆聊过什么，也用于把「专题守则索引」行、文件台账里提到的内容的正文拉回来。',
    paramSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言描述' },
        k: { type: 'integer', description: '返回条数，默认 8，最多 30' },
      },
      required: ['query'],
    },
    fn: tool_memory_search,
    sideEffect: false,
  },
  {
    name: 'memory_write',
    description: `把你从对话里【推断/观察】到的、关于${IDENTITY.ownerName}的事实写入暂存区（staging），等人工确认后才成为正式事实。用于你觉得值得记、但他没明说要记的事。他【明确要你记住/钉住】某事时改用 pin_fact（直接生效、不进暂存）。不要写未经证实的猜测。`,
    paramSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: '要记住的事实，一句话' },
        entity: { type: 'string', description: '事实所属主题/实体，可选' },
        source: { type: 'string', enum: ['user_said', 'inferred', 'external'], description: '来源' },
      },
      required: ['fact'],
    },
    fn: tool_memory_write,
    sideEffect: true,
  },
  {
    name: 'pin_fact',
    description: `当${IDENTITY.ownerName}【明确要你记住/钉住】某事时调用（他说"记住…""记一下…""以后都…"这类显式指令），直接把它钉成长期锚点——立刻生效、之后每次对话都带着。只在他显式要求记住时用；你自己从对话里觉得重要、但他没明说要记的，用 memory_write（进暂存区等确认）。两档：tier=core 每轮全文在场（席位很少，只给身份/铁律级的事）；tier=index 每轮只带一行索引、正文到时用 memory_search 拉回（专题守则/清单/框架/文件指路都用这档）。`,
    paramSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: '要长期记住的事，一句话（尽量含具体信息，别只写"那件事"）。tier=index 时写成索引行：是什么+正文去哪拉（如 memory_search 用什么词、或 read_file 哪个路径）' },
        entity: { type: 'string', description: '所属主题/实体，可选（如"居住""偏好""工作"）' },
        tier: { type: 'string', enum: ['core', 'index'], description: '默认 core。内容是专题性的（只在聊到该话题时才用得上）→ 用 index' },
      },
      required: ['fact'],
    },
    fn: tool_pin_fact,
    sideEffect: true,
  },
  {
    name: 'unpin_fact',
    description: `当${IDENTITY.ownerName}要你【取消/纠正/撤回】之前钉住的某条长期记忆时调用（他说"别记X了""那条记错了""忘掉X""我不再…了"）。传入要取消那条锚点的原话（尽量用你看到的锚点原文）。这是 pin_fact 的逆操作；若没完全匹配上，工具会把当前钉着的锚点列给你，用准确原话再试。`,
    paramSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: '要取消的那条锚点的原话（与当前钉着的某条尽量一致）' },
      },
      required: ['fact'],
    },
    fn: tool_unpin_fact,
    sideEffect: true,
  },
  {
    name: 'read_file',
    description: '读取沙箱工作目录内的文本文件。路径相对于沙箱根，禁止越界。',
    paramSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '沙箱内相对路径' } },
      required: ['path'],
    },
    fn: tool_read_file,
    sideEffect: false,
  },
  {
    name: 'write_file',
    description: '写入沙箱工作目录内的文本文件（原子写）。路径相对于沙箱根，禁止越界。',
    paramSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱内相对路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    fn: tool_write_file,
    sideEffect: true,
  },
  {
    name: 'http_get',
    description: '对外部 URL 发 GET 请求并返回响应体（截断）。仅 http/https，拦内网地址防 SSRF，带超时。',
    paramSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 http/https URL' } },
      required: ['url'],
    },
    fn: tool_http_get,
    sideEffect: false,
    dangerous: true, // 过 SSRF 黑名单
  },
  {
    name: 'schedule_task',
    description: "排一个未来触发的一次性任务/提醒，到点我会自动去做 note 里的事。时间二选一：delay_minutes=多少分钟后（半小时=30、1小时=60、明天此刻≈1440）；at=绝对时刻（东八区，'HH:MM' 表示今天该时刻、已过自动算明天，或 'YYYY-MM-DD HH:MM'）。每天/每周重复的用 schedule_recurring。",
    paramSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '提醒内容/任务说明' },
        delay_minutes: { type: 'number', description: '多少分钟后触发（正数，可小数）。1小时=60，一天=1440' },
        at: { type: 'string', description: "绝对触发时刻：'HH:MM'（今天，已过算明天）或 'YYYY-MM-DD HH:MM'，东八区" },
      },
      required: ['note'],
    },
    fn: tool_schedule_task,
    sideEffect: true,
  },
  {
    name: 'send_message',
    description: `给${IDENTITY.ownerName}发一条消息（走 outbox，至少一次投递+尽力去重）。需要主动告知/提醒${IDENTITY.ownerName}时用，不要把内容只写进回复正文。固定发给${IDENTITY.ownerName}本人，无需也不能指定收件人。`,
    paramSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '消息正文' },
      },
      required: ['content'],
    },
    fn: tool_send_message,
    sideEffect: true,
  },
  {
    name: 'query_db',
    description: '只读查询小王的数据库（SELECT，参数化）。可查 tasks/timers/outbox/episodes/facts 等表。禁止写操作和多语句。',
    paramSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '单条 SELECT 语句，用 ? 占位符' },
        params: { type: 'array', description: '占位符参数数组', items: {} },
      },
      required: ['sql'],
    },
    fn: tool_query_db,
    sideEffect: false,
    dangerous: true, // 过非 SELECT 黑名单
  },
  {
    name: 'record_checkin',
    description: `当${IDENTITY.ownerName}在回答你刚发的晨/晚自检打卡时调用，把他这条原话登记进采集库。只在他确实是在回打卡时调（说睡眠/精力/压力/情绪/喝酒咖啡运动这类）。这是纯登记动作，登记完只会回一句中性确认——你【绝不要】在调用前后对内容做任何评价/解读/打分/安慰/建议（采集红线）。他要不是在回打卡（是别的请求/闲聊/指令），就别调这个工具，正常帮他。`,
    paramSchema: {
      type: 'object',
      properties: {
        raw_text: { type: 'string', description: `${IDENTITY.ownerName}这条打卡回复的原话（系统会以实际收到的消息为准，你照填即可）` },
      },
      required: [],
    },
    fn: tool_record_checkin,
    sideEffect: true,
  },
  {
    name: 'get_weather',
    description: `查某城市的天气预报（今天+未来几天，确定性数据源）。${IDENTITY.ownerName}随口问天气时用。支持 ${Object.keys(ADCODE).join('/')}。注意：这是按需查询，不是"设置每天天气播报"（每天定点的天气播报已默认开着；要新增定点播报用 schedule_recurring）。`,
    paramSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: Object.keys(ADCODE), description: '城市（默认取身份的常用城市）' },
        days: { type: 'integer', description: '查几天(1-4，含今天)，默认 4' },
      },
      required: [],
    },
    fn: tool_get_weather,
    sideEffect: false,
  },
  {
    name: 'schedule_recurring',
    description: '排一个每天/每周固定时刻重复做的事（如"每天08:00叫我起床""每周一09:00提醒交周报"）。到点小王会自动去做。限期的重复提醒（"每天催我直到周六/X号前每天提醒"）必须带 until=截止日，到期自动停，不会烂尾。一次性的提醒（几分钟后/某个具体时刻一次）用 schedule_task，不要用这个。',
    paramSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '短名字，如"吃药提醒"（也是之后取消时的标识）' },
        time: { type: 'string', description: "24小时制 'HH:MM'，如 08:30" },
        task: { type: 'string', description: '到点要做/提醒什么，一句话。写具体日期（"7/25(周六)前搞定"），别写裸的"周六前"——任务会跨周存活，相对说法会漂移' },
        weekday: { type: 'integer', description: '0-6(0=周日)，只在这天触发；省略=每天' },
        until: { type: 'string', description: "截止日 'YYYY-MM-DD'（含当天，过后自动停用）。凡'直到某天/某天前'的限期提醒必填；长期习惯类（每天起床/吃药）才省略" },
      },
      required: ['name', 'time', 'task'],
    },
    fn: tool_schedule_recurring,
    sideEffect: true,
  },
  {
    name: 'list_schedules',
    description: `列出当前所有定时安排：周期任务(每天/每周) + 待触发的一次性提醒 + 最近已触发/已取消的一次性任务(recent_done)。${IDENTITY.ownerName}问"你给我设了哪些定时的"或"怎么没提醒我"，或你要取消/修改某个安排前，先用它拿真实状态——排查"没收到提醒"时先看 recent_done（可能排上了但触发时刻不对），别凭感觉下结论。`,
    paramSchema: { type: 'object', properties: {}, required: [] },
    fn: tool_list_schedules,
    sideEffect: false,
  },
  {
    name: 'cancel_schedule',
    description: '取消一个定时安排。type=recurring 取消周期任务、type=task 取消一次性提醒；id 用 list_schedules 给出的数字 id（别猜）。要停"每天/每周都会响"的提醒，用 type=recurring——task 只是周期任务的单次触发实例，取消它拦不住下一次。',
    paramSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['recurring', 'task'], description: 'recurring=周期任务，task=一次性提醒' },
        id: { type: 'integer', description: 'list_schedules 给出的 id' },
      },
      required: ['type', 'id'],
    },
    fn: tool_cancel_schedule,
    sideEffect: true,
  },
  // 条件注册（ziqi-only 能力，默认关）：外部检索 + 网页正文阅读。补 http_get 只能"抓已知网址一坨HTML"的缺口。
  ...(WEB_SEARCH_ENABLED ? [
    {
      name: 'search',
      description: `外部检索：给关键词，从指定语料库拿标题/链接/摘要。source 选库：web=网页(默认)、github=开源仓库、huggingface=模型、paper=论文。${IDENTITY.ownerName}要查资料/找项目/找模型/找论文时用。这是关键词检索；要读某个链接的完整正文用 read_page；他已给明确网址、要原始响应用 http_get。`,
      paramSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          source: { type: 'string', enum: ['web', 'github', 'huggingface', 'paper'], description: '语料库：web(默认)/github/huggingface/paper' },
          count: { type: 'integer', description: '返回条数(1-10，默认6)' },
        },
        required: ['query'],
      },
      fn: tool_search,
      sideEffect: false,
    },
    {
      name: 'read_page',
      description: `抓一个网址、返回去掉脚本广告标签后的【可读正文全文】。要读文章/论文页/仓库 README/搜索结果里某个链接的完整内容时用它，别用 http_get（那个返回原始 HTML 一坨、还截断）。`,
      paramSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 http/https 网址' } },
        required: ['url'],
      },
      fn: tool_read_page,
      sideEffect: false,
      dangerous: true, // 过 SSRF 黑名单（同 http_get）
    },
  ] : []),
  // 条件注册（ziqi-only 能力，默认关）：把 HTML 发布成公网网页并返回链接（数据分析/图表→网页→发链接）。
  ...(PUBLISH_ENABLED ? [{
    name: 'publish_page',
    description: `把你写好的一段 HTML 发布成一个公网网页，返回可在手机上打开的链接。用途：给${IDENTITY.ownerName}做数据分析/图表/结构化报告时，自己写 HTML（要画图就用 ECharts，从 https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js 引入；手机屏幕，宽度自适应、字别太小），发布后把返回的链接用一句话发给他。纯文字几句话能说清的就别做网页。`,
    paramSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '页面标题' },
        html: { type: 'string', description: '完整 HTML（可含 <html> 骨架，或只给 <body> 内片段由系统补骨架）；图表用 ECharts CDN' },
      },
      required: ['title', 'html'],
    },
    fn: tool_publish_page,
    sideEffect: true,
  }] : []),
  // 条件注册（ziqi-only）：待办面板三件套。TODO_SECRET 同时是路由 secret 与注册开关（见常量注释）。
  ...(TODO_ENABLED ? [
    {
      name: 'todo_add',
      description: `把一件要做的事记进${IDENTITY.ownerName}的待办面板（网页清单，他手机电脑都能看能勾）。他说"记个待办/加到待办/我今天要做X/明天得办Y"时用；日常聊天里顺嘴提的事别自作主张记，他明确要记才记。与 schedule_task 的边界：待办=清单上的一件事（没做完会自动滚到明天，直到完成/放弃/搁置）；schedule_task=纯提醒响一次就完。一件事既要上清单又要到点提醒→本工具带 remind_at，别建两遍。`,
      paramSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这件事本身，一句话（必填）' },
          detail: { type: 'string', description: '备注：背景/怎么做/贴的链接会自动变成可点的（选填）' },
          tag: { type: 'string', description: '标签/项目名，如"某客户"、"学习"（选填）' },
          day: { type: 'string', description: "排在哪天：'YYYY-MM-DD' 或 today/tomorrow，省略=今天" },
          remind_at: { type: 'string', description: "要到点提醒才填：'HH:MM'（今天，已过算明天）或 'YYYY-MM-DD HH:MM'，东八区" },
          links: { type: 'array', items: { type: 'string' }, description: '相关链接（选填）' },
        },
        required: ['title'],
      },
      fn: tool_todo_add,
      sideEffect: true,
    },
    {
      name: 'todo_update',
      description: `改待办面板上的一条。action：done=完成划掉 / reopen=重开 / drop=放弃（不做了留痕）/ park=搁置（不想让它天天滚，收进搁置区）/ unpark=取回到今天 / defer=改到某天(带day) / note=追加一句备注(带text) / link=加链接(带url) / edit=改标题或标签(带title/tag) / remind=设到点提醒(带at) / remind_cancel=取消提醒。id 必须来自 todo_list 的真实 id。完成/放弃会自动取消挂着的提醒，不用再手动取消。`,
      paramSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '待办 id（来自 todo_list）' },
          action: { type: 'string', enum: ['done', 'reopen', 'drop', 'park', 'unpark', 'defer', 'note', 'link', 'edit', 'remind', 'remind_cancel'] },
          day: { type: 'string', description: "defer 用：'YYYY-MM-DD' 或 today/tomorrow" },
          text: { type: 'string', description: 'note 用：追加的备注内容' },
          url: { type: 'string', description: 'link 用：完整 http(s) 链接' },
          title: { type: 'string', description: 'edit 用：新标题' },
          tag: { type: 'string', description: 'edit 用：新标签' },
          at: { type: 'string', description: "remind 用：'HH:MM' 或 'YYYY-MM-DD HH:MM'，东八区" },
        },
        required: ['id', 'action'],
      },
      fn: tool_todo_update,
      sideEffect: true,
    },
    {
      name: 'todo_list',
      description: `看待办面板当前状态：今天的清单（含每条挂了几天、有没有提醒）、未来几天、搁置区；scope=history 或 all 再带最近完成/放弃的历史。${IDENTITY.ownerName}问"今天要干啥/待办有啥/昨天做完了什么"用它答；要 todo_update 改哪条，先用它拿 id。panel_url 是面板网页链接——他想自己看、自己勾的时候发给他，别每条回复都带。`,
      paramSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['today', 'history', 'all'], description: '默认 today；问历史才用 history/all' },
          history_days: { type: 'integer', description: '历史往回看几天(1-90，默认7)' },
        },
      },
      fn: tool_todo_list,
      sideEffect: false,
    },
  ] : []),
  // 条件注册（ziqi-only）：家里空调控制（经家中 Jetson 的 Home Assistant，开关=HA_URL+HA_TOKEN 都配了才开）。
  ...(HA_ENABLED ? [{
    name: 'home_ac',
    description: `控制${IDENTITY.ownerName}家里的空调（经他家里的 Home Assistant，真实生效）。他说"开/关空调""太冷了，切除湿""制冷调到26度"这类话时用。action=status 查当前状态（他问"空调开着吗/现在什么模式"）；action=set 改：mode=cool(制冷)/dry(除湿)/heat(制热)/fan_only(送风)/auto(自动)/off(关)，temp=目标温度16-30。"开空调"没说模式默认 cool。执行后按返回里的真实状态回复他，别照抄指令自己脑补结果。`,
    paramSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'set'], description: 'status=查状态，set=改模式/温度' },
        mode: { type: 'string', enum: ['cool', 'dry', 'heat', 'fan_only', 'auto', 'off'], description: 'set 用：制冷cool/除湿dry/制热heat/送风fan_only/自动auto/关off' },
        temp: { type: 'integer', description: 'set 用：目标温度 16-30（℃），可与 mode 同给或单独调温' },
      },
      required: ['action'],
    },
    fn: tool_home_ac,
    sideEffect: true,
  }] : []),
  // 条件注册：只有配置了运营者的租户实例（如朋友）有此工具；运营者本人实例（子淇）零变化。
  ...(HAS_OPERATOR ? [{
    name: 'report_to_operator',
    description: `把${IDENTITY.ownerName}的需求、意见或你做不到的事上报给老王（运营者）。${IDENTITY.ownerName}想要新能力、对你有不满、或说"告诉老王/让王哥…"时用。只能发给老王本人、无法发给任何其他人。上报完如实告诉${IDENTITY.ownerName}已转达、等老王评估——别替老王承诺结果。`,
    paramSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: '上报内容：主人想要什么/遇到了什么，一两句说清' } },
      required: ['content'],
    },
    fn: tool_report_to_operator,
    sideEffect: true,
  }] : []),
];

// ---- 渲染成 OpenAI tools 数组 ----
export function toOpenAITools(tools = TOOLS) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.paramSchema },
  }));
}

// ---- 危险操作预检（callTool 在执行 fn 前调） ----
// 命中返回 {blocked:true, reason}，由 callTool 包成 {ok:false,error}，不抛穿。
function precheckDangerous(name, args) {
  if (name === 'query_db') {
    const sql = String(args?.sql ?? '');
    if (SQL_WRITE_RE.test(sql)) return { blocked: true, reason: 'query_db 只读，非 SELECT 被拦' };
  }
  if (name === 'http_get' || name === 'read_page') {
    const url = String(args?.url ?? '');
    if (SSRF_PATTERNS.some((re) => re.test(url))) {
      return { blocked: true, reason: `${name} 拦截内网/本地地址(SSRF 防护)` };
    }
  }
  return { blocked: false };
}

// =====================================================================
// callTool —— 统一执行入口（致命纪律①）
// =====================================================================
// 流程：查注册表 → dangerous 过黑名单 → sideEffect 先算 dedupHash 查/写去重 → 执行 fn
//      → catch 包成 {ok:false,error}（不抛穿，循环需 role:'tool' 回灌错误）。
// 注意：去重的"写"动作复用各工具自己的 INSERT OR IGNORE（send_message→enqueueOutbox、
//      schedule_task→createTask 的 idempotency_key），callTool 不再重复算一遍 outbox；
//      这里的统一 wrapper 价值在于：① 强制 dangerous 预检；② 统一异常包裹+证据日志；
//      ③ 把 deduped 标志透传给循环（让 LLM 知道"已派过"）。
export async function callTool(name, args, ctx = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    console.error('[tools] 未知工具: %s', name);
    return { ok: false, error: `未知工具: ${name}` };
  }

  // 参数防御：args 必须是对象
  const a = args && typeof args === 'object' ? args : {};

  // 行为可回看（原则4 可观测）：每次调用留一行 args、成功也留结果摘要——此前成功调用零日志，
  // 排查"agent 到底把事办成什么样"（如 schedule_task 传了什么时间）只能靠猜库里的间接痕迹。
  console.error('[tools] %s args=%s', name, JSON.stringify(a).slice(0, 300));

  // 危险操作黑名单（五层防御·工具校验层）
  if (tool.dangerous) {
    const chk = precheckDangerous(name, a);
    if (chk.blocked) {
      console.warn('[tools] %s 被黑名单拦截: %s', name, chk.reason);
      return { ok: false, error: `blocked: ${chk.reason}` };
    }
  }

  try {
    const result = await tool.fn(a, { db: ctx.db || getDb(), taskId: ctx.taskId ?? null, sessionId: ctx.sessionId ?? null, userInput: ctx.userInput ?? null });
    // 副作用工具的 deduped 标志透传（result 里自带）
    const deduped = result && typeof result === 'object' ? result.deduped === true : false;
    console.error('[tools] %s ok%s result=%s', name, deduped ? '(deduped)' : '', JSON.stringify(result ?? null).slice(0, 200));
    return { ok: true, result, deduped };
  } catch (err) {
    // 失败要响：留证据，但不抛穿——循环需要把错误以 role:'tool' 回灌给 LLM
    console.error('[tools] %s 执行失败: %s', name, err.message);
    return { ok: false, error: err.message };
  }
}

// ---- 小工具 ----
function clampInt(v, def, lo, hi) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

// ---- 自检：dedup 算法、沙箱穿越、黑名单、渲染（不联网、不依赖真 db） ----
const IS_MAIN =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (process.argv.includes('--selftest') && IS_MAIN) {
  let pass = 0,
    fail = 0;
  const ok = (c, m) => {
    console.log(`  ${c ? '✓' : '✗'} ${m}`);
    c ? pass++ : fail++;
  };
  console.log('tools.mjs selftest (纯逻辑，不建 db)\n');

  // dedupHash 稳定性（契约权威算法：空格拼接，与 durable/adapter/main 一致）
  const h1 = dedupHash(['wecom', 'OWNER', 'hi', 't1']);
  const h2 = dedupHash(['wecom', 'OWNER', 'hi', 't1']);
  ok(h1 === h2 && h1.length === 16, 'dedupHash 稳定且 16 字符');
  ok(dedupHash(['a', 'bc']) !== dedupHash(['ab', 'c']), '不同 parts → 不同 hash');

  // 沙箱穿越拦截
  let escaped = false;
  try {
    resolveSandboxPath('../../etc/passwd');
  } catch (e) {
    escaped = /sandbox escape/.test(e.message);
  }
  ok(escaped, '../ 越界被 resolveSandboxPath 拦');
  ok(resolveSandboxPath('a/b.txt').startsWith(SANDBOX_DIR + sep), '沙箱内路径正常解析');
  // 前缀同名目录不能绕过（SANDBOX_DIR + '-evil'）
  let prefixBlocked = false;
  try {
    resolveSandboxPath('../' + SANDBOX_DIR.split(sep).pop() + '-evil/x');
  } catch {
    prefixBlocked = true;
  }
  ok(prefixBlocked, '前缀同名目录(-evil)不能绕过沙箱');

  // 危险黑名单
  ok(precheckDangerous('query_db', { sql: 'DELETE FROM tasks' }).blocked, 'query_db 拦 DELETE');
  ok(!precheckDangerous('query_db', { sql: 'SELECT * FROM tasks' }).blocked, 'query_db 放行 SELECT');
  ok(precheckDangerous('http_get', { url: 'http://127.0.0.1/x' }).blocked, 'http_get 拦 127.0.0.1');
  ok(precheckDangerous('http_get', { url: 'http://192.168.1.1' }).blocked, 'http_get 拦私网 192.168');
  ok(!precheckDangerous('http_get', { url: 'https://example.com' }).blocked, 'http_get 放行外网');
  // 收紧后的 SSRF 覆盖：云元数据 / IP 编码绕过 / IPv6
  ok(precheckDangerous('http_get', { url: 'http://100.100.100.200/latest/meta-data/' }).blocked, 'http_get 拦阿里云元数据 100.100.100.200');
  ok(precheckDangerous('http_get', { url: 'http://2130706433/' }).blocked, 'http_get 拦十进制 IP(2130706433=127.0.0.1)');
  ok(precheckDangerous('http_get', { url: 'http://0x7f000001/' }).blocked, 'http_get 拦十六进制 IP(0x7f000001)');
  ok(precheckDangerous('http_get', { url: 'http://[::1]/x' }).blocked, 'http_get 拦 IPv6 回环 [::1]');
  ok(!precheckDangerous('http_get', { url: 'https://api.deepseek.com/v1' }).blocked, 'http_get 放行正常外网 API');

  // 锚点分级 + 记忆按需层（渐进式记忆）：pin_fact 暴露 tier 两档；memory_search 自述覆盖 facts/notes
  const pfTool = TOOLS.find((t) => t.name === 'pin_fact');
  ok(JSON.stringify(pfTool.paramSchema.properties.tier.enum) === JSON.stringify(['core', 'index']), 'pin_fact tier enum = core/index（锚点分级暴露给模型）');
  ok(!pfTool.paramSchema.required.includes('tier'), 'pin_fact tier 可选（默认 core，旧行为不变）');
  const msTool = TOOLS.find((t) => t.name === 'memory_search');
  ok(/notes/.test(msTool.description) && /facts/.test(msTool.description), 'memory_search 描述自述覆盖 facts/notes（索引行的"去哪拉正文"有兑现处）');

  // send_message 收件人锁定 owner：schema 不再暴露 target 参数（结构封死，非靠指令）
  const smTool = TOOLS.find((t) => t.name === 'send_message');
  ok(smTool && !smTool.paramSchema.properties.target, 'send_message schema 已移除 target 参数（收件人结构性锁定为 owner）');
  // report_to_operator：注册条件与 OPERATOR_ID 配置严格一致（运营者本人实例不注册）；schema 同样无 target
  const rtoTool = TOOLS.find((t) => t.name === 'report_to_operator');
  ok(!!rtoTool === HAS_OPERATOR, `report_to_operator 注册条件与 OPERATOR_ID 配置一致（当前 ${HAS_OPERATOR ? '已' : '未'}注册）`);
  ok(!rtoTool || !rtoTool.paramSchema.properties.target, 'report_to_operator 无 target 参数（收件人结构性锁定为运营者）');

  // 新能力工具（ziqi-only）：注册条件与各自 env flag 严格一致（防 overclaim）
  ok(!!TOOLS.find((t) => t.name === 'search') === WEB_SEARCH_ENABLED, `search 注册条件与 WEB_SEARCH_ENABLED 一致（当前 ${WEB_SEARCH_ENABLED ? '已' : '未'}注册）`);
  ok(!!TOOLS.find((t) => t.name === 'read_page') === WEB_SEARCH_ENABLED, `read_page 注册条件与 WEB_SEARCH_ENABLED 一致`);
  ok(!!TOOLS.find((t) => t.name === 'home_ac') === HA_ENABLED, `home_ac 注册条件与 HA_ENABLED 一致（当前 ${HA_ENABLED ? '已' : '未'}注册）`);
  ok(!!TOOLS.find((t) => t.name === 'publish_page') === PUBLISH_ENABLED, `publish_page 注册条件与 PUBLISH_ENABLED 一致（当前 ${PUBLISH_ENABLED ? '已' : '未'}注册）`);
  // 待办面板三件套：注册条件与 TODO_SECRET 严格一致（防 overclaim；未配置实例零变化）
  for (const n of ['todo_add', 'todo_update', 'todo_list']) {
    ok(!!TOOLS.find((t) => t.name === n) === TODO_ENABLED, `${n} 注册条件与 TODO_SECRET 一致（当前 ${TODO_ENABLED ? '已' : '未'}注册）`);
  }
  if (TODO_ENABLED) {
    const tuTool = TOOLS.find((t) => t.name === 'todo_update');
    ok(['done', 'park', 'defer', 'remind', 'remind_cancel'].every((a) => tuTool.paramSchema.properties.action.enum.includes(a)), 'todo_update action enum 覆盖状态机全集');
    ok(TOOLS.find((t) => t.name === 'todo_add').paramSchema.required.includes('title'), 'todo_add 必填 title');
    // pin_fact 护栏（结构层拦待办清单进记忆）：整张带日期清单命中，普通事实放行
    ok(looksLikeTodoList('本周待办：周三-致远报表；周四-讲OMOP、订深圳票；下周五-某客户第三四节课'), 'looksLikeTodoList 命中带日期的待办清单');
    ok(looksLikeTodoList('某公司产品发布 7/23周四；某客户第三节课 7/27周一；AgentX 7/29；第四节课 7/29截止'), 'looksLikeTodoList 命中 M/D+周X 清单');
    ok(!looksLikeTodoList('已入职某医疗公司，2026-04-01 起，上海 AI 应用工程师'), 'looksLikeTodoList 放行含单个日期的普通事实');
    ok(!looksLikeTodoList('他喜欢简洁专业的文案，反感 AI 味'), 'looksLikeTodoList 放行无日期偏好事实');
    const pinBlock = await callTool('pin_fact', { fact: '本周待办：周三-致远报表7/23；周四-OMOP 7/24；下周五-某客户第三四节课 7/29' }, {});
    ok(!pinBlock.ok && /todo_add|面板/.test(pinBlock.error), 'pin_fact 拦下待办清单并回灌指路 todo_add');
    const pinOk = await callTool('pin_fact', { fact: '子淇现居上海，独立租房' }, {});
    ok(pinOk.ok, 'pin_fact 放行普通事实');
  }
  if (WEB_SEARCH_ENABLED) {
    const sTool = TOOLS.find((t) => t.name === 'search');
    ok(JSON.stringify(sTool.paramSchema.properties.source.enum) === JSON.stringify(['web', 'github', 'huggingface', 'paper']), 'search source enum = web/github/huggingface/paper');
    const rpTool = TOOLS.find((t) => t.name === 'read_page');
    ok(rpTool.dangerous === true, 'read_page 标 dangerous（过 SSRF 黑名单）');
    ok(precheckDangerous('read_page', { url: 'http://127.0.0.1/x' }).blocked, 'read_page 拦 127.0.0.1(SSRF)');
    ok(!precheckDangerous('read_page', { url: 'https://arxiv.org/abs/1706.03762' }).blocked, 'read_page 放行正常外网');
  }
  // read_page 正文抽取（纯函数，离线）：去 script/style/标签、抽 title
  const { title: rtTitle, text: rtText } = extractReadableText('<html><head><title>标题X</title></head><body><script>var a=1</script><style>.c{}</style><h1>大标题</h1><p>正文第一段</p><p>第二段</p></body></html>');
  ok(rtTitle === '标题X', 'extractReadableText 抽出 <title>');
  ok(!/var a=1/.test(rtText) && !/\.c\{/.test(rtText) && /正文第一段/.test(rtText) && /第二段/.test(rtText), 'extractReadableText 去脚本/样式、保留正文分段');
  // OpenAlex 倒排摘要还原（论文源）
  ok(reconstructAbstract({ 'We': [0], 'propose': [1], 'Transformer': [2], '.': [3] }) === 'We propose Transformer .', 'reconstructAbstract 按位置还原倒排摘要');
  ok(reconstructAbstract(null) === '' && reconstructAbstract('x') === '', 'reconstructAbstract 脏输入返空串不崩');

  // search 的 RSS 解析（纯函数，离线）——用一段样例 Bing RSS 验证抽取 title/link/snippet + 实体解码
  const sampleRss = `<rss><channel><item><title>微软开源 Flint &amp; Vega-Lite</title><link>https://example.com/a?x=1&amp;y=2</link><description>这是 &lt;b&gt;摘要&lt;/b&gt; 内容</description></item><item><title>第二条</title><link>https://example.com/b</link><description>desc2</description></item></channel></rss>`;
  const parsed = parseRssItems(sampleRss);
  ok(parsed.length === 2, 'parseRssItems 抽出 2 条');
  ok(parsed[0].title === '微软开源 Flint & Vega-Lite' && parsed[0].url === 'https://example.com/a?x=1&y=2', 'RSS 实体(&amp;)解码正确、link 抽取正确');
  ok(parsed[0].snippet === '这是 摘要 内容', 'description 去标签+实体解码（<b> 被剥）');

  // publish_page 的 HTML 包骨架 + 发布落盘（读 env 的临时目录，不污染仓库）
  ok(/<!doctype html>/i.test(wrapHtml('t', '<p>hi</p>')) && wrapHtml('t', '<!doctype html><html></html>') === '<!doctype html><html></html>', 'wrapHtml：片段补骨架、完整文档原样透传');
  ok(escapeHtml(`<a>&"'`) === '&lt;a&gt;&amp;&quot;&#39;', 'escapeHtml 转义完整');

  // OpenAI tools 渲染
  const rendered = toOpenAITools();
  const expectN = 15 + (HAS_OPERATOR ? 1 : 0) + (WEB_SEARCH_ENABLED ? 2 : 0) + (PUBLISH_ENABLED ? 1 : 0) + (TODO_ENABLED ? 3 : 0) + (HA_ENABLED ? 1 : 0);
  ok(rendered.length === expectN, `渲染出 ${expectN} 个工具（15 基础 + 条件：operator=${HAS_OPERATOR} search/read_page=${WEB_SEARCH_ENABLED}(×2) publish=${PUBLISH_ENABLED} todo=${TODO_ENABLED}(×3) ha=${HA_ENABLED}）`);
  ok(rendered.every((t) => t.type === 'function' && t.function.name && t.function.parameters), '每个工具结构合法');
  ok(rendered.find((t) => t.function.name === 'send_message') != null, 'send_message 已注册');
  ok(rendered.find((t) => t.function.name === 'record_checkin') != null, 'record_checkin 已注册');
  ok(rendered.find((t) => t.function.name === 'pin_fact') != null, 'pin_fact 已注册');
  ok(rendered.find((t) => t.function.name === 'unpin_fact') != null, 'unpin_fact 已注册');
  for (const n of ['get_weather', 'schedule_recurring', 'list_schedules', 'cancel_schedule']) {
    ok(rendered.find((t) => t.function.name === n) != null, `${n} 已注册`);
  }
  // schedule_recurring 与 schedule_task 边界清晰（描述互指、不重叠 —— 原则11 crisp）
  const srTool = TOOLS.find((t) => t.name === 'schedule_recurring');
  ok(/一次性/.test(srTool.description) && /schedule_task/.test(srTool.description), 'schedule_recurring 描述划清与 schedule_task 的边界');
  // 生命周期（2026-07-23）：until 参数存在且描述讲清"限期必填/到期自动停"；cancel 描述指明 recurring 才能停周期
  ok(srTool.paramSchema.properties.until != null && /YYYY-MM-DD/.test(srTool.paramSchema.properties.until.description), 'schedule_recurring 有 until 截止参数');
  ok(/until/.test(srTool.description) && /自动停/.test(srTool.description), 'schedule_recurring 描述讲清限期语义');
  const ccTool = TOOLS.find((t) => t.name === 'cancel_schedule');
  ok(/单次触发实例/.test(ccTool.description), 'cancel_schedule 描述讲清 task 实例 ≠ 周期本体');

  // callTool 对未知工具/黑名单的返回（不抛穿）
  (async () => {
    const r1 = await callTool('not_exist', {});
    ok(r1.ok === false && /未知工具/.test(r1.error), 'callTool 未知工具返回 {ok:false}');
    const r2 = await callTool('query_db', { sql: 'DROP TABLE tasks' });
    ok(r2.ok === false && /blocked/.test(r2.error), 'callTool 黑名单命中返回 blocked（不抛穿）');

    // publish_page 发布落盘（读 env 的临时目录，不污染仓库）——放这里保证在打印结果前完成
    const { mkdtempSync, rmSync, existsSync: ex } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const pdir = mkdtempSync(join(tmpdir(), 'xw2-pub-'));
    process.env.PUBLISHED_DIR = pdir;
    process.env.PUBLIC_BASE_URL = 'http://<server-ip>:8080';
    const rp = await tool_publish_page({ title: '测试报告', html: '<h1>hi</h1>' });
    ok(/^http:\/\/8\.136\.47\.28:8080\/p\/[A-Za-z0-9_-]{6,}$/.test(rp.url), 'publish_page 返回合法公网 /p/<token> 链接');
    ok(ex(join(pdir, `${rp.url.split('/p/')[1]}.html`)), '页面 <token>.html 真落到 published 目录');
    delete process.env.PUBLISHED_DIR; delete process.env.PUBLIC_BASE_URL;
    rmSync(pdir, { recursive: true, force: true });

    console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
  })();
}
