# PLAN_DEEPTHINK —— 显式口令进"深思模式"（变身颜文字）

> 2026-07-24 立案，子淇拍板"筹备好、换新上下文执行"。执行会话请通读本文件 + `DEPLOYED.md` 2026-07-24 两个批次，再动手。
> 设计源头：2026-07-01 子淇 Phase 2 原案（见 auto-memory project_digital_twin 07-01 节）——"不让 agent 自己判断何时深思，用显式口令；小王回变身颜文字确认进入状态；之后每条回复带思考标识"。显式口令是原则11 认可的 fast-path（无歧义约定，不是猜意图）。

## 0. 现状与已就绪的前提（2026-07-24 攒齐）

- **pi-ai 传输层已上线**（`llm.mjs`，commit `15f9f63`/`b1d8c4b`）：DeepSeek 的 reasoning_content 回传（T6）和 GLM 的 thinking:{type} 序列化都由 pi-ai 原生处理——只要 Context 里的 assistant 消息携带 thinking block，多轮回传自动成立。**这是 07-01 原案里"绕开 T6"变成"正面解决 T6"的关键变化。**
- **生产队伍（情况一，已切换生效）**：主 `deepseek-v4-pro`（关思考，0.9-2s）+ 备 `glm-5.2`（bigmodel）。深思队伍（情况二，调研结论）：主 `glm-5.2`（思考态证据最强：τ² 99.1/TB 81）+ 备 `deepseek-v4-pro`（interleaved thinking 主场）。调研全文：https://claude.ai/code/artifact/cfdfcebb-6b48-4ae9-acd2-c388b766b838
- **现有护栏**：llm.mjs "带 tools 强制关思考"（pi/raw 两路同款）——本计划要做的正是在结构可回传后**有条件放开**它。

## 1. 目标行为（用户视角）

1. 子淇在微信打出**专属口令**（确切词待他定，无歧义字符串，日常不会误触）→ 小王回**变身颜文字**（条框 ASCII 图案，确定性回执不走 LLM）→ 进入深思模式。
2. 深思模式内：每轮走思考态（深思队伍），回复带**思考标识前缀**（确定性加，不靠模型自觉），可以带工具。
3. 退出：退出口令（另一个词）或**自动超时**（默认建议 30 分钟无消息自动退出并提示，防止小王卡在慢速态）→ 回执确认恢复。
4. 朋友实例零感知（env flag 条件启用，仅子淇实例）。

## 2. 工程设计（执行会话按此做，改法有更优可提但先对照原则11）

### ① 口令 fast-path（adapter 层，协议层行为）
- `handleText` 在进 agent 前精确匹配进/出口令（字符串全等，非正则猜测）→ 翻转模式状态 + 确定性回执（变身/复原颜文字）。与 `#快记` 同级的显式语法，不违"绝不在 loop 前截断模糊意图"铁律。
- 口令词、颜文字图案：**待子淇提供**（执行会话开头问一次）。

### ② 模式状态（bot_state 表，已有基建）
- `bot_state` 存 `deepthink_until`（epoch ms，进入时=now+超时窗；每条消息续期）。过期即自动退出（worker tick 或下一条消息懒检查均可，选懒检查=零新调度）。
- 状态必须**暴露给模型**（context 注入一行"当前深思模式"），也可被 list 类工具查询——状态可见原则。

### ③ 思考链回传（loop.mjs + llm.mjs，本计划核心工程）
- loop 的 `working` 里 assistant 消息增加 `reasoning` 字段（chatCompletion 返回值里已有，07-24 起 pi 路径能捕获）。
- llm.mjs `openaiMessagesToContext`：assistant 消息若带 `reasoning` → 翻译成 thinking block，pi-ai 自动按各家格式回传（DeepSeek=reasoning_content，GLM=对应字段）。
- **放开护栏的方式必须是结构性的**：`chatCompletion` 加参数 `reasoningCarried: true`（loop 深思分支显式声明"我会回传思维链"）才允许 thinking:'on' + tools 并存；默认仍强制关。不要改成无条件放开。
- episodes 落库：思维链**不进 episodes**（记忆里只留结论，思考过程属 API 视图）——与 07-08 Nudge 不落 episodes 同一纪律。

### ④ 深思队伍路由（llm.mjs）
- 新增可选 env：`DEEP_LLM_BASE_URL/KEY/MODEL` + `DEEP_LLM_FALLBACK_*`（缺省时深思模式退化为"现役队伍开思考"）。初始配置：主 glm-5.2 + 备 v4-pro（key 都在服务器 .env 里现成）。
- chatCompletion 加 `profile: 'default'|'deep'` 选 provider 组；callWithResilience 的主备切换逻辑复用不动。

### ⑤ 出站标识（adapter 出口，确定性）
- 深思模式内 sendWecom 前缀思考标识（子淇定样式，如「🧠」或条框字符）；stripMarkdownForPhone 之后加，避免被剥。

### ⑥ 隔离与守护
- 总开关 `DEEPTHINK_ENABLED=1` 仅 ziqi .env（沿用 env-flag 条件注册模式，朋友零感知）。
- 深思轮 LLM_TIMEOUT_MS 需单独放宽（思考态 5-15s 常态，现 30s 够但留意 wallclock 护栏与多工具轮叠加；建议深思模式 wallclock 单独配置）。

## 3. 明确不做（防漂移）

- 不做"模型自己判断何时深思"（口令是唯一入口，原案钉死）。
- 不做深思模式常驻/默认开（微信体感 4-15s/轮，只在点名时进入）。
- 不动朋友实例任何行为。
- 不在本计划里顺手重构 loop/记忆/其它（外科手术）。

## 4. E2E 验收标准（xiaowang-e2e 流程，全部子淇号真链路）

1. 口令进入 → 变身颜文字回执（确定性、非 LLM 文案）；bot_state 有 deepthink_until。
2. 深思模式内纯聊天轮：回复带思考标识、reasoning 真实非空（journal/日志可见）、时延在预期带（5-15s）。
3. **深思模式内带工具轮（核心回归）**：设一个提醒 → 多轮工具循环无 400（T6 回传成立）、参数正确、库状态对。
4. 退出口令/超时 → 复原回执，后续轮速度回到 <2s，thinking 字段回到 disabled（抓包或日志证据）。
5. 朋友实例：未重启、行为面零变化、verify_tenant friend 全绿。
6. selftest：llm/loop 新增用例（reasoningCarried 门禁、翻译层 thinking block 往返）全绿；服务器 server==repo sha256。

## 5. 回滚

- 深思模式整体：ziqi .env 删 `DEEPTHINK_ENABLED` + 重启（口令失效、一切回现状）。
- LLM 层如出异常：`LLM_ENGINE=raw` 一行回纯 fetch（raw 路径不支持深思模式，但保底小王能用）。
- 队伍回滚：恢复 `.env.pre-team1-*`（回 glm 主力）或 `.env.pre-glm-*`（回最初 v4-pro 主 + kimi 备）。

## 6. 拍板项（✅ 2026-07-24 执行会话已收齐并落地）

1. 进入口令「小王变身」/ 退出口令「小王下班」（DEEPTHINK_ENTER/EXIT 可改）。
2. 颜文字选 B 能量条风（▰▰▰▰▰▰ 100% / 复原 ▱▱▱▱▱▱ 0%，deepthink.mjs 内）。
3. 超时窗默认 30 分钟（DEEPTHINK_WINDOW_MIN 可调）。
4. 深思主力 glm-5.2 + 备 v4-pro 开思考（调研推荐款，DEEP_LLM_* 配齐）。

> **✅ 本计划已于 2026-07-24 全部落地上线**（commit `daea0f3`，E2E §4 六条全过）。实施记录见 `DEPLOYED.md`「2026-07-24 深思模式批」。
