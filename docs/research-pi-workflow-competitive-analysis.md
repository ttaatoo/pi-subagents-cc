# Pi subagents / workflow 竞品分析与本项目优化建议

调研日期：2026-09-30。此报告保留修复前的诊断，不是当前缺陷清单。分析基线：`f8d82282fc8a32af43cba8a348592c020247e00e`，manifest 版本 `0.73.1`。本报告只做研究与建议，不修改实现。

## 0. 结论

本项目已经具备委派、脚本编排、后台持久化、监督、验收、worktree 和结果交接能力。当前最值得投入的不是增加另一套 workflow 引擎，而是让 fork 的承诺、输入路由和运行控制与现有执行层一致。

建议定位为：**nicobailon 委派层之上的 Claude Code 风格交互 fork**。Claude 风格指 Fleet、transcript、mention 和键盘交互，不表示注册 Claude Code 同名工具。[vision]、[fork]

本次优先发现：

1. 同名 child 的 mention handle 会在状态变化后交换目标，已用本地代码复现。
2. README 宣称提供 `Agent/get_subagent_result/steer_subagent` 调用约定，但 fork 契约明确不注册这些工具。
3. fork 文档宣称独立 package、bin 和安装目录，实际 manifest、installer、构建发布入口仍使用上游身份。
4. mention 已产生执行副作用后发生异常，输入 handler 仍会把原请求交给主模型。不能证明这样不会重复执行。
5. 裸 `@` 在有 agent 候选时覆盖文件补全，与 provider 注释及旧调研中的“文件优先”承诺不一致。
6. 声明的上游同步点之后有 25 个提交，包含依赖安全、project trust、用户停止、reload 工作保留和性能修复。应先审查这些修复，而不是先移植竞品功能。

优先级中的 P0 表示“进一步对外宣传或发布前应解决”，不是漏洞严重度评级。

## 1. 方法与证据范围

- 使用 GitHub 第一方 API、项目 README、源码、提交和安全公告。不用第三方榜单代替能力证据。
- 用户写的 `tintinbweb/pi-subagents` 在本次查询中返回 404；实际对比的是 [`tintinweb/pi-subagents`][tintin]。
- 星数是 2026-09-30 查询快照，只表示关注度，不代表活跃用户、可靠性、市场份额或性能。
- 两套主要实现已克隆；其他扩展阅读第一方文档，并抽查主要 workflow 的源码。**没有安装并完整运行所有竞品，也没有做统一性能或任务成功率 benchmark。**
- 本地测试与直接复现单独列出。源码存在、README 宣称、测试通过和真实运行通过是不同证据级别。
- 按 `VISION.md` 判断建议：一个 operator、一个 parent、一个 delegation layer；先组合现有 primitives；完成需要证据；无法证明则 fail closed；热路径成本需要测量。[vision]

主要快照：

| 项目 | 查询星数 | 分析快照 | 最近提交日期 |
|---|---:|---|---|
| `nicobailon/pi-subagents` | 3,789 | `964481f4ea` / main | 2026-09-30 |
| `tintinweb/pi-subagents` | 1,231 | `e955e29c51` / master | 2026-09-03 |
| `ttaatoo/pi-subagents-cc` | 0 | 本地 `f8d82282fc` | 本地作为分析基线 |

三者 GitHub API 的 `fork` 均为 false。本项目的源码来源关系来自 `FORK.md`，不能把没有 GitHub fork-network 关系理解成没有上游来源。[fork]

本地 fork 原始基线为上游 `a859d1de` / `0.70.1`；声明的最新同步点为 `8dc90dca`。相对这个同步点，本地改动涉及 25 个文件，主要在 mention、Fleet、transcript、渲染、测试和文档。`package.json` 与 `install.mjs` 相对同步点没有差异。上游后续比较另见第 5 节。[fork]、[upstream-compare]

## 2. 三个主要项目的区别

| 维度 | nicobailon 上游 | tintinweb | 本项目 |
|---|---|---|---|
| 核心定位 | Pi 委派、监督、编排与证据交接 | Claude Code 风格 autonomous subagents 与 workflow | 上游执行能力，加 Claude 风格表现层 |
| 模型侧入口 | 激活后 `subagent`；fresh parent 用 `subagents_enable` | `Agent`、`get_subagent_result`、`steer_subagent` 等 | 实装保留 nicobailon 入口，不注册 tintinweb 同名工具 |
| 编排形状 | `workflowScript` + `runs.run/all/lanes/steer` | `SubagentWorkflow` + `agent/parallel/pipeline` | 保留 `runs.*`，不应增加第二种 DSL |
| 运行生命周期 | foreground SDK child、detached runner、状态/控制/恢复、监督与验收 | manager/session、后台池、工作流与持久 session 重开 | 继承上游；新增 mention 复用已有 executor 和控制路径 |
| 交互重点 | Fleet、工作流/嵌套运行与证据可见性 | 点名、Fleet、live conversation、直接 steer | 简化 Fleet、smart Enter/方向键、三态 transcript、mention |
| 最值得借鉴 | 安全和生命周期修复；严格控制与证据契约 | 稳定实例 handle；低噪声可控制界面 | 需要先证明表现层不会改变目标、授权或执行次数 |

来源：[上游 README][nico]、[tintinweb README][tintin]、[本地 fork 契约][fork]、[本地 workflow 文档][local-workflows]。

### 上游优势与本项目的关系

本项目的大部分运行能力来自上游，并不是 fork 独立新增的竞争优势。保留这套执行层可以避免重做 runner、恢复、监督和验收。fork 的价值应落在交互上，而且必须能用回归测试证明这层没有削弱底层控制。

### tintinweb 最值得学的是实例身份，不是工具名字

tintinweb 在创建 record 时分配 handle，把它保存在 record 上；eviction 后用 tombstone 保留 handle，避免另一个 child 抢占原名称。resume 可以 reclaim 原 handle。它没有在每次生成候选列表时按当前状态重新命名。[tintin-manager]

本项目借用了语法和排序，却没有保留这个关键生命周期约束。只照搬 `@scout` 的外观不足以构成可靠 parity。修复时先在已有会话内状态上稳定身份；不能由此推导出必须移植整套 manager 或跨会话 tombstone 存储。

## 3. 其他热门扩展：学什么，不学什么

### 3.1 直接 workflow 竞品

| 项目 | 星数 / 最近提交 | 已核查的方向 | 对本项目的判断 |
|---|---|---|---|
| [Michaelliv/pi-dynamic-workflows][dyn-original] | 1,229 / 2026-05-31 | 单 `workflow` 工具；JS `meta/phase/agent`、fanout、structured output | 学简短作者入口和限制并发；不要再引入它的 DSL |
| [QuintinShaw/pi-dynamic-workflows][dyn-quintin] | 549 / 2026-09-29 | model routing、journaled resume、worktree、成本、`/workflows` TUI、显式 opt-in 的 `/ultracode` | 最值得学能力契约、恢复不重复付费工作、成本与上下文测量；不是默认自动委派的依据 |
| [AgwaB/pi-workflow][agwab] | 361 / 2026-09-29 | named/repeatable research、review、spec/impact review；artifact graph；依赖 `@agwab/pi-subagent` | 学经过验证的任务模板和来源/验收格式；不要把它的 JSON graph/runtime 叠到 `runs.*` 上 |
| [osolmaz/pi-workflows][osolmaz] | 316 / 2026-09-29 | TypeScript graph、JSON control-flow submission、全局 SQLite 状态、独立 live viewer/resource managers | 学副作用未知状态、receipt 与恢复原则；独立 server/engine 超出本项目当前定位 |
| [vekexasia/pi-extensible-workflows][vekexasia] | 236 / 2026-09-28 | deterministic/resumable orchestration、tree/cost/script UI、trajectory、Herdr | 学热路径 benchmark、有限刷新与可检查执行；不应因 UI 相似再增加一套 runtime |

注意语义差异：osolmaz 的交互式 `agent` step 在当前 origin Pi conversation 执行，保留 parent context；它不等于本项目默认的隔离 child 委派模型。resource-manager 的 headless 工作又有单独路径。不能把两者的“支持 agent/workflow”视为相同能力。[osolmaz]

源码核查发现的实用原则：

- **能力声明与文档一致。** QuintinShaw 的 capability descriptor 包括 `support`、`constraints`、`enforcementOwner`、`runtimeBinding` 和 `behaviorEvidence`，并有生成文档的 `--check`。本项目先对 fork 的工具名、安装身份和关键交互常量做小范围一致性检查，不必复制整个能力发布框架。[quintin-contract]、[quintin-doc-check]
- **恢复要有已提交记录。** QuintinShaw 的 run storage 使用 head + append-only log，明确原子提交点、未提交尾部、损坏已提交日志的 fail-closed 行为、轻量 listing 和有界 hydration。它同时说明这是进程崩溃协议，不是所有文件系统上的断电持久性保证。本项目已有持久化，不应未经测量就替换存储格式。[quintin-storage]
- **异常不等于未执行。** osolmaz 的 effect 实现将 apply 抛错记录为 `indeterminate`；恢复先 observe，不能盲目再做。这直接对应本项目 mention 的 post-dispatch fail-open 问题。借鉴状态判断，不必引入 resource-manager server。[osolmaz-effects]
- **先测再优化。** vekexasia 有 foreground update benchmark，记录 updates、传输内容、CPU、I/O 和 progress frame 成本。这比凭观感提高刷新频率更符合本项目愿景。[vekexasia-bench]

也不能把竞品文档直接当成熟度证明：

- Michaelliv 的 `agent`、`parallel`、`pipeline` 在部分失败路径返回 `null` 让脚本处理。模板必须检查失败结果；“脚本可运行”不等于完成证据充分。[dyn-original-runtime]
- osolmaz 的 design philosophy 明确说通用 post-workflow model turn 和 missing-submission reminders 仍需恢复，不宣称已经交付。报告中的产品要求不能误读成当前已实现能力。[osolmaz-design]

### 3.2 相邻 workflow 扩展

| 项目 | 星数 | 可借鉴点 | 范围限制 |
|---|---:|---|---|
| [davebcn87/pi-autoresearch][autoresearch] | 8,135 | 实验 → 测量 → 保留/回退；主指标与副指标 | 学优化方法；不是把无人值守研究循环设成默认 |
| [mitsuhiko/agent-stuff][agent-stuff] | 3,170 | skills/prompts/extensions 的组合；小任务入口 | 其 `subagent` 是 serialized tmux Pi process；不是并发委派引擎的等价替代 |
| [nicobailon/pi-mcp-adapter][mcp-adapter] | 1,566 | 单代理工具、按需发现/启动，减少工具定义上下文 | 先保留现有 activation/guide；不要因少工具名而增加另一层 executor |
| [nicobailon/pi-messenger][messenger] | 712 | 多终端 peers、message/task、file reservation、Crew | peer 协作不同于 parent-child；不应把本项目改成团队任务平台 |
| [nicobailon/pi-interactive-shell][interactive-shell] | 590 | 可观察 PTY、用户接管、dispatch/monitor | 可用于明确授权的 CLI 工作；不能作为 subagent lane 失败后的隐式替代 |
| [tintinweb/pi-tasks][pi-tasks] | 219 | 任务依赖、共享列表和 widget | 如有需求应集成任务事实；不在本项目再建一套任务系统 |

mitsuhiko 的源码明确限制同一时间一个 child，并暴露 task/cwd/provider/model/thinking 的小 interface。它说明“少参数、易理解”有价值，也说明不能拿更窄的运行问题来证明替代本项目会同样简单。[agent-stuff-subagent]

`can1357/oh-my-pi` 本次快照有 33,797 stars，但它是完整 Pi 衍生产品，不是可直接安装的同量级 workflow 扩展。只作交互和 typed result 参考，不列入扩展排名或移植计划。[omp]

## 4. 本项目问题：事实、影响与最小改进

### 4.1 P0：fork 对外契约与安装/发布身份漂移

已证实：

- README 第 11 行宣称 Claude Code 的 `Agent/get_subagent_result/steer_subagent` calling conventions。
- `FORK.md` 与 `docs/claude-parity.md` 明确这些工具以及 `SubagentWorkflow` 永不注册；实现使用 `subagent` 和 `runs.*`。
- `FORK.md` 宣称 package/bin 为 `pi-subagents-cc`、目录为 `subagent-cc`。
- 实际 `package.json` 的 name/bin 是 `pi-subagents`；repository/homepage/bugs 指向 nicobailon。
- 实际 `install.mjs` 克隆 nicobailon，目标是 `~/.pi/agent/extensions/subagent`，`--remove` 会递归删除这个目录，而非文档所说的 `subagent-cc`。
- 源 package 的 `private: true` 是构建约定，不是“不能发布”的证明。`build-package.mjs` 会生成可发布 manifest，并原样复制 name/bin/repository；release workflow 使用 `npm publish ./dist-pkg --provenance`。
- README 的主要文档链接仍指向上游 `main`，不是当前 fork 文档；可能把尚未同步的能力或不同的 Fleet 契约交给用户。

来源：[README][local-readme]、[FORK][fork]、[parity 契约][parity]、[manifest][manifest]、[installer][installer]、[构建脚本][build-package]、[release workflow][release-workflow]。

影响：用户或模型可能调用未注册工具；本地 installer 会安装/更新/移除上游目录；若走发布入口，会尝试以上游 package identity 发布。**没有运行 installer 删除操作，也没有证明发生过错误发布。** Git URL 的 Pi-managed 安装与旧 installer 是不同路径；本发现不表示 README 的 Git 安装命令本身会删除上游目录。

最小改进：先明确只支持 Git 安装还是要发布独立 npm package。若只支持现有 Git 安装，移除或明确禁用不再支持的 installer/publish 入口，避免新增平行安装路径。若保留独立发行，manifest、bin、目录、链接和打包后的 manifest 必须采用同一身份。不要顺手重命名运行协议、工具或所有内部 `pi-subagents` 字符串；公开 import 契约的切换需要明确决定。[vision]

验收：安装/移除在临时 HOME 中执行；不能修改上游目录；打包身份与声明一致；README 示例只能使用当前注册工具；文档链接对应 fork/安装版本。

### 4.2 P0：mention handle 不稳定，状态变化会换目标

根因：`buildMentionRoster` 每次先处理 live，再处理 resumable，从空的 `taken` 集合重新分配 handle。两端“同一时刻用同一算法”不能保证补全后到提交前仍是同一个目标。[mention-core]、[mention-provider]

直接复现：

```text
两个 scout 都在运行：  @scout → A    @scout-2 → B
A 完成、B 仍运行：     @scout → B    @scout-2 → A
```

最小复现可在仓库根目录运行，不启动 child：

```bash
node --experimental-strip-types --input-type=module <<'JS'
import { buildMentionRoster } from './src/tui/mention.ts';
const A = { runId: 'A', asyncDir: '/tmp/A', agent: 'scout', state: 'running' };
const B = { runId: 'B', asyncDir: '/tmp/B', agent: 'scout', state: 'running' };
const view = rows => rows.map(x => `${x.handle} -> ${x.entry.runId}`);
console.log(view(buildMentionRoster([A, B])));
console.log(view(buildMentionRoster([B], [{ ...A, state: 'complete' }])));
JS
```

最小改进：在现有 session 状态中将 handle 绑定到运行/child 身份，而不是绑定到本次排序位置。排序只影响显示，不影响地址。需要显式决定终态保留和名称释放规则；已失效的名称不能悄悄指向另一个运行。tintinweb 的 record/tombstone 是参考，不是要求移植其执行系统。[tintin-manager]

验收：两个同名 child 经 complete/failed/paused、插入新 child、列表重排和补全后状态变化，原 handle 不会发给另一个 child。路由和补全都跨同一稳定身份 seam。

### 4.3 P0：dispatch 异常后的 fail-open 不能保证不重复执行

`executeMentionRoute` 先执行 steer/resume/spawn，再 notify。外层 `input` handler 对所有异常返回 `undefined`，把请求交给主模型，且 warning 明说要这么做。[mention-input]、[mention-wiring]

本次用 stub 复现：spawn 被执行一次并返回 runId，随后 notify 抛异常，异常向外传播。源码表明 handler 的 catch 会继续主模型处理；没有实际启动第二个模型任务，因此“真实重复 child”是风险，不是已观测事实。如果 notify 本身持续抛错，catch 中的通知也可能失败，这同样不是可靠的 handled 结果。

另外，任何 `steer` 的 `isError` 都会尝试 resume，不仅是已确认的完成竞态；文案却统一说 `finished mid-send`。权限拒绝、错误 index 或不可控制目标不应被误报成已完成后续跑。[mention-input]

最小改进：区分执行前拒绝、执行已接受/已发生、结果未知和真正的 terminal race。已发生或未知副作用不能静默重放给主模型；UI 通知失败不能改变执行归属。仅在底层明确证明可以 resume 时做同协议恢复，不新建泛化重试框架。[vision]、[osolmaz-effects]

验收：模拟 spawn 成功后通知报错、steer 已接受后异常、权限拒绝和终态竞态；每条输入最多产生一次逻辑委派，未知结果保留 run/status 并显示 blocker，不转为新的执行路径。

### 4.4 P1：文件补全被覆盖，动作候选与真实能力不完全一致

已证实的代码行为：

- `MENTION_TRIGGER` 接受空 token，provider 在有 roster 时直接返回 agent rows，不调用原 provider。本次对裸 `@` 的 stub file provider 调用数为 0，原有文件候选被替换。`@src/foo.ts` 等明确路径会回退，但这不等于裸 `@` 文件优先。
- `stopped` 被列为 resumable；`async-resume.ts` 明确拒绝 stopped run。
- type 分支可生成 `@main` 候选，但输入 `@main message` 是发给主模型，不会 spawn 该 type。
- live roster 只读取 `asyncJobs`，不读取 `foregroundControls`；对多 step job 总取第一 step 的 label/index。不是所有 Fleet 可见 child 都能由这个 roster 正确表示。

来源：[mention 语法][mention-core]、[provider][mention-provider]、[resume 权威检查][async-resume]。

这些发现中，裸 `@` 覆盖、stopped 候选和 reserved type 已直接复现；foreground/multi-step 是代码层的覆盖限制，未完整跑真实执行路径，不将其报告成已复现的误投递。

最小改进：明确 file 与 agent 候选的合并/优先策略；reserved handle 不成为可启动候选；只展示已有执行路径真实支持的动作。workflow root 不应假装是第一个 child；不能表达精确 child 时就不提供快捷控制。所有 eligibility 检查复用权威规则，不在每次补全时扫描磁盘，也不为追求全面 parity 新建 runner。

验收：裸 `@`、文件名与 agent 名相同、路径、`@main`、stopped、foreground、multi-step 和 workflow-root 均有明确候选及路由契约。

### 4.5 P1：简化 Fleet 后需要补上可见性证明

fork 删除了 inline workflow coverage、workflow/project-pane rows 与 nested expansion，选择让 inspector 承担更多细节。相对同步点，还删除了 `test/integration/inline-workflow-visibility.test.ts`。这是契约调整，不足以单凭删除文件判定运行被隐藏。[fork]

但 `VISION.md` 要求后台工作不能消失。应有新契约的替代证明：并发 workflow、nested child、需要监督的 child、completed/failed/paused/stopped、超过 5 行溢出时，operator 仍能从可见入口准确定位、inspect，并在 runner 支持时 steer/stop。

目前 parity 表写 `MAX_AGENT_ROWS 6`，实装为 5；刷新实装为 500 ms。不要为了模仿竞品的 200 ms 而直接提高频率，应先测成本。[parity]、[fleet-status]

最小改进：补充适合当前简化设计的可见性和控制测试，不恢复已删除 UI 来满足旧断言，不把“Claude parity ✅”当实际 gate。检查新交互不会同时被旧 async widget 和 Fleet 重复显示。

### 4.6 P1/P2：复杂度集中，但不是重写理由

本地 `src` 有 298 个 TypeScript 文件、102,636 行，包含注释和空行。`runs` 占 54,719 行。较大的文件包括：

- `src/runs/foreground/subagent-executor.ts`：7,865 行。
- `src/runs/background/subagent-runner.ts`：5,156 行。
- `src/tui/render.ts`：3,679 行。

这些数字说明审查和验证范围集中，不证明“架构差”或模块 depth 低。关键是一个行为变更是否迫使调用方理解多套状态、授权、恢复和控制约束。

当前最明确的 deepening 候选是现有 mention cluster：让稳定身份、可执行动作、候选和路由在同一 module 内集中；调用方提供已有状态与动作，不各自重建 eligibility。随后再根据真实重复逻辑选择 executor/runner 的小范围 seam。不要先拆出通用 registry、planner、workflow engine 或一堆 pass-through 文件。

原始 `SubagentParams` 有 82 个顶层属性，JSON 序列化约 12,997 字符。这不是实际模型 token 计数，也不是 fresh parent 的启动成本。项目已经有 `subagents_enable`、split/compact/custom description 和按需 `guide`；这些是现成优势，不能再包装一层代理工具来重复解决。[schemas]、[local-readme]、[local-config]

最小改进：先量化激活前/后整个工具定义及 prompt metadata 的 token 成本、schema 理解错误率，再判断是否需要裁剪。已有 config 一次操作能满足的需求不新增功能。

## 5. 上游差距：优先筛修复，而不是一口气合并所有能力

上游从 `8dc90dca` 到调研快照 `964481f4ea` 有 25 个提交，涉及 85 个文件。以下是精选项；不是全部都应立即移植，也没有验证 cherry-pick 可以无冲突应用。[upstream-compare]

| 顺序 | 上游提交 | 内容与本项目意义 |
|---|---|---|
| 安全维护 | [`f7732d6b`][fix-undici] | `undici` 更新至 8.10.2，处理 GHSA-3wwx-pv8p-q78v |
| 授权/隔离 | [`b2718fb8`][fix-trust] | child 遵循 parent project trust |
| 授权/隔离 | [`4cd43cae`][fix-skills] | `inheritSkills: false` 不再留下 extension skills |
| 生命周期 | [`2bddf29b`][fix-user-stop] | 用户停止 async workflow 时停止其 children |
| 生命周期 | [`4416738f`][fix-reload] | reload-stopped workflow 保留已有工作，relaunch 可以复用 |
| 状态真实性 | [`30f73a37`][fix-async-siblings]、[`0a24a215`][fix-foreground-siblings] | sibling 因 workflow 失败被停时报告 stopped，不误报失败类型 |
| 性能 | [`08192e4b`][perf-startup] | diff baseline 不阻塞 session startup |
| 性能 | [`a4e5a76a`][perf-retention]、[`4ad89060`][perf-polling] | Windows process-start probe 与 idle channel polling 改善 |
| schema/UI | [`082c4378`][fix-schema]、[`9a5a2d5e`][fix-lanes]、[`7e07a22d`][fix-agent-count]、[`964481f4`][fix-revived] | JSON pattern、lane 显示、leaf-agent 计数、revived child 的 latest-run 状态 |
| 可选能力 | [`60905d10`][feat-disable] | 关闭不用的 features；值得评估体积/上下文收益，但涉及 schema/配置契约 |
| 生态适配 | [`14dcf975`][feat-mcp]、[`8f90bf1b`][feat-codemode] | Pi 内建 MCP/codemode；仅在目标 host 和真实需求支持时采用 |

### 依赖安全结论的范围

本项目直接依赖和 lockfile 为 `undici 8.10.0`，在公告的 8.x 受影响范围 `>=8.1.0, <8.10.2` 内。公告严重度 medium，CVSS 5.9，描述 WebSocket permessage-deflate 错误导致整个 Node 进程崩溃；8.x 修复版本是 8.10.2。[manifest]、[undici-advisory]

`runner-http-dispatcher.ts` 明确 require 直接依赖并调用 `setGlobalDispatcher()` / `install()`。host SDK 的嵌套 `undici 8.10.2` 不会自动替换这个直接依赖。[http-dispatcher]

**已证明版本受影响，未证明本项目能被诱导连接攻击者 WebSocket，未做 exploit。** 修复应更新 manifest 与 lockfile，并跑 dispatcher、runner 和相关网络回归，而不是宣称已经发现远程可利用的高危漏洞。

### project trust 不能用 SDK 默认值代替 parent 决策

当前 child factory 调用 `SettingsManager.create(launch.cwd, agentDir)`，未显式带 parent project trust；上游新版本增加 launch 字段并传入 `{ projectTrusted }`。这是源码确认的传递差距，具体 host/version 下哪些项目资源会被加载仍需要独立 gate。[child-session]、[fix-trust]

Pi 的 project trust 控制资源加载，不是 OS sandbox。worktree 也只是 Git 工作隔离，不限制 host 文件、进程、凭证或网络权限。不能用 UI 的“隔离”标签掩盖这个事实。[pi-security]、[local-extension-api]

建议把 trust、skills、stop/reload 的回归矩阵作为同步门槛。每个修复证明一条 invariant；跨 launch/public interface/persistence/lifecycle 的范围先取得 owner 审批，不能借“同步上游”顺手扩大 fork 的产品范围。[vision]

## 6. 可以优化的方向：先用已有能力

| 方向 | 已有路径 | 还值得做的最小工作 | 不应追加 |
|---|---|---|---|
| 更好用的 review/research | builtin agents、prompt shortcuts、`/review-loop`、`workflowScriptPath`、`args`、named resources | 核验现有示例可运行；把常用入口与完成证据放在一起；减少用户跳转到上游最新版文档 | 新 `/workflow` 系统或重新实现 graph DSL |
| 模型分级与成本 | agent model/thinking 配置、models guide、已有 spawn/tool budget | 在现有运行证据里呈现真实费用/使用量，明确预算是硬上限还是估计；先测现有选择 | 模型按任务复杂度擅自启用委派、隐藏 rerouting |
| 恢复与失败交接 | status、resume、持久 session、receipts、workflow keys | 优先同步 reload/stop 修复；证明已验收工作不重复跑，未知副作用不重放 | 无证据“auto-heal”、失败自动换 interactive shell/外部 CLI |
| 更少状态噪音 | Fleet、mainWindowRenderer、transcript result cap | 证明状态变更不丢、详情可达、无变化少刷新；用已有 config 控制显示 | 又加一个 dashboard 或提高刷新频率却不量化成本 |
| 外部 agent 兼容 | `external-runs`、`external-job-provider` 等已有 interface | 每种 adapter 明确 stream/steer/stop/resume/context/structured-output 能力，并验证拒绝路径 | 假装外部 CLI 是 native Pi child；失败时偷偷降级另一 runner |
| 性能与 token | lazy activation、compact description、按需 guide、已有缓存和有界渲染 | 固定场景测量 cold/warm launch、status、render、scan、工具上下文；记录回归 | 先换数据库、语言或重写执行架构 |

性能场景至少包含：无 child、多个 active child、大量 terminal history、长 transcript、并发 workflow/nested child。记录 p50/p95、CPU/刷新次数、文件读取与渲染工作量，以及激活前/后的实际 token footprint；先建立本机基线，再由 owner 决定预算，不在本报告伪造阈值。pi-autoresearch 的主指标/副指标/保留或回退方法可以用于这些实验，不需要把它嵌进运行引擎。[autoresearch]、[vekexasia-bench]

## 7. 建议的实施顺序与停止条件

这不是已授权实施清单。建议拆成小 PR，每个只证明一个明确契约。

| 阶段 | 优先事项 | 完成证据与停止条件 |
|---|---|---|
| P0-A | 对外工具、安装和发布契约 | README/FORK/manifest/发行方式一致；临时 HOME 无上游目录变更；不新增安装路径 |
| P0-B | 稳定 mention identity | 同名 child 状态变化和候选到提交竞态不误投递；保留/释放规则明确 |
| P0-C | mention 的执行归属与异常 | post-dispatch 异常不回主模型重放；权限拒绝不误报 completed race；未知状态有 evidence/blocker |
| P1-A | 上游安全、trust、skills、stop/reload 修复 | 每条修复跑对应 launch 与恢复 gate；不夹带 MCP/新 workflow engine；undici 版本不在公告范围 |
| P1-B | 候选真实能力与 Fleet 可见性 | files/reserved/stopped/foreground/multi-child/workflow 契约明确；后台/嵌套 work 有 inspect/control 入口 |
| P2-A | 性能/上下文与窄 module deepening | 对比基线无未经批准的 hot-path 回归；改动集中在真实 seam；不扩大公开 interface |

测试失败和环境差异应先分类，再判断该同步或修复是否可以合入。不能以 focused UI 单测通过替代全部生命周期 gate，也不能以一次 demo 替代 adapter 的能力契约。

## 8. 不建议做的事

1. 注册 `Agent/get_subagent_result/steer_subagent/SubagentWorkflow` 作为第二套工具入口，或支持 `agent/parallel/pipeline` 作为第二种 DSL。现有 fork 已明确拒绝这些执行层兼容。[fork]、[parity]
2. 把项目变成通用任务、issue、CI/merge/release 管理平台。它可以向这些系统交证据，不接管其策略。[vision]
3. 默认每次 edit 都开 reviewer，或因为“任务复杂”就自动扩张委派授权。现有 prompt/project instructions 能显式要求 review。[vision]、[local-readme]
4. 把 peer messaging、独立 server、SQLite resource managers、tmux child 和 native child 叠成多个调度层。
5. subagent lane 失败后自动换 `interactive_shell`、外部 agent 或 CLI。现有协议明确需要授权；应先保留错误、状态和 partial diff。[local-workflows]
6. 以功能数、stars、代码行数或动画刷新速度作为可靠性的代理指标。

已有 `docs/research-tui-parity.md` 是 2026-09-23 / `a859d1de` 基线的历史研究。其中“缺 mention”等判断已不代表当前实装，“可整体搬运”等建议也不能替代当前愿景下的范围审批。建议后续给旧报告增加历史状态提示，而不是继续按旧缺口排 backlog。[old-research]

## 9. 本次验证与限制

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 600 秒后超时；日志存在失败；没有完整通过结论 |
| 首轮 focused 测试 | 107 项，106 通过、1 失败；tool-description 注册 subprocess 收到 SIGKILL；整次调用达到 300 秒超时 |
| 单独重跑 mention/Fleet 核心四文件 | 94/94 通过，约 18.9 秒 |
| 同名 handle 生命周期 | 直接调用生产 helper，确认状态变化后交换目标 |
| 裸 `@` 文件补全 | 生产 provider + stub file provider，确认被覆盖且原 provider 未调用 |
| post-spawn 通知异常 | 生产执行 helper + stub actions，确认副作用之后异常传播；真实重复委派未执行 |
| installer / publish / exploit | 未执行破坏性操作、未发布、未做漏洞利用 |
| 所有竞品统一实测 | 未进行；能力与性能不按 README 作通过判定 |

本机为 macOS / Node `v25.0.0`；主要 CI 使用 Node 24。完整单测日志包含 advertised-agent startup、npm timeout、Herdr RPC/pane contracts 等失败。这些现象可能涉及 host、资源竞争或运行时差异；本次未逐个完成根因诊断，不能把 timeout/SIGKILL 全部归为产品 bug。parity 单测通过也没有覆盖本次所有生命周期反例。

本次调查日志与第一方资料暂存于 `/tmp/pi-workflow-analysis/`，typecheck/unit 日志为 `/tmp/pi-subagents-cc-analysis-{typecheck,unit}.log`。关键复现结果见 `mention-reproduction.json`、`mention-failure-reproduction.json`；此临时目录不是长期交付物，本报告保留结论、最小重现和源码引用。

## 10. 第一方来源

以下源码/README 尽量固定到调查 commit。GitHub 元数据和安全公告会更新，星数以第 1 节快照为准。本地链接对应本报告开头的 HEAD。

- 本地政策与契约：[VISION][vision]、[FORK][fork]、[README][local-readme]、[parity][parity]、[workflow][local-workflows]、[configuration][local-config]、[extension interface][local-extension-api]、[旧 TUI 研究][old-research]。
- 本地执行证据：[manifest][manifest]、[installer][installer]、[build][build-package]、[release][release-workflow]、[mention core][mention-core]、[mention provider][mention-provider]、[mention execution][mention-input]、[mention wiring][mention-wiring]、[resume][async-resume]、[Fleet][fleet-status]、[schema][schemas]、[child session][child-session]、[HTTP dispatcher][http-dispatcher]。
- 主要竞品：[nicobailon][nico]、[tintinweb][tintin]、[tintinweb manager][tintin-manager]、[上游 compare][upstream-compare]。
- workflow：[Michaelliv][dyn-original]、[QuintinShaw][dyn-quintin]、[AgwaB][agwab]、[osolmaz][osolmaz]、[vekexasia][vekexasia]；对应源码核查链接在第 3 节。
- 相邻扩展：[autoresearch][autoresearch]、[agent-stuff][agent-stuff]、[MCP adapter][mcp-adapter]、[messenger][messenger]、[interactive shell][interactive-shell]、[pi-tasks][pi-tasks]、[omp][omp]。
- 安全：[undici advisory][undici-advisory]、[官方 Pi security][pi-security]。Pi 文档同时参照本机官方 coding-agent 安装内容；host 能力应按具体版本验证。
- 元数据获取方式：GitHub REST `GET /repos/{owner}/{repo}` 与 `GET /repos/{owner}/{repo}/commits?per_page=1`；源码通过固定 commit 的 contents/tree API 与 clone 查询。

[vision]: ../VISION.md
[fork]: ../FORK.md
[local-readme]: ../README.md
[parity]: claude-parity.md
[manifest]: ../package.json
[installer]: https://github.com/ttaatoo/pi-subagents-cc/blob/f8d82282fc8a32af43cba8a348592c020247e00e/install.mjs
[build-package]: ../scripts/build-package.mjs
[release-workflow]: https://github.com/ttaatoo/pi-subagents-cc/blob/f8d82282fc8a32af43cba8a348592c020247e00e/.github/workflows/release.yml
[local-workflows]: workflows.md
[local-config]: configuration.md
[local-extension-api]: extension-api.md
[old-research]: research-tui-parity.md
[mention-core]: ../src/tui/mention.ts
[mention-provider]: ../src/extension/mention-provider.ts
[mention-input]: ../src/extension/mention-input.ts
[mention-wiring]: https://github.com/ttaatoo/pi-subagents-cc/blob/f8d82282fc8a32af43cba8a348592c020247e00e/src/extension/index.ts#L894-L945
[async-resume]: ../src/runs/background/async-resume.ts
[fleet-status]: ../src/tui/fleet-status.ts
[schemas]: ../src/extension/schemas.ts
[child-session]: ../src/runs/shared/child-session.ts
[http-dispatcher]: ../src/runs/background/runner-http-dispatcher.ts
[nico]: https://github.com/nicobailon/pi-subagents/blob/964481f4ea5fac2cb8dceaa7ce60547d6c6ffd60/README.md
[tintin]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md
[tintin-manager]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L500-L520
[upstream-compare]: https://github.com/nicobailon/pi-subagents/compare/8dc90dca...964481f4ea5fac2cb8dceaa7ce60547d6c6ffd60
[dyn-original]: https://github.com/Michaelliv/pi-dynamic-workflows/blob/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2/README.md
[dyn-original-runtime]: https://github.com/Michaelliv/pi-dynamic-workflows/blob/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2/src/workflow.ts#L63-L224
[dyn-quintin]: https://github.com/QuintinShaw/pi-dynamic-workflows/blob/3bea96cbbec3328f7579d821a23c060835d268f6/README.md
[quintin-contract]: https://github.com/QuintinShaw/pi-dynamic-workflows/blob/3bea96cbbec3328f7579d821a23c060835d268f6/src/workflow-capability-contract.ts
[quintin-doc-check]: https://github.com/QuintinShaw/pi-dynamic-workflows/blob/3bea96cbbec3328f7579d821a23c060835d268f6/scripts/generate-workflow-capabilities.ts
[quintin-storage]: https://github.com/QuintinShaw/pi-dynamic-workflows/blob/3bea96cbbec3328f7579d821a23c060835d268f6/docs/run-storage.md
[agwab]: https://github.com/AgwaB/pi-workflow/blob/63f94a5d8c790b61f334aa8ab5fb8fb38048c420/README.md
[osolmaz]: https://github.com/osolmaz/pi-workflows/blob/3c55da012998465618282459cb17c676785d3b3e/README.md
[osolmaz-effects]: https://github.com/osolmaz/pi-workflows/blob/3c55da012998465618282459cb17c676785d3b3e/src/resource-managers/effects.ts
[osolmaz-design]: https://github.com/osolmaz/pi-workflows/blob/3c55da012998465618282459cb17c676785d3b3e/docs/DESIGN_PHILOSOPHY.md
[vekexasia]: https://github.com/vekexasia/pi-extensible-workflows/blob/22aaed553f59ca3b38038fecf0f00e1b50583ebc/README.md
[vekexasia-bench]: https://github.com/vekexasia/pi-extensible-workflows/blob/22aaed553f59ca3b38038fecf0f00e1b50583ebc/packages/core/bench/foreground-update.mjs
[autoresearch]: https://github.com/davebcn87/pi-autoresearch/blob/939ede8220daad440eac6bb7b6e315cc283e0a64/README.md
[agent-stuff]: https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/README.md
[agent-stuff-subagent]: https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/subagent.ts#L438-L481
[mcp-adapter]: https://github.com/nicobailon/pi-mcp-adapter/blob/b8ed5a02cf5c8fa9263ef1901c57fdd5f531b3be/README.md
[messenger]: https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/README.md
[interactive-shell]: https://github.com/nicobailon/pi-interactive-shell/blob/77df9a8142a2f731635a4c5a01d68feecb5cced4/README.md
[pi-tasks]: https://github.com/tintinweb/pi-tasks/blob/29180d72498bdd77d5601dc77a9093d25da42102/README.md
[omp]: https://github.com/can1357/oh-my-pi/blob/2b023d1b80133c523d66412602d99b5427408395/README.md
[undici-advisory]: https://github.com/advisories/GHSA-3wwx-pv8p-q78v
[pi-security]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
[fix-undici]: https://github.com/nicobailon/pi-subagents/commit/f7732d6b
[fix-trust]: https://github.com/nicobailon/pi-subagents/commit/b2718fb8
[fix-skills]: https://github.com/nicobailon/pi-subagents/commit/4cd43cae
[fix-user-stop]: https://github.com/nicobailon/pi-subagents/commit/2bddf29b
[fix-reload]: https://github.com/nicobailon/pi-subagents/commit/4416738f
[fix-async-siblings]: https://github.com/nicobailon/pi-subagents/commit/30f73a37
[fix-foreground-siblings]: https://github.com/nicobailon/pi-subagents/commit/0a24a215
[perf-startup]: https://github.com/nicobailon/pi-subagents/commit/08192e4b
[perf-retention]: https://github.com/nicobailon/pi-subagents/commit/a4e5a76a
[perf-polling]: https://github.com/nicobailon/pi-subagents/commit/4ad89060
[fix-schema]: https://github.com/nicobailon/pi-subagents/commit/082c4378
[fix-lanes]: https://github.com/nicobailon/pi-subagents/commit/9a5a2d5e
[fix-agent-count]: https://github.com/nicobailon/pi-subagents/commit/7e07a22d
[fix-revived]: https://github.com/nicobailon/pi-subagents/commit/964481f4
[feat-disable]: https://github.com/nicobailon/pi-subagents/commit/60905d10
[feat-mcp]: https://github.com/nicobailon/pi-subagents/commit/14dcf975
[feat-codemode]: https://github.com/nicobailon/pi-subagents/commit/8f90bf1b
