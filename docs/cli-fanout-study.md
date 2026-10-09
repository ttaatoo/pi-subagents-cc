# pi-subagents-cc CLI Fan-out 深研：指导意见 + 参考学习资料

> 方法：本轮对 8 个 CLI 各起一路独立 subagent 深挖（源码实读 + 官方文档），再以 `tintinweb/pi-subagents@0.19.0` 为 TUI 基准对照。上一轮广度扫描见 `docs/research-tui-parity.md`，本报告是其 fan-out 纵深版，可直接作为改码依据和新人学习路径。
> 基线：`pi-subagents-cc = nicobailon/pi-subagents@a859d1de (0.70.1)` 单 `subagent` tool + `workflowScript(runs.run/runs.all/runs.lanes/runs.steer/runs.host)` + mission/receipt/worktree/Herdr/watchdog。约束 `VISION.md`：单一 delegation layer，不开第二执行路径。

---

## 1. tintinweb 基准（先定标尺，再谈别人）

实读 `src/ui/fleet-list.ts(543)/conversation-viewer.ts(589)/agent-widget.ts(659)/agent-mention.ts(216)/mention.ts(141)/viewer-keys.ts` + `src/workflow/tool-description.ts` + `src/nested-tools.ts` + `src/default-agents.ts`：

* **执行面**：`Agent` + `get_subagent_result` + `steer_subagent` 三 tool + `SubagentWorkflow(agent()/parallel()/pipeline()/phase()/log()/args/meta/schema/budget/workflow())`。`agent()` 默认 pipeline（无 barrier，多 item 可处不同 stage），`parallel()` 是 barrier；`schema` 做结构化返回（失败重试 5 次→`null`）；`gate:'npm test'` 命令验证代替再问模型；`resume:'<label>'` 按 label 续跑；`node:vm` 沙盒禁 `Date.now/Math.random/无参new Date/eval`（保 resume 前缀缓存）；并发 `min(16,CPU-2)`，单 `parallel/pipeline` 4096 项，单 run 1000 agents。
* **嵌套面**：`NESTED_TOOL_NAMES` + `allowed_subagents` allowlist 即权限边界，`maxSubagentDepth` 默认 2（main=0→child=1→grandchild=2），transcript/cost 上卷，完即停。
* **默认 agents**：`general-purpose/Explore/Plan`（后两者只读 `read,bash,grep,find,ls` + 强只读 prompt，Explore 跳过 CLAUDE.md 与 git 快照，Plan 做架构计划）。
* **表现面**（P0 照搬对象）：Fleet `belowEditor` + `onTerminalInput`（`getEditorText()===""` 才接管）+ `main`+agents 启动序 + `MAX 5行` + `TICK 200ms` + `FINISHED_LINGER 4s` + `11s/↓13.1k tokens` 行式；viewer 订阅 session events + `16KB` 单结果 cap + `m` 三态（`off/raw→assistant/md→all/md+`）+ `Enter` 开 composer 直接 steer + `x` 两按 stop；widget `aboveEditor` + braille 10 帧 + `MAX 12行` + `all/background/off`（默认 `background`）；`@` 语法 1:1 Claude（`MENTION_TRIGGER /(^|[\s。、？！])@([\w-]*)$/`、发送仅句首 `@handle+非空消息`、裸 handle 回主模型、`main` 保留、碰撞编号 `explore/explore-2`、支持 `@agent-` 手打前缀），roster 三段（live→tombstone 磁盘重开→未启动 types 直起，`@explore` 语义“在跑则消息，否则启动”）。

**判定**：执行面与本仓 `runs.*` 互斥（不搬）；表现面与本仓 `src/tui/fleet-status.ts + fleet.ts` 同槽（全搬）；`gate/resume-label/别名` 属可搬语义（见 §3）。

---

## 2. 八 CLI 独立深研摘要（每节皆可展开为学习单）

### 2.1 grok-build（xAI，Rust 重构派，架构范本）

* **架构**：84 crates。`crates/codegen/xai-grok-pager/src/app/` 即规范：`agent.rs` 纯类型 → `agent_view/` ViewModel → `actions.rs(Action→Effect→TaskResult 三枚举)` → `dispatch/` 同步确定性状态机（立约永不碰 terminal/network/fs）→ `effects/mod.rs(~5600行)` 在 `JoinSet` 上 spawn → `event_loop.rs` 瘦 `select!`。`xai-chat-state/src/actor/` 独立 task 拥有全部 chat state；`xai-prompt-queue` 双层 queue（server-authoritative + 本地 drip-feed，合并规则 `combine.rs`）；`xai-fast-worktree` CoW/btrfs 隔离；`xai-workflow` rhai 引擎。单测不需终端/tokio（`dispatch/tests + app_view_tests 306KB`）。
* **subagent**：`spawn_subagent{prompt,description,run_in_background=true,isolation:none|worktree,resume_from,cwd}` + `get_command_or_subagent_output{task_ids≤20,timeout≤1h}`（all 语义）+ `kill`（SIGTERM→SIGKILL）。**扁平一层**（child 再 spawn 直接 depth-limit 失败），`(subagent_id,attempt_id)` reducer 留最近 8 attempts + seq 高水位防重放。Agent（整 session：model/tools/prompt，`.grok/agents/*.md`）vs Persona（语气/格式/IO 契约的 system-reminder 叠加，`inputs/outputs` 文件契约可链式，`model/effort/isolation` 可覆）。内建 `general-purpose/explore/plan`（后两者只读+shell 禁写），Capability `read-only/read-write/execute/all` 由 role 定。MCP 默认继承，可 `all|none|named|except`。并行靠多 spawn + 一次等多个 id，无 group-join 原语；分组靠 `/workflow parallel()` barrier（`agent_budget 128`、并发 32）与 `/loop/scheduler/monitor`。
* **TUI**：ratatui 全屏 mouse（`mouse.rs ~1700行` click-to-focus + rect hit-test），`scrollback/` 虚拟化（fold `h/l/e`、raw `r`、copy `y`、全屏 `Enter/Ctrl+F`、OSC8 链接），prompt `158KB`（image chip `@` slash undo/stash），`Tab/Space` 切 prompt/scrollback（**Esc 只做 clear/rewind，不做焦点**），`~/.grok/sessions/<cwd>/<uuid>/{summary,updates.jsonl权威,chat_history,plan,rewind_points,subagents/meta}`，`/new|resume|fork|rewind|compact|dashboard(Ctrl+\)`，plan viewer（`a` 批/`s` 改/`c` 行评/`q` 弃/`Tab` 切 preview/prompt），键 `Ctrl+P面板/Ctrl+G tasks/Ctrl+T todo/Ctrl+B 转后台/Ctrl+; queue/Shift+Tab 模式/Ctrl+O 权限/Ctrl+R picker`，`minimal/fullscreen` 双渲染。
* **三模**：`grok` 交互 / `grok -p --output-format plain|json|streaming-* --model/--cwd/--yolo/--effort/--permission-mode/--allow/--deny/--sandbox` headless / `grok agent stdio|serve` ACP（一后端三前端，`GROK_CONFIG` overlay）。Skills（`SKILL.md + allowed-tools/argument-hint/user-invocable`，`local:|repo:|user:|plugin:` 限定名，`/create-skill` 脚手架）+ hooks（PreToolUse/Stop/PostToolUse/SessionStart，可 block/改写）+ memory（`/memory|flush|dream|remember`）+ 后台三件套（`run_terminal_command + /loop≥60s≤50个 + monitor行流 + scheduler`）。
* **给本仓 5 条**：①拆 `dispatch/(纯函数返Effect值)+effects/(调runs.*)`，`render.ts` 只读；②扁平一层 + `(id,attempt)` + 高水位去重，`runs.lanes` 只做多 spawn+all 等；③Agent vs Persona 分离（spawn 不设 persona，resolution 按 spawn>role>persona>parent 叠）；④plan 态只放 `plan.md` 写，其余 edit 直失败并点名（shell/子写诚实声明不管）；⑤`Ctrl+G` tasks pane + 顶部 `◎ N still running` + 父 scrollback 一行生命周期块（Enter 进只读子视图）。

### 2.2 Codex CLI（OpenAI，正统治理派，判例最多）

* **授权门**：`multi_agents_spec.rs:706` 硬约束“无用户明示并行/委托或 AGENTS.md/skill 要求不得 spawn，‘深入/彻底/调研’不算授权”；阻塞任务主线程自做，只委托有界 sidecar；`wait_agent` 极少调；不重做已委托活。理论牌是 context pollution/rot（主留决策、子做噪音活、只回摘要）。
* **Agent 定义**：`~/.codex/agents/ + .codex/agents/*.toml`（`name/description/developer_instructions` 必填，`model/effort/sandbox/mcp/skills` 可选，同名覆 built-in），`default/worker/explorer` 三内建（explorer prompt 在代码里，0 字节 toml，信任结果不复验+鼓励多 explorer 并行+等时本地继续干），`awaiter(low)` 已注释下线。全局 `[agents] enabled/max_concurrent_threads_per_session/default_subagent_model+effort/interrupt_message`，优先级 显式 spawn>`[agents]`>继承父。
* **TUI 判例**：`#29540`（starSumi，主张不加 runtime，只加强根指导 + `/agent` 有界 roll-up + batch 身份除非必要）是正面判例（本仓同学：单 tool + workflowScript 先行）；`#12047`（长文要 named agents/per-team config/`@{team}/{agent}`/async inbox，是需求池但维护者未采 team）；另有 `#23479` preflight、`#26822` 无结果 shutdown、`#19197` orphan 泄漏 treshold 卡死，必做收尸路径。
* **权限/模型**：子继承父 turn 快照（approval_policy/cwd/permission_profile），想锁只读必须在 agent 文件显式写；`sol/medium` 难活、`luna/high` 快活、`astra/low` 最难端到端，`Ultra=子并行加速`。
* **给本仓 4 条**：①授权门文案进主 prompt；②配置键全家桶（全局 4 键 + 单 agent 7 键，scout 默认只读，worker 写 ownership）；③fan-out 指导语（独立子任务+disjoint 写集+forked 改+读多写慎，等时本地干不重叠活），先不加 batch tool；④可观测最小集（`nickname[role]+task-path+●/■`，预览 160/240 截，`--verbose` 才看 ID，spawn 前 capacity preflight + orphan 回收）。

### 2.3 omp / oh-my-pi（`can1357/oh-my-pi`，性能底座派）

* **定位**：`badlogic/pi-mono` fork，`60+ providers/31 tools/14 LSP ops/28 DAP ops/~80k Rust core`，Bun 分发（平台叶包 `pi-natives-<plat>-<arch>` + AVX2 modern/baseline + `~/.omp/natives` 缓存），9 意图 role（`default/smol/slow/plan/commit/vision/task/advisor/tiny`，`smol` 专供 fan-out 降本，`/model` 一键切）。
* **IDE wired-in**：LSP（`lsp/types.ts + defaults.json`，cwd-only 自动检测，`~/lsp<plugin<~/.omp<.omp<lsp.*` 浅合并，50+ server，prompt 写 MUST 用 lsp，rename 走 `willRenameFiles`，写后 format+diagnostics，bench 有 10 倍 lift 数据）+ DAP（`launch/attach/step/evaluate` 28 actions，只读/执行分级，真调 C/Go/Python）+ 双 kernel 回调 tools。
* **skills**：`<skills>/<name>/SKILL.md` 非递归 + 轻检索面（system 只放 `name+description`，正文 `skill://` 懒读，禁 `..` 逃逸）+ 优先级 `native100>plugins90>claude80>…>auto-learn5` + 自带 `semantic-compression`（重编码+ density gate）与 `tool-prompt-optimization`（`probe-builtin` 实测 schema 可推断性 + scar tissue 清理 + 好 prompt 解剖式）。
* **TUI 启示**：差分渲染 + CSI 同步防闪 + `grep/ast/glob/fd` 直链（无 fork）+ `fs_cache` 共享扫描 + token/summary/highlight 进 libuv 池 + time-travel stream rules + subagent worktree 隔离。`render.ts 175KB` 正是该用 compression+probe 先量后砍的对象。
* **给本仓 5 条（仅插件层）**：①包 LSP-diff 只读工具（edit 前 `diagnostics/references/hover`，写后 format+回检，无 server 显式降级）；②兼容 skills 目录 + 大 prompt 按解剖式重写；③热路径预算（拆模块+节流+快照缓存+注入 5000 token 上限）；④抄 role 路由（fan-out 强制 `smol`）；⑤轻 memory（`learned.md 100条cap + MEMORY.md + summary`，`retain/learn/recall` 起步）。

### 2.4 Claude Code CLI（金标准，键表最全）

* **中断/队列**：`Esc` 中断保活（queued 接着发）→`双Esc`（有字存草稿/空开 rewind）→`Ctrl+C`（运行中断/空闲清/再退）→`Ctrl+Enter/Ctrl+X Ctrl+S`（v275+ 立即发队列）→`Ctrl+X Enter`（v247+ 反向排队）→`Up` 首行取回队列。`!` shell 模式（v186+ 默认回复，`respondToBashCommands:false` 恢复旧）。
* **权限模式**：`Shift+Tab` 循环 `default(Manual)→acceptEdits→plan→[bypass]→auto→回`，`manual` 为 default 别名（v200+），`auto` 内置默认（v228/233+ 分平台），子默认继承（主 bypass/accept/auto 时子字段忽略，auto 下 classifier 双审；主 default/dontAsk/plan 时生效，v267+ 主非 bypass 则子 bypass 无效）。
* **Transcript/双渲染**：`Ctrl+O` 开关（时间戳+模型+工具展开），`?/{/}/Ctrl+E(classic)/[/v/q` 全键；fullscreen（备用屏+可视区+鼠标+钉底输入，上滚暂停 auto-follow）vs classic（scrollback 直搜），`CLAUDE_CODE_NO_FLICKER/mouse` 等 env，`/tui` 查器。
* **Subagents**：`Explore/Plan` 只读（v198+ 继承主模型封顶 Opus，此前 Haiku，跳 CLAUDE.md/快照，`DISABLE_EXPLORE_PLAN=1` 可去）+ `general-purpose/claude` 全工具；后台工具集更小（无 `Agent/AskUser/EndConversation/PlanMode/ScheduleWakeup/Workflow` 等）；`Ctrl+B` 后台化、`Ctrl+X Ctrl+K` 双按全停、`/tasks` 看模型+effort（v242+）、`maxTurns` partial（v246+）；`--continue/--resume/--from-pr` + 子 per-invocation model（v211 修复 resume 丢失）；`@` 文件 + v232+ 同前缀 live session（`ListAgents/SendMessage`，`notify_when_idle` v236+，`crossSessionInbound accept/hold/refuse`，到达一行 dim 预览 `Ctrl+O` 展开，v251+ 消息内 `@` 纯文本，永不代批/改配/跑 `/`）；plan 隔离（`isolation:worktree` 默认基为默认分支，v203+ 逃逸失败，v210+ 查全 repo linked worktree）。
* **Workflow 源语**：`ultracode` 触发（`Alt+W` 撤、`--effort ultracode` 全 session，v203+）+ `/deep-research` + `/workflows` 视图（`↑↓/Enter/→/Esc/←/j/k/f/p/x/r/s`）；`agent(null on 停/不可恢复错，auto 下脚本 prompt 不计用户请求)/parallel( barrier )/pipeline(无 barrier)/phase/log/args/meta(首句纯字面 name+description+phases)/schema(矛盾预检+5重试)/budget( total 恒 null )/workflow(一级嵌套)`；禁 `import/fs/Date.now/random/无参Date/eval`；16 并发（`MAX_CONCURRENT 1-256` v269+），单调用 4096 项，单 run 1000 agents，前缀 5s 共享 prompt-cache（`STAGGER_MS`，`cacheTtl 1h`），25 agents/1.5M tokens 警告；续跑 completed 缓存 + 首变与其后重跑 + usage-limit 暂停等 reset（v271+，`autoContinue` 24h 两次）；存量 `.claude/workflows + ~/.claude/workflows + meta.whenToUse + 插件 workflows/`。
* **对照结论**：tintinweb `gate/resume-label` 是上游没有的扩展（上游是停单个按失败重跑 + relaunch 缓存 + verify agent），本仓对照表应写 `agent→runs.run/parallel→runs.all(lanes)/pipeline→runs.lanes/steer→runs.steer/gate→verify命令+verdict:blocked(新增)/resume-label→SavedResults(近似)`。
* **键缺口表**（Claude→本仓 `DEFAULT_FLEET_KEYBINDINGS`）：`双Esc/Ctrl+Enter系/Shift+Tab/Ctrl+O全文/Ctrl+B/Ctrl+T/Ctrl+X Ctrl+K/Alt+P/Ctrl+R/Ctrl+D/Ctrl+G/Ctrl+S/Ctrl+V/空?/Up取回/!/diff` 全缺，`Tab` 部分齐。顺序 P0（`@`+空 `↓/Enter/Esc`+viewer `Enter/m`）→P1（`Ctrl+O/B/Shift+Tab/Alt+P/R/S`+widget）→P2（`Ctrl+X` 和弦+`!`+multiline 五式）。

### 2.5 Amp（Sourcegraph，远端执行派）

* **三模**：`amp` 交互（可 `--executor orb|runner` 先选位）/ `-x` 本地跑完即退（双输入 `echo|cat diff |`，重定向即非交互，`--mcp-config/--plugin-ready-timeout`）/ `-ox` 云端贴 URL 即走（`--project/--orb-size/--fast/--mode/--title/--attach/--stream-json`，`threads continue T-… -ox` 唤醒旧 orb，`amp sync` 镜回不打断）。Runner（`--executor runner:<id> --runner-dir`）是“我的常驻机”第三极。记忆两层：Fast 开关（交互记上次，非交互默认 Standard）+ Dial 不可变（`low/medium/high/ultra` 首条锁定，`medium` 默认，`Ctrl+S` 转盘，`Settings→Tune/Build Dial` pin 模型+effort，换模重开）。
* **Orbs**：一 thread 一机（60GB 盘，`tiny1C2G $0.08/h→3xlarge $2.13` 按分计，闲 5min+无交互 20min pause，portal 访问算交互，archive 即 pause，用户 20 orb 后每 5min 一起排队），`.agents/setup`（snapshot 一次）+`.agents/resume`（每次 wake）+`.amp/services.yaml`（Portal 暴露），`Set Up with Amp` 自生成，`Ship`（trunk: commit→rebase→test→push→冲突自解→archive / branch / 10k 字 custom 如 `gh pr create`）。跨端原生（desk 起手机收 Mac 核，macOS/iOS 一等，`AMP_API_KEY=sgamp_` + `continue -ox` 从 CI 唤醒）。
* **Subagents**：主 + `Search/Oracle/Librarian/Read Thread` + 插件 mode，`medium` 自动裂变，子互不可见、不可中途指导、只拿转交上下文、只回摘要（省主窗但黑盒）。`AGENTS.md`（复数，已统 `agents.md`；cwd→`$HOME` 全含 + subtree 按需 + global/workspace + `@` 引用 + `globs` 懒载，`/agent` 生成，`agents-md list(Ctrl+O)` 可查）。
* **给本仓 4 条**：①`pi -ox` URL-first（建 thread→远端起机→打印 URL→本地退，`--stream-json` 兼容，Herdr 行显 running/paused/size/cost + Open/Sync/Ship）；②`pi sync`（镜回不停）+ `pi ship`（`Pi-Thread-ID` trailer + PR 贴链）；③`.agents/setup+resume` 快照约定 + `Set Up with pi` 向导；④Dial 首条锁定（2-4 槽）+ AGENTS 分层收录 + `agents-md list` 可视化，subagent 仅 medium 裂变且只回摘要。

### 2.6 claw-code（ultraworkers，方法论派）

* **定位**：README 三连“museum exhibit/fossil/agent-managed”（`PHILOSOPHY.md`：协调系统是本体，文件只是证据），真 harness 是 `LazyCodex(codex寄生深度)` + `Gajae-Code(通用调度，四workflow+四role+tmux，不收API税)`，本仓是化石。**学治理不学功能**。
* **结构**：`rust/` canonical（10 crates：`api/runtime/~50模块/tools/commands/rusty-claude-cli 739KB/plugins/mock-anthropic/compat-harness/claw-analog/doctor/telemetry`，`unsafe_forbid`，`claw doctor` 首检，`claw acp` 诚实 `supported:false`）。
* **治理四件套**：`PARITY.md` 双层（Rust-port 检查点 + CC2.0 总闸，`merged on main vs branch-only` 诚实区分）+ mock harness（`mock-anthropic-service + harness + scenarios.json(12场景)+run_diff.py --no-run` 漂移检查，无 key 可跑）+ `TUI-ENHANCEMENT-PLAN`（先体检 `main.rs 3159行monolith` 15 缺陷，再 Phase0 拆→HUD→流式→工具可视→导航→主题→ratatui，每项 S/M/L/XL）+ `.omx`（`goals.json G001-G012 + ledger.jsonl leader专写 + board.json 542 actions + verification-map按文件列现状/风险/测试 + quality-gate.json(verification+known_gaps显式带缺口过门) + issue-parity-intake(bucket+生命周期+adaptation rule) + anti-slop(自动化只建议不直合)`）。
* **给本仓 4 条**：①抄双层 PARITY（含 lane 表 + branch-only 诚实）；②抄 mock 三件套（先权限 allow/deny + 多工具同 turn + 流式三类）；③抄 TUI plan 骨架（体检→拆 monolith→HUD→流式→可视→导航→主题→全屏）；④抄 quality-gate + verification-map + anti-slop 门。

### 2.7 opencode（anomalyco fork，Bun 全栈派，密度最高）

* **架构**：Bun+Turbo+Vercel AI SDK（75+ providers，`models.dev` 元数据），`Hono Server`（`/session|agent|provider|mcp|config|permission|question|pty|file|lsp|skill|tui` + `GET /event` SSE 10s 心跳，Drizzle SQLite，`bus` 总线）←HTTP+SSE→ TUI/Desktop/Web/Mobile/VSCode/Zed，`opencode serve|run|acp` 做网关/CI。新 TUI `packages/tui(app.tsx 20+ Context嵌套 + @opentui/core Zig + solid + 60fps + passthrough)`，20+ 主题 JSON 热切，prompt frecency/stash/slash 面板。
* **Agent 二分**：`primary(Build全工具/Plan只读edit|bash ask，Tab/agent_cycle 切换)` vs `subagent(General全除todo/Explore只读grep|glob|read|ls/Scout只读clone依赖到缓存，@直调或task委派)` + 隐藏 `compaction/title/summary(mode:primary但不可选)`。权限 `allow/ask/deny`（`read|edit|glob|grep|list|bash|task|skill|lsp|question|webfetch|websearch|external|todo|doom_loop`，对象细粒度+glob末胜+`*`首位，`bash` 到命令级，`task` 到子 agent 级，`read *.env*` 默认 deny，`--auto` 只放 ask 不动 deny）。单 agent `description必填(委派路由)|model|prompt({file})|temperature(Qwen0.55余0)|steps|disable|color|hidden|task`。
* **两路定制**：`opencode.json agent.*`（随仓策略）vs `~/.config/opencode/agents|./.opencode/agents/*.md`（文件名即名，`agent create/list` 向导）。8 级 config 合并（remote well-known→global→env→项目根→.opencode→content→managed→MDM）。
* **穿梭/循环**：`leader=ctrl+x，Down进首子，子内Right/Left循环，Up回父`（fork 修正了文档错位）；循环 `输入→config+AGENTS→Primary→{工具→permission闸→执行→回填；委派→task子会话}→回复→SQLite+Git snapshot+title/summary SSE广播`，`todowrite` 长任务进度。多 Build 并行易 Git 冲突，建议分分支/串行合。
* **给本仓 4 条（对 VISION）**：①`delegate(全权类Build)/worker(只读类Plan)` 双 mode 复现有 permission，不增第三模式；②隐藏 summarizer 必须落 artifacts + Fleet 条目（含 hash/前后 token）；③child 默认 `steps 5-10` 超限强总结 + `task:{*:deny,explore:allow}` 防幻调；④穿梭键并入 Fleet inspect（Down/Right/Left/Up 同义）。

### 2.8 hermes-agent（NousResearch，Python 自生长派）

* **三层**：L1 接入（`cli.py facade→cli_*_mixin + subcommands`、`gateway/run.py 25+平台telegram/discord/slack/whatsapp/matrix/feishu`、`acp_adapter/`、`batch_runner`、`ui-tui Node子进程`+Desktop）→ L2 编排（`run_agent.py` 瘦 facade，`conversation_loop.py run_conversation ~3900行 + turn_*.py + agent_init`，`prompt_builder→runtime_provider→三API→model_tools分发→循环`，`tool_executor` 先拦 `todo/memory/session_search/delegate_task` 再 registry，70+工具/28 toolsets，多工具线程池并发按序回填，7 终端后端 + 5 浏览器后端 + MCP 动态）→ L3 状态（`hermes_state.py + siblings`，`~/.hermes/state.db` WAL：`sessions/messages/messages_fts(FTS5)/lineage(parent_session_id)`，CLI/TUI/网关共库互 resume）。
* **学习环（业界唯一完整）**：`/learn` 建 skill（`~/.hermes/skills/<cat>/<name>/SKILL.md`，agentskills.io 兼容，`skills_list→skill_view` 渐进，大语料瘦 SKILL+`references/`蒸馏）→ 用中 `skill_manage(patch)` 改（`write_approval` 进 `pending/<id>.json` 待审）→ 每 turn fork 后台 review（`background_review.py`，主模型暖 cache 或 `aux:gemini-flash` digest 省 3-5 倍，每 ~10 turn 查重复纠正→memory/可复用→skill，`💾` 提示）→ `curator(active→stale14天→archive30天→.archive/，pin/adopt/restore/ledger/rollback，仅管agent建)` 防堆 → `session_search(FTS5 ~20ms直查无LLM)` + `MEMORY.md 2200 + USER.md 1375` 开局冻结快照（保 prefix cache，超限自压缩）+ 外挂 `Honcho/Mem0/Hindsight`（画像注入 user message 不污 system cache）。
* **模型/上下文**：`hermes model` 三端共用 picker + 18+ provider（`api_mode chat|codex|anthropic` 归一 OpenAI 格式，显式>config>env），Portal 一次 OAuth 300+ 模型；`credential_pool` 同 provider 多 key 轮转 + `fallback_providers` 跨链（401 先 refresh）；双压缩（Agent 内 50% lean：保头3保尾N+摘要+原话+搜索指针，500K→49K；网关 85% 兜底）+ `usage_anchor` 真 token + cache 失败冷却 60→300→900s。
* **TUI**：经典 CLI 即全 TUI + `--tui` 差分 Node 前端：多行 `Alt+Enter/Ctrl+J/Shift+Enter` + `$EDITOR(Ctrl+G)` + `Ctrl+S` 草稿栈 + `Tab` slash（含 skill→`/skill`）+ SQLite resume + `/sessions` 切换器（`Ctrl+X` 多 live 分发）+ `interrupt-and-redirect(busy_input:interrupt|queue|steer，_interruptible_api_call + OOB steer，Ctrl+C 断//stop转后台)` + streaming（`stream_delta/tool_gen/thinking/status` + `details hidden|collapsed|expanded` + `KawaiiSpinner + ▶N/🗜️N/⚠YOLO`）+ `!cmd` 零 token 直跑。
* **给本仓 4 条**：①SQLite 索引 events（`sessions/messages/fts + lineage`，`session_search` 直查）；②`/learn` 固化（`≤60字description+When/Procedure/Pitfalls/Verification`，`references/` 懒载）；③`haiku/sonnet` 别名 + 主/aux 分开配（cheap 跑 review）；④双阈值压缩（50% lean + 85% 兜底）+ 冻结快照保 cache + `/compress` 手动 + `🗜️N` 计数。

---

## 3. 比较矩阵（一页看全）

| 维度 | grok | codex | omp | claude | amp | claw | opencode | hermes | 本仓现状 |
|---|---|---|---|---|---|---|---|---|---|
| 语言/体量 | Rust 84 crates | Rust+TS | Rust ~80k+TS | TS Ink | TS+云 | Rust 10 crates | Bun 19包 521MB | Python 16k文件 1GB | TS 插件 |
| subagent 授权 | 显式 spawn | 明示/AGENTS才发 | role 路由 | 前/后台+resume | medium 裂变 | harness 派工 | description 路由+task | delegate_task | 单 tool，缺门文案 |
| 深度 | 扁平 1 | 线程无硬 cap | worktree | 2（tintinweb） | 黑盒 | - | 父子会话 | facade+loop | worktree+Herdr |
| 权限 | modes+rules+hook+sandbox | 继承快照+只读覆 | LSP MUST+只读/执行 | 模式循环+classifier+hooks+trust | permissions 顺序 | permission_enforcer | allow/ask/deny+glob | pool/fallback | steer三态+watchdog |
| 模型分级 | personas+effort | sol/luna/astra+effort | 9 role(smol fan-out) | Explore继承/Opus封顶 | Dial锁定+pin | 兼容表 | per-agent+temperature+steps | 主/aux分离 | models精确ID |
| TUI 键 | Ctrl+G tasks/◎行 | /agent roll-up | 差分+CSI | 全表 §2.4 | composer steering | HUD计划 | 穿梭Down/Right/Left/Up | interrupt/queue/steer | Fleet s/D/H |
| 记忆 | /memory族 | thread 摘要 | local双阶段+learned | sessions+@跨端 | AGENTS分层+引用 | board/ledger | 隐藏compaction+snapshot | 学习环+FTS+curator | memory文件+progress |
| 远端 | ACP+GROK_CONFIG | - | - | Remote/uds | orbs/runner+sync/ship | container | serve/gateway | gateway25端+ACP | Herdr machine |
| 可学性 | dispatch/effects | 授权门+判例 | skills解剖+预算 | 键表+源语 | URL-first | PARITY/mock | 权限+穿梭 | SQLite+压缩 | - |

---

## 4. 给 pi-subagents-cc 的指导意见（按 VISION 可执行排序）

### P0（本版：Claude 味成型，只动表现）

1. **Fleet 激活**：`src/tui/fleet-status.ts` 加 `onTerminalInput`（抄 tintinweb 门控 `getEditorText()===""`），空 prompt `↓/←` 激活、`↑/↓` 移、`Enter` 进 viewer、`Esc` 回；保留 `Ctrl+Alt+F` 兼容。
2. **Viewer composer + `m`**：`src/tui/fleet.ts` 加 inline composer（`Enter` 开/`Esc`空退，走现有 `steerAsyncRun` ack）+ `m` 三态 + `16KB` cap（数字照抄，附 benchmark）。
3. **`@mention`**：新增 `src/tui/mention.ts`（移植 `handleBase/assignHandle/TRIGGER/@agent-`），`src/extension/index.ts` 包 pi 原补全（文件优先、agent 置顶）。分发：跑中→`steer`、完→`resume`、盘有→重开、未起→`subagent({agent,task})`；裸 handle 回主，`@main` 强制回主。roster 三段排序照搬。
4. **授权门文案**：主 prompt 加 Codex `706-737` 翻译版（明示/AGENTS 才 spawn，“深入”不算；先定关键路径再委托 sidecar；wait 少调；不重做）。
5. **文档**：`docs/claude-parity.md`（Claude 键→本仓动作→不做三列，review 只对表）+ README `@` 示例 + `/subagents-guide parity`。

### P1（下版：密度与手感）

6. **`aboveEditor` widget**（`src/tui/widget.ts`，spinner/activity/`12行`，`config.widget all/background/off` 默认 `background`，只读快照）。
7. **六键**：`Ctrl+O(transcript view:transcript)/Ctrl+B(后台化)/Shift+Tab(模式循环)/Alt+P(models)/Ctrl+R(历史)/Ctrl+S(暂存)`。
8. **模型别名**：大小写不敏感 + `haiku/sonnet/smol/slow/plan` 模糊到已配 provider（tintinweb `model-resolver` + omp role 二合一）。
9. **穿梭键**：`Down/Right/Left/Up` 进首子/循环/回父，并入 Fleet inspect（opencode 语义）。
10. **隐藏 summarizer 落证据**：compaction 写 artifacts + Fleet 条目（含 hash/前后 token，失败闭合）。

### P2（按需，先过 VISION）

11. **`gate:cmd`**（`runs.run{verify}` 跑子 worktree，非零即 `blocked`，省 reviewer token）。
12. **`steps` 预算 + `task` glob**（child 默认 5-10 超限强总结，`deny` 即从 prompt 移除）。
13. **SQLite FTS**（`sessions/messages/fts+lineage`，`session_search` 直查，不经 LLM）。
14. **`/learn` + curator**（`SKILL.md` 规范 + `references/` + `stale14/archive30` + ledger 回滚）。
15. **`pi -ox/sync/ship`**（URL-first + `Pi-Thread-ID` + `.agents/setup+resume`，包 Herdr 现有远端）。
16. **`dispatch/effects` 拆 `render.ts`**（grok 式纯函数+Effect 值化，dispatch 单测无终端）。

### 明确不做

注册 `Agent/get_subagent_result/steer_subagent/SubagentWorkflow` 任一 tool；支持 `agent()/parallel()/pipeline()` 脚本（给 `runs.*` 对照表）；`subagent` 改名 `Agent`；动 mission/receipt/ledger/worktree/Herdr 语义。

---

## 5. 参考学习资料（按顺序读）

1. 入门：本报告 §1 + `docs/research-tui-parity.md` + tintinweb `src/ui/{fleet-list,conversation-viewer,agent-widget,agent-mention}.ts` + `src/mention.ts`。
2. 治理：Codex `developers.openai.com/codex/subagents` + `multi_agents_spec.rs:706-737` + `#29540`（做）vs `#12047`（不做 team）+ claw `PARITY.md + MOCK_PARITY_HARNESS.md + TUI-ENHANCEMENT-PLAN.md`。
3. 架构：grok `app/{actions,dispatch/router,effects}/event_loop.rs` + `16-subagents.md` + `19-plan-mode.md`；opencode `ggprompts Fig2.1/5.1/12.1` + `packages/tui/app.tsx` + `docs/{agents,permissions,keybinds}`；hermes `docs/developer-guide/architecture + agent-loop + session-storage + context-compression` + `run_agent.py→conversation_loop.py`。
4. 远端：Amp `docs/cli/{execute-mode,spawning-orbs} + docs/{orbs,threads,the-dial}`；hermes `gateway/run.py`；grok `15-agent-mode.md(ACP)`。
5. 底座：omp `docs/{natives-architecture,models,lsp-config,skills,memory} + .omp/skills/{semantic-compression,tool-prompt-optimization}/SKILL.md`。
6. 动手：§4 P0 清单 + `test/unit/mention.test.ts + viewer-cap.test.ts + fleet-keys.test.ts`（照搬 tintinweb 用例）。
