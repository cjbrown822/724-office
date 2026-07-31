# 小王 v2

子淇的个人 AI agent「小王」🦞 的新躯体。单 Node 进程 + 单 WAL SQLite + 手写 agentic 循环。四样能力——跨天 durable 执行、自愈恢复、分层记忆、agentic 工具循环——都从同一个持久执行内核长出来。

架构全貌见 `BLUEPRINT.md`（含红队逐条收口、数据模型、分阶段建造、诚实账）。

## 现状（2026-06-25）

**P1 离线验证通过，尚未 ECS burn-in。**

- ✅ 10 个 `.mjs` 全过 `node --check`
- ✅ 模块自检 **146/146 通过**：db 27 · durable 31 · memory 28 · tools 15 · prompt 12 · loop 7 · llm 6 · adapter 8 · main 6 · watchdog 6
- ✅ 真 DeepSeek 跑通一次 CLI turn：进程启动 → agentic loop 调 LLM → 人格回复
- ⏳ **还没做**：企微 adapter 端到端（P3）；ECS 上 FTS5 复测（本地可用）；连续 7 晚 burn-in；facts 自动抽取/向量召回（backlog）

"P1 跑通" ≠ "稳"。要叫稳，按 `BLUEPRINT.md` 诚实账需 ECS 上挂 systemd 连续 7 晚不断 + 经历真实 429/kill-9/跨天补跑验证。

## 文件

| 文件 | 作用 |
|---|---|
| `db.mjs` | 持久层：单写连接、全部表/索引、FTS5 try/catch 降级、`tx()` |
| `durable.mjs` | durable 内核：tasks/steps/timers/outbox + worker tick（调度/重放/relay/心跳） |
| `loop.mjs` | agentic 控制环：组上下文→LLM→工具→回灌→护栏终止 |
| `llm.mjs` | LLM 收口：重试退避 + DeepSeek↔Kimi fallback，纯 fetch |
| `tools.mjs` | 工具注册表 + 副作用 dedup wrapper，8 个首版工具 |
| `memory.mjs` | 分层记忆：episodes 只追加 + facts 半自动 + `retrieve()`（FTS5/LIKE 降级） |
| `prompt.mjs` | system prompt 组装（🦞 人格 + 召回注入） |
| `adapter.mjs` | 渠道适配：CLI（起步）/ 企微（P3）+ outbox relay |
| `main.mjs` | 进程入口：initDb→注册工具→startWorker→startAdapter |
| `watchdog_cron.mjs` | 进程外看门狗（crontab，独立于主进程） |
| `deploy/` | probe.sh（环境探针）/ install.sh / systemd unit |

## 跑

```bash
# 自检（离线 mock，不联网，临时 db）
XW2_DB_PATH=/tmp/t.db node db.mjs --selftest      # 各模块同理

# 本地 CLI 真聊（需 DeepSeek key）
cp .env.example .env        # 填 LLM_API_KEY；不填 WECOM_TOKEN 即 CLI 模式
node main.mjs               # 输入一行回车，ctrl-d 退出
```

## 部署（按 BLUEPRINT.md 分阶段）

```bash
bash deploy/probe.sh        # P0：先在 ECS 验 Node 版本 + FTS5，动手前第一件事
bash deploy/install.sh      # scp /opt/xiaowang-v2、装 systemd、装 crontab 看门狗、ss 查端口
```

## 红线

与 live ESM bot（`/opt/esm-bot/`，端口 8080）**并行共存**：v2 用 `/opt/xiaowang-v2/`、独立 `v2.db`、端口 8090。**绝不碰 live 的 `esm.sqlite` / 端口 / workspace**。部署前 `ss -tlnp | grep -E '8080|8090'` 查冲突。
