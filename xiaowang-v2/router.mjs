// =====================================================================
// router.mjs —— 多租户前置路由（路2 隔离的"渠道复用"层）。
//
// 一个 e云企微号加多个人、每人一个【独立后端实例】（独立进程/库/身份），互不可见。
// e云回调先到这个路由器（蹲公网回调端口），按消息的 senderId 把整条 payload 转发给对应租户的后端。
// 路由器【无状态、不碰任何租户数据】——它只看 senderId 决定转给谁，绝不解析业务/不存储。
//
// 隔离边界：子淇的消息只会进子淇后端、朋友的只会进朋友后端。后端各自还有 owner 门禁兜底
// （即使路由错了，后端也只认自己的 owner，非 owner 丢）——双保险。
//
// 配置 router.config.json（gitignored，含 secret/id）：
//   { port, callbackPath, routes: {<senderId>: <后端回调URL>}, defaultTarget, forwardTimeoutMs }
// 见 router.config.example.json。零运行时依赖（纯 node:http + fetch）。
// =====================================================================

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = import.meta.dirname;
const CONFIG_PATH = process.env.ROUTER_CONFIG || join(DIR, 'router.config.json');

export function loadConfig(path = CONFIG_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    port: Number(raw.port || 8080),
    callbackPath: raw.callbackPath || '/cb',
    routes: raw.routes || {},
    defaultTarget: raw.defaultTarget || null,
    forwardTimeoutMs: Number(raw.forwardTimeoutMs || 10000),
    // publish_page 发布的网页由本路由器公网服务（唯一公网面就是这台 8080）。
    // publishedDir 与后端 tools.mjs 的 PUBLISHED_DIR 必须同一绝对路径（两进程共享文件系统）。
    publishedDir: raw.publishedDir || join(DIR, 'published'),
    publishPath: raw.publishPath || '/p',
    // 待办面板转发目标（子淇后端进程根地址，如 http://127.0.0.1:8081）。
    // router 只透传 /todo/* 的请求与响应，不看内容不存状态——secret 校验在后端（capability URL 在路径里）。
    // 不配置 = 无此转发，其他租户零变化。
    todoTarget: raw.todoTarget || null,
    todoPath: raw.todoPath || '/todo',
  };
}

// /todo/* 透传（GET 页面/状态 + POST 操作都走这里）。攒 body → fetch 后端 → 原样回吐。
// 上限 256KB（面板请求都很小，防滥用打爆轻量机）；后端不可达回 502 说人话。
function proxyTodo(cfg, req, res) {
  const chunks = [];
  let len = 0;
  req.on('data', (c) => { chunks.push(c); len += c.length; if (len > 256_000) req.destroy(); });
  req.on('end', async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), cfg.forwardTimeoutMs);
    try {
      const resp = await fetch(cfg.todoTarget + req.url, {
        method: req.method,
        headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
        signal: ac.signal,
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      res.writeHead(resp.status, {
        'Content-Type': resp.headers.get('content-type') || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    } catch (e) {
      console.error('[router] todo forward failed: %s', e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('面板后端暂不可达，稍后刷新重试');
    } finally {
      clearTimeout(timer);
    }
  });
}

// URL 路径 → 已发布页面的绝对文件路径（纯函数，便于 selftest）。返回 null=不是合法发布页请求。
// 安全：token 白名单字符（不可含 / . ..）+ 只服务 <token>.html + resolve 后再断言落在 publishedDir 内。
export function resolvePublishedPath(cfg, urlPath) {
  const prefix = (cfg.publishPath || '/p') + '/';
  if (typeof urlPath !== 'string' || !urlPath.startsWith(prefix)) return null;
  let token;
  try { token = decodeURIComponent(urlPath.slice(prefix.length)); } catch { return null; }
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) return null; // 穿越/枚举防护：只放随机 token 字符
  const dir = cfg.publishedDir;
  if (!dir) return null;
  const root = resolve(dir);
  const abs = resolve(root, `${token}.html`);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // 兜底：绝不逃出 publishedDir
  return abs;
}

// 从 e云 payload 提取第一个非自环消息的 senderId（DM：一条 payload 一个发件人）。
// 纯函数，便于 selftest。多发件人混在一条 payload 极罕见（DM 不会），按首个有效发件人路由。
export function extractSenderId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let msgs = payload.data;
  if (!Array.isArray(msgs)) msgs = msgs ? [msgs] : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const senderId = m.senderId != null ? String(m.senderId) : (m.fromId != null ? String(m.fromId) : null);
    const userId = m.userId != null ? String(m.userId) : null;
    if (senderId && userId && senderId === userId) continue; // 自环（自己发的）跳过
    if (senderId) return senderId;
  }
  return null;
}

// senderId → 后端 URL。命中路由表用指定后端；否则用 defaultTarget（测试期=朋友实例）；null=丢弃。
export function pickTarget(cfg, senderId) {
  if (senderId && cfg.routes[senderId]) return cfg.routes[senderId];
  return cfg.defaultTarget;
}

// 转发整条 payload 到后端（带 timeout）。路由器已先 ack e云，这里 fire-and-forget；后端自己处理+发送。
async function forward(target, bodyBuf, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: bodyBuf,
      signal: ac.signal,
    });
    console.error('[router] forwarded -> %s (http %s)', target.replace(/\/cb\/.*/, '/cb/***'), r.status);
  } catch (e) {
    console.error('[router] forward to %s failed: %s', target.replace(/\/cb\/.*/, '/cb/***'), e.message);
  } finally {
    clearTimeout(timer);
  }
}

export function startRouter(cfg = loadConfig()) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'xiaowang-router', routes: Object.keys(cfg.routes).length }));
      return;
    }
    // 公网服务 publish_page 发布的网页：GET /p/<token> → 读 publishedDir/<token>.html 返回。
    if (req.method === 'GET') {
      const pth = new URL(req.url, 'http://x').pathname;
      const pubAbs = resolvePublishedPath(cfg, pth);
      if (pubAbs) {
        try {
          const html = readFileSync(pubAbs);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(html);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('page not found or expired');
        }
        return;
      }
    }
    // 待办面板透传（GET+POST）：配置了 todoTarget 才有这条路；路径不命中零影响。
    {
      const pth0 = new URL(req.url, 'http://x').pathname;
      if (cfg.todoTarget && (pth0 === cfg.todoPath || pth0.startsWith(cfg.todoPath + '/'))) {
        proxyTodo(cfg, req, res);
        return;
      }
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
    // 公网回调密钥路径校验：只有知道 callbackPath(含 public secret) 的 e云能进。
    const pth = new URL(req.url, 'http://x').pathname;
    if (pth !== cfg.callbackPath) { res.writeHead(404); res.end(); return; }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      // 先快速 ack e云（避免平台重投）。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      let payload;
      try { payload = JSON.parse(body || '{}'); } catch (e) { console.error('[router] bad json: %s', e.message); return; }
      if (payload && payload.testMsg) { console.error('[router] e云连通性测试包'); return; }

      const senderId = extractSenderId(payload);
      const target = pickTarget(cfg, senderId);
      if (!target) { console.error('[router] no target for sender=%s, drop', senderId); return; }
      forward(target, Buffer.from(body, 'utf8'), cfg.forwardTimeoutMs);
    });
  });
  server.on('error', (e) => console.error('[router] server error: %s', e.message));
  server.listen(cfg.port, '0.0.0.0', () => console.error('[router] listening :%d, %d 条路由 + %s', cfg.port, Object.keys(cfg.routes).length, cfg.defaultTarget ? 'default' : '无default(未知sender丢弃)'));
  return { server, stop() { server.close(); } };
}

// CLI 入口。
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || '').href;

// 生产：node router.mjs → 起前置路由服务（之前漏了这个分支，导致进程秒退、systemd 崩溃循环）。
if (IS_MAIN && !process.argv.includes('--selftest')) {
  startRouter();
}

// 离线自检：node router.mjs --selftest（只验纯函数，不起服务）。
if (process.argv.includes('--selftest') && IS_MAIN) {
  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };
  console.log('router.mjs selftest (纯函数，不起服务)\n');

  const cfg = { routes: { 'ZIQI': 'http://127.0.0.1:8081/cb/s1' }, defaultTarget: 'http://127.0.0.1:8082/cb/s2' };

  ok(extractSenderId({ data: [{ senderId: 'ZIQI', userId: 'BOT', msgData: { content: 'hi' } }] }) === 'ZIQI', '提取 senderId');
  ok(extractSenderId({ data: [{ senderId: 'BOT', userId: 'BOT' }, { senderId: 'FRIEND', userId: 'BOT' }] }) === 'FRIEND', '跳过自环、取首个真实发件人');
  ok(extractSenderId({ testMsg: 'x' }) === null, '连通性测试包无 senderId');
  ok(extractSenderId({}) === null, '空 payload 返 null');

  ok(pickTarget(cfg, 'ZIQI') === 'http://127.0.0.1:8081/cb/s1', '已知 sender → 对应后端');
  ok(pickTarget(cfg, 'FRIEND_TEST') === 'http://127.0.0.1:8082/cb/s2', '未知 sender → default(朋友实例)');
  ok(pickTarget({ routes: {}, defaultTarget: null }, 'X') === null, '无 default → null(丢弃)');
  ok(pickTarget(cfg, null) === 'http://127.0.0.1:8082/cb/s2', 'senderId 缺失 → default');

  // 发布页路径解析（安全：白名单 token + 只服务 .html + 不穿越）
  const pcfg = { publishedDir: '/opt/xiaowang-v2/published', publishPath: '/p' };
  const okAbs = resolvePublishedPath(pcfg, '/p/abc123XYZ_-');
  ok(okAbs === resolve('/opt/xiaowang-v2/published', 'abc123XYZ_-.html'), '合法 token → published/<token>.html');
  ok(resolvePublishedPath(pcfg, '/p/../../etc/passwd') === null, '穿越 token 被拒（含 / . 非白名单字符）');
  ok(resolvePublishedPath(pcfg, '/p/ab') === null, '过短 token 被拒（<6）');
  ok(resolvePublishedPath(pcfg, '/p/a%2e%2e%2fb') === null, 'URL 编码的 ../ 解码后仍非白名单→拒');
  ok(resolvePublishedPath(pcfg, '/health') === null, '非 /p 路径 → null（不走发布服务）');
  ok(resolvePublishedPath(pcfg, '/p/') === null, '空 token → null');

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}
