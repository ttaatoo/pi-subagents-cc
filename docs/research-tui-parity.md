# pi-subagents-cc 横向调研与 TUI 优化方案报告

> 历史研究：以下缺口与建议针对 2026-09-23 / `a859d1de`，不是当前能力清单。当前交互契约见 [claude-parity.md](claude-parity.md)，后续复查见 [竞品分析](research-pi-workflow-competitive-analysis.md)。

> 目标：broadly 学习 `grok-build / codex / omp(oh-my-pi) / claude-code / amp / claw-code / opencode / hermes-agent` + `tintinweb/pi-subagents` 的做法，给出 `pi-subagents-cc` 应该怎么做。约束：`VISION.md`（一个 operator、一个 delegation layer、compose before inventing、无第二执行路径），偏好：Claude Code CLI 的 TUI 交互（以 tintinweb 的移植为蓝本）。
> 调研时间：2026-09-23；基线：`pi-subagents-cc = nicobailon/pi-subagents@a859d1de (0.70.1)` 单 commit fork；tintinweb 基线 `@tintinweb/pi-subagents@0.19.0`。

---

## 0. 一句话结论

**不要移植 tintinweb 的执行层（`Agent/get_subagent_result/steer_subagent/SubagentWorkflow + agent()/parallel()/pipeline()`），只移植它的表现层（widget + FleetView + conversation-viewer + `@mention`）。**

* 执行层现在是 nicobailon 系：单 `subagent` tool + `workflowScript(runs.run/runs.all/runs.lanes/runs.steer/runs.host)` + mission/receipt/worktree/Herdr/watchdog，已经比 tintinweb 重、比 Codex/Amp/opencode 更偏“可审计的编排”。另起一套 DSL 就是 VISION 明令禁止的第二路径。
* 表现层现在是短板：有 `FleetView` + `/subagents-fleet` inspector + `s` steer / `D` stop，但缺 Claude 用户肌肉记忆的东西：空 prompt `↓` 进列表、`Enter` 看直播对话、`Enter` 直接 steer、`@` 点名、`Ctrl+O` transcript、`Shift+Tab` 权限模式。这正是 tintinweb 已经在 pi 协议内做通的部分，可整体搬运且不碰执行语义。
* 其他家的可学之处各取一段（详见 §1）：Codex 的权限继承+模型分级、opencode 的 primary/plan 双态+`Tab`、grok 的 dispatch/effects 分层+ACP、hermes 的 SQLite+skill 自生长、amp 的 orbs 远端跑、omp 的 Rust 性能底座、claw 的 parity harness 方法论。

---

## 1. 各家做法深度拆解

### 1.1 Claude Code CLI（金标准，所有 TUI 的源头）

官方 `code.claude.com/docs/en/interactive-mode + keybindings` 明确的交互契约：

* **中断/重定向优先**：`Esc` 中断当前 turn（保留已做工作，queued 消息接着发）、`Ctrl+C` 第一按中断、空 prompt 双 `Esc` 开 rewind（checkpoint 恢复/总结）。队列语义：`Ctrl+Enter` 立即发送 queued 消息。这套“永远可打断、打断不丢活”是 subagent steer 的心理基础。
* **后台任务一等公民**：`Ctrl+B` 后台化 Bash/agents、`Ctrl+T` 开关 todo 清单（注意：不是后台视图，后台看 `/tasks`）、`Ctrl+X Ctrl+K` 双按停掉本 session 全部后台 subagents。权限模式 `Shift+Tab` 在 `default/acceptEdits/plan/bypass/auto` 间循环——**权限是模式，不是逐条弹窗**。
* **Transcript viewer（`Ctrl+O`）**：时间戳+模型+工具展开，`?` 看帮助、`{/}` 跳 prompt、`[` 写回原生 scrollback 供 `Cmd+F`/tmux 搜、`v` 丢给 `$EDITOR`、`q/Esc/Ctrl+C` 退出、可重绑。fullscreen vs classic 双渲染器。
* **`@` 文件+session 双义**：`@` 先是文件补全；v2.1.232 起同前缀也建议本机其他 live session，可让 Claude 发跨 session 消息。这是 tintinweb `@mention` 的上游语义。
* **Subagents 章节**：前台/后台可切、`--resume/--continue` 恢复、plan 模式隔离。文档反复强调 context pollution/rot——主线程只留决策，噪音（探索笔记、日志、stacktrace）扔给子线程回摘要。这正是 Codex 也在官方文档里单独成章讲的同一件事。

**可学**：`Esc/双Esc/Ctrl+Enter/Shift+Tab/Ctrl+O/Ctrl+B/@` 六件套是肌肉记忆，不要自创键；权限模式化；transcript 可搜可导出；后台任务有统一的 `/tasks` 入口。

### 1.2 tintinweb/pi-subagents（Claude 交互在 pi 上的忠实移植，最值得抄）

源码已全量克隆比对（`src/ui/fleet-list.ts 543行 / conversation-viewer.ts 589行 / agent-widget.ts 659行 / agent-mention.ts 216行 / mention.ts 141行 / viewer-keys.ts` + `workflow/{card,dialog,menu}`）：

* **FleetView（`fleet-list.ts`）**：`belowEditor` 纯渲染 widget + `onTerminalInput` 统一截键（`getEditorText()===""` 才接管，正常打字零影响）。`main` + agents 按启动序排，`MAX 5行 + ↓N more`，`TICK 200ms` 刷新 elapsed/token，`FINISHED_LINGER 4s` 让已完成的多留一会儿可点。`↓/←` 空 prompt 激活、`↑/↓` 移 `●`、`Enter` 开直播 overlay、`Esc` 回 prompt。行格式 `11s / ↓13.1k tokens` 刻意对齐 Claude（整数秒、无小数）。
* **Conversation-viewer**：订阅 session events 实时流，`16KB` 单结果 cap（注释写明：uncapped 200KB 每键 ~6ms 解析 markdown，cap 后 ~0.5ms）+ chrome 与 content 分离（elide 提示不进 fence）；markdown 三态 `m` 循环 `off/raw → assistant/md → all/md+`，默认 pi 主题（有代码高亮）否则 SGR fallback；滚动键走 `tui.select.*` 用户绑，`k/j/shift+↑↓` 恒可用。**viewer 内 `Enter` 开 composer 直接 steer（空提交/Esc 返回），`x` 两按 stop**——前后台通用。这就是用户要的“Claude 味”。
* **Agent-widget（`agent-widget.ts`）**：`aboveEditor` 常驻树，braille spinner 10 帧、`reading/running command/editing…` 人话 activity、token/cost/turns/tags（`thinking: high/isolated`）、`MAX 12行` 溢出折叠、`all/background/off` 三档（默认 `background`——前台 inline 已有结果，不重复）。
* **`@mention`（`mention.ts + ui/agent-mention.ts`）**：语法 1:1 复刻 Claude：`MENTION_TRIGGER /(^|[\s。、？！])@([\w-]*)$/`（含 CJK 边界）、发送仅句首 `@handle + 非空消息`、裸 `@handle` 回主模型；handle 由 type slug（`handleBase` 小写+`[^a-z0-9_-]→-`+64 截）+ 碰撞编号（`explore/explore-2`，Claude `allocateName` 同款），`main` 保留；**超越 Claude 的一点**：roster = live records + tombstones（磁盘 session 可重开）+ 未启动 types（可直接起），三段按“可 steer → 其他 live（早启动优先）→ 可重开 → 可新建”排。补全包装 pi 的 `CombinedAutocompleteProvider`，`@` 文件优先、agent 附加、agents 排前，不吞文件（裸 `@` 仍可逛文件）。
* **Workflow UI**：`SubagentWorkflow` 卡片+`/agents→Workflows` 对话框+Fleet 互跳，`agent()` 支持 `gate: "npm test"`（命令验证代替再问模型）+ `resume: "<label>"`（续跑省 context），`meta` 纯字面声明 phases。脚本跑 `node:vm` worker，`Date.now/random/eval` throw（保 resume 前缀缓存确定性）。
* **嵌套**：`NESTED_TOOL_NAMES` + `allowed_subagents` allowlist 即权限边界，深度默认 2， transcript/cost 上卷，完即停。

**可学（P0 直接搬）**：上面四个 UI 文件几乎不依赖其执行层（Fleet 列表只吃 `AgentManager` 的窄接口 `FleetWorkflow`），可整体移植到 `pi-subagents-cc` 的 `subagent` 后端上。键、文案、cap、linger、排序都不要改——改了就不是 Claude 味。

### 1.3 OpenAI Codex CLI（最正统的 subagent 治理）

`developers.openai.com/codex/subagents` + `#12047/#29540` issue 诉求：

* **模型分级写死**：`gpt-6-sol(medium) 干难活 / luna(high) 干快活 / astra(low)`，未配则继承父，TOML 粒度 `model/model_reasoning_effort`，custom agent 文件三必填 `name/description/developer_instructions`，可覆 `sandbox_mode/mcp_servers/skills`。`[agents] enabled/max_concurrent_threads_per_session/default_subagent_model/interrupt_message` 全局兜底。**每多一个子 agent 就多一份 model+tool token**，文档明示并行读多写慎（写冲突+协调开销）。
* **权限继承**：子继承父的 sandbox+permission mode，单 agent 可覆只读。`AGENTS.md`/skill 可触发委托，`spawn two agents / one agent per point / wait for all` 显式编排，`open thread → steer/stop/close` 标准三件套。`MultiAgentV2` 强调 disjoint 文件 ownership + fan-out 只给独立子任务 + TUI 摘要而非全文。
* **TUI 诉求（#12047 _bundle）**：named agents（UUID→可读名）、per-agent config、async 编排、`@mention` 发消息——和 tintinweb 的 `@` 完全同构，说明这是行业共识缺口。

**可学**：per-agent 模型/推理分级（本仓已有 `models` action+`agentOverrides`，缺的是 Codex 式一句话 recipe）；sandbox/permission 继承声明化；读多写慎的 fan-out 指导语（塞进 scout/reviewer prompt 即可，零代码）。

### 1.4 xAI grok-build（Rust 重构派的架构范本）

`xai-org/grok-build + docs.x.ai/build/overview`：

* 全屏 mouse TUI（scrollback/prompt/session/modal）+ headless `-p`（脚本/CI）+ ACP 嵌编辑器三模，`AGENTS.md/plugins/hooks/MCP` 开箱，`/skillify` 把任意 session 固化成 skill。
* TUI 代码结构最值得抄：`app/`（顶层状态）→ `agent_view/`（per-session）→ `dispatch/`（Action→Effect 路由）→ `effects.rs`（异步副作用）。**状态与副作用彻底分离**，正是本仓 `src/tui/render.ts 175KB` 大文件最缺的。
* 模型 `Grok 4.6` + skills 复用，plan viewer 单独成章。

**可学**：把 `render.ts/fleet.ts` 拆成 `state/dispatch/effects` 三层；补 `headless` 一等入口（本仓已有 `async:false`，缺的是 grok 式 `-p` 心智）；`/skillify` 固化（hermes 的 skill 学习环的轻量版）。

### 1.5 omp / oh-my-pi（性能底座派）

`can1357/oh-my-pi`（`omp.sh`，`badlogic/pi-mono` fork）：`60+ providers / 31 tools / 14 LSP / 28 DAP / ~80k Rust core`，IDE wired-in，`.omp/commands+skills`，Bun 分发。用户说的 `omp` 若指此，定位是“把 pi 本体换成 Rust 以保 TUI 帧率”，不是 subagent 插件。

**可学**：TUI 热路径（status/fleet/Tick/文件扫描）必须有帧预算；LSP/DAP 操作数是 reviewer 可调用的下一批 tool（本仓 `watchdog_diff` 已有雏形）；`.omp/skills` 目录约定可兼容。

### 1.6 Sourcegraph Amp（远端执行派）

`ampcode.com/manual + docs/cli`：`amp` 本地/`-x` execute（跑完即退）/`-ox` orb-execute（云端跑、贴 URL 即走、`amp sync` 回镜），thread 记忆 Fast/Standard，`AGENT.md` 项目上下文，subagents 按需起。Orbs = “后台任务不在你电脑上”。

**可学**：本仓 `Herdr project pane + 远端 machine` 已有 orb 雏形，缺的是 `-ox` 式一句话心智 + URL 即走 + `sync` 回镜的闭环文案。

### 1.7 ultraworkers/claw-code（反模式教材）

README 开头即声明 `not the serious production project / museum exhibit / agent-managed exhibit`，真 harness 是 `LazyCodex/Gajae-Code`，本仓是 crab 梗+agent 自动维护的化石。Rust workspace + `PARITY.md + TUI-ENHANCEMENT-PLAN + MOCK_PARITY_HARNESS` 齐全。

**可学**：只学方法——`PARITY.md` 口径管理 + mock parity harness + `TUI-ENHANCEMENT-PLAN` 立项文档。本仓若做 Claude 兼容，必须先写 `PARITY.md`（哪些键/文案 1:1，哪些超越，哪些不做），否则 review 全是口水。

### 1.8 anomalyco/opencode（Bun 全栈派，TUI 信息密度最高）

`sst/opencode` fork，Bun monorepo + Turbo + Vercel AI SDK，`client(HTTP+SSE) ←→ server(推理/工具/session/MCP)`，TUI/Desktop/Web/Mobile 四端。`packages/tui` 基于 `@opentui+SolidJS`，路由+组件树+prompt 处理+plugin runtime 独立成包。

* Agent 二分：`primary(Build 全工具/Plan 只读,Tab 切换)` + `subagent(General/Explore/Scout,@直调)`，另有 compaction/title/summary 三隐藏系统 agent。权限 `allow/ask/deny` 取代旧 `tools` 布尔。`session_child_first(<Leader>+Down)/cycle(Right/Left)/parent(Up)` 在父子 session 间穿梭——比 tintinweb 的 Fleet 跳转更键盘化。
* 定制两路：`opencode.json agent.{model/prompt/permission/temperature/steps}` + `~/.config/opencode/agents/*.md`（文件名即 agent 名）。

**可学**：`Build/Plan` 双 primary + `Tab`（本仓 `delegate/worker` 可映射）；隐藏系统 agents（compaction 值得偷）；父子穿梭键（可并入 Fleet `inspect`）；`steps` 预算（本仓 `maxSubagentSpawnsPerRun 64` 同类，已有）。

### 1.9 NousResearch/hermes-agent（自生长派）

Python，`run_agent.py(AIAgent facade)→agent/conversation_loop.py+turn_*.py`，`cli.py→cli_*_mixin.py`，`model_tools.py/toolsets.py` 工具发现，`hermes_state.py SQLite` 状态，`website/docs/developer-guide/architecture.md` 三层（UI/编排/工具后端），CLI/Telegram/ACP/Desktop 四栖。卖点是唯一 built-in learning loop：从经验建 skill、用中改 skill、自 nudging 持久化、可搜历史会话、给用户建模。`$5 VPS` 即跑，`hermes model` 一键换模型。

**可学**：本仓 `agent-memory.ts + per-agent memory + progress.md` 是雏形，缺的是 hermes 式“skill 创建→使用→改写→索引”的闭环 + SQLite 可查（现在散在 `events.jsonl/output-*.log/transcript`，难查）；`hermes model` 式一键换模型（本仓 `action: models` 已有，缺别名 `haiku/sonnet` 模糊匹配——tintinweb 恰好有，可一起搬）。

---

## 2. pi-subagents-cc 现状差距（对着 tintinweb 逐项打分）

| Claude 心智 | tintinweb | pi-subagents-cc 现状 | 差距 |
|---|---|---|---|
| 空 prompt `↓` 进 Fleet，`Enter` 看直播，`Esc` 回 | 有（`fleet-list.ts`） | 有 FleetView（`src/tui/fleet-status.ts` 常驻 6 行+`fleet.ts` inspector），但激活是 `Ctrl+Alt+F`/`/subagents-fleet`，空 `↓` 不接管 | **P0：改激活手势** |
| viewer 内 `Enter` steer、`x` stop、`m` 切 markdown | 有 | inspector 有 `s` steer/`D` stop/`H` inspect，需显式命令+确认，无 inline composer、无 `m` 三态 | **P0：搬 composer+`m`** |
| `@` 点名（跑中 steer/跑完 resume/磁盘重开/未起直起） | 有（roster 三段） | 无。`@` 仍是 pi 文件补全 | **P0：加 mention provider** |
| widget 常驻（spinner/activity/token/cost） | 有（`aboveEditor`） | 只有 `belowEditor` Fleet 状态条（`fleet-status.ts`），无 `aboveEditor` 活动树 | P1：加 widget |
| `Ctrl+O` transcript、`Shift+Tab` 权限、`Ctrl+B` 后台 | 有近似（viewer/`tui.select`） | 无统一键，散在 slash（`/parallel-review//review-loop//council`） | P1：键统一 |
| workflow live card + `/agents→Workflows` | 有 | 有 `chatProgress live-card`（仅 `async:false` 同 repo）+ missions/schedules，无 card 即 viewer 跳转 | P1：补跳转 |
| 模型别名（`haiku/sonnet`）+ 大小写不敏感 agent | 有 | `action: models` 要求精确 `provider/id`，agent 名大小写敏感 | P1：模糊匹配 |
| `gate/resume` 命令验证/续跑 | 有 | 有 `resume/steer follow_up`，无 `gate: cmd`（命令代替再问模型） | P2 |
| 嵌套子 agent allowlist | 有 | 有 `contact_supervisor/intercom`，无 `allowed_subagents` 显式边界 | P2：按 VISION 先判必要性 |

好消息：底层能力（前后台双跑、steer 三态 `steer/follow_up/auto`、ack+ledger、worktree 隔离、Herdr 远端、watchdog、missions/receipts）**比 tintinweb 厚**，所以是“表现层落后、执行层超前”，搬 UI 无需动引擎。

---

## 3. 方案：表现层复刻 Claude，执行层保持单轨

### 原则（先堵住 VISION 审查）

1. **只加表现，不加执行**：`Agent/get_subagent_result/steer_subagent/SubagentWorkflow/agent()/parallel()/pipeline()` 一律不注册。Claude 兼容以“翻译文档+快捷键+显示”实现，不以“第二套 tool”实现。
2. **键与文案 1:1，语义映射一处**：新建 `docs/claude-parity.md`（学 claw 的 `PARITY.md`），每条写清 `Claude 键→本仓动作`（如 `steer_subagent→subagent({action:"steer"})`），review 只对表。
3. **热路径预算**：viewer cap 16KB、Fleet tick ≥200ms、widget 12 行封顶（照抄 tintinweb 注释里的数字，附 benchmark）。

### P0（一个版本，Claude 味成型）

1. **Fleet 激活手势**：`src/tui/fleet-status.ts` 加 `onTerminalInput` 截键（抄 `fleet-list.ts: `getEditorText()===""` 门控），空 prompt `↓/←` 激活、`↑/↓` 移、`Enter` 进 viewer、`Esc` 回。保留 `Ctrl+Alt+F` 作兼容，不删。
2. **Viewer inline steer + `m`**：`src/tui/fleet.ts` inspector 内加 composer（`Enter` 开、`Esc`/空提交退，消息走现有 `steerAsyncRun` ack 通道）+ `m` 三态 markdown（`off→assistant→all`，`16KB` cap 照搬）。`s/D/H/r/x/X/Ctrl+O` 键位保持可配（`DEFAULT_FLEET_KEYBINDINGS` 不动）。
3. **`@mention` provider**：新增 `src/tui/mention.ts`（移植 `handleBase/assignHandle/MENTION_TRIGGER/@agent-` 前缀逻辑）+ `src/extension/index.ts` 用 `ctx.ui.addAutocompleteProvider` 包 pi 原 provider（文件优先、agent 附加、agents 置顶）。分发：句首 `@handle+消息`→运行中则 `steer`、已完成则 `resume`、磁盘有则重开、从未起则 `subagent({agent,task})` 起；裸 `@handle` 回主模型；`@main` 强制回主。roster 排序照搬 tintinweb 三段。
4. **文档**：`docs/claude-parity.md` + `README` “Try this first” 追加 `@reviewer/@scout` 示例 + `/subagents-guide` 加 `parity` topic。

### P1（下个版本，密度与手感）

5. **`aboveEditor` widget**：新增 `src/tui/widget.ts`（移植 spinner/activity/`MAX 12行`），`config.widget: all/background/off`（默认 `background`），数据只读现有 `fleetStatus` 快照，不新增状态源。
6. **键统一**：`Esc` 中断保留、`双Esc` 清空→rewind 预留、`Ctrl+O` 开 transcript（接现有 `view: transcript`）、`Ctrl+B` 后台化（`async:true` 重发）、`Tab` 在 `delegate/worker` 间切（映射 opencode Build/Plan）。
7. **模型别名**：`resolveHandleToType` 式大小写不敏感 + `haiku/sonnet` 模糊到可用模型（抄 tintinweb `model-resolver.ts`，先过滤已配置 provider）。
8. **Workflow→Fleet 跳转**：`chatProgress live-card` 可点进 inspector（现有 `inspector.open`），`mission.show` 刷新后直达 run。

### P2（按需，做前先过 VISION）

9. **`gate: cmd`**：`runs.run` 加可选 `verify: {command}`，跑在子 worktree，失败即 `verdict: blocked`（对标 tintinweb `gate`，省一次 reviewer token）。
10. **`allowed_subagents`**：仅当 nested 误用出事再加，目前 `contact_supervisor` 够用不加。
11. **hermes 式记忆闭环**：`agent-memory` 加 SQLite 索引 + `/learn` 固化 skill（对标 grok `/skillify`），远端跑对标 Amp `sync` 文案。

### 明确不做

* 注册 `Agent/get_subagent_result/steer_subagent/SubagentWorkflow` 任一 tool；支持 `agent()/parallel()/pipeline()` 脚本（用户脚本用 `docs/workflows.md` 的 `runs.*` 重写，给一段对照表即可）。
* 把 `subagent` 改名 `Agent`（大小写工具在 pi 生态是两个工具，改名即 breaking，不符合 `Compatibility is explicit` 的硬切要求，除非 owner 点头）。
* 动执行语义（mission/receipt/steer ledger/worktree/Herdr），P0 全部只读现有快照。

---

## 4. 落地清单（文件级）

| 改动 | 文件 | 说明 |
|---|---|---|
| 新增 | `src/tui/mention.ts` | 移植 `mention.ts + agent-mention.ts`（roster/trigger/assign） |
| 新增 | `src/tui/widget.ts` | 移植 `agent-widget.ts`（spinner/activity/cap） |
| 新增 | `src/tui/viewer-composer.ts` | viewer 内 steer composer（或并入 `fleet.ts`） |
| 新增 | `docs/claude-parity.md` | PARITY 表（键/文案/映射/不做） |
| 修改 | `src/tui/fleet-status.ts` | 加空 prompt 截键激活 |
| 修改 | `src/tui/fleet.ts` | 加 composer + `m` + `Ctrl+O` |
| 修改 | `src/extension/index.ts` | 注册 mention provider（~30 行） |
| 修改 | `src/extension/config.ts` | `widget/fleetViewPlacement`（默认不动） |
| 修改 | `README.md`、`skills/pi-subagents` | `@` 示例 + parity topic |
| 测试 | `test/unit/mention.test.ts`、`viewer-cap.test.ts`、`fleet-keys.test.ts` | 照搬 tintinweb 对应用例（trigger/assign/cap/键） |

验收：空 prompt `↓→Enter→打字Enter→Esc` 全程不碰鼠标完成一次 steer；`@scout` 未启动直起、`@reviewer` 跑中转 steer、跑完转 resume；`m` 三态+16KB 大结果不卡（每键 <1ms）；`docs/claude-parity.md` 逐条可勾。

---

## 5. 附：omp 指代澄清

* 若 `omp` 指 `oh-my-posh`：本仓只需兼容其 footer 模板（读 `ctx` 模型/上下文/token 透给 OMP），与 subagent 无关，不列入 P0。
* 若指 `can1357/oh-my-pi`（`omp.sh`）：那是 pi 本体的 Rust fork（IDE/LSP/DAP/多 provider），与本插件正交。建议只取其性能预算思想，不跟进 fork 本体，否则偏离 VISION 的 delegation-layer 定位。
* `FORK.md` 的 `omp-style` 仅指“独立 fork（非 GitHub fork 按钮）”，与上述两者都无关。
