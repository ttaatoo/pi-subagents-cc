# Claude Code parity（P0）

> 本表是 review 唯一口径：Claude 键/文案 → 本仓动作 → 缺口。每条要么 1:1，要么显式声明不做。执行层（`Agent/get_subagent_result/steer_subagent/SubagentWorkflow + agent()/parallel()/pipeline()`）永不注册——兼容只发生在表现层，见 `VISION.md`。
> 对照源：Claude Code `interactive-mode/keybindings`（v2.1.2xx）、tintinweb `fleet-list/conversation-viewer/agent-widget/agent-mention`。

## Fleet（常驻行 → 列表）

| Claude / tintinweb | 本仓 | 状态 |
|---|---|---|
| 空 prompt `↓`/`←` 激活列表 | `src/tui/fleet-status.ts handleKey`：`down/left/right` + 空编辑器激活 | ✅ P0：`right` 为新增（tintinweb 只有 `↓/←`） |
| `↑/↓`（`j/k`）移动，顶部 `↑` 退回 prompt | 同上；`selectedKey/main` + `deactivate()` | ✅ 1:1 |
| `→`/`Enter` 进入选中（viewer），`main` 回 prompt | 同上 `openSelectedInspector`；`main` 上 `→/Enter` = deactivate | ✅ P0：`→` 进入为新增 |
| `←`/`Esc` 返回 prompt | `escape/left → deactivate()`，`inspectorOpen` 时不截键 | ✅ P0：`←` 退出为新增 |
| 行式 `11s` / `↓13.1k tokens`，`MAX 5行 + ↓N more`，`TICK 200ms`，完成滞留 4s | `MAX_AGENT_ROWS 6`、`REFRESH_MS 500ms`、整数秒 + `↓ compact tokens` | ➖ 故意差异：行数/节流沿用本仓既有值，不改 |
| 空闲提示 `↓/← to inspect` | `↓/←/→ to inspect`；激活态 `↑↓/jk select · →/enter inspect · ←/esc back` | ✅ |

## Inspector（Fleet lobby → 对话）

| Claude / tintinweb | 本仓 | 状态 |
|---|---|---|
| viewer 内 `Enter` 开 composer 直接 steer（空提交/`Esc`/`←` 退，`Tab` 切 mode） | `src/tui/fleet.ts`：`isSmartEnter`（`return/\r/\n/right`）→ 可 steer 则开 `steerDraft`（`Enter` 发/`Tab` 切 `steer/follow_up/auto`/`Esc` 消），否则走 inspect | ✅ P0；被调用方重绑 `Enter`（如 `stop:["return"]`）时让路，不抢键 |
| viewer `x` stop、`m` 切 markdown（`off/raw→assistant/md→all/md+`） | stop 仍是 `D`（+确认）；`m` 三态：`off` 全原文，`assistant`（默认，沿用既有渲染），`all` 另渲染 user/tool 输出；`m` 被重绑时让路 | ✅ P0；stop 键位不变（既有契约） |
| 单结果 16KB cap + chrome 级 elide 提示（不污染 fence） | `src/tui/fleet-transcript.ts RESULT_MAX_CHARS`：assistant/user/展开态 tool 输出截断 + `… N chars elided · m to change view` 行 | ✅ P0；解析层 64KB 上限不动，inspector 64KB 文件尾不动 |
| 外部 inspector（Herdr pane） | `H`（默认 `inspect: ["H"]`，原 `["return","H"]` 硬切）+ 可配 `fleetKeybindings` | ⚠️ 行为变更：`Enter` 不再直开外部 inspector，见下“不做/变更” |
| `s` 开 steer（兼容旧手势） | 保留：`s` 与 `Enter/→` 同入口 | ✅ |

## `@mention`

| Claude / tintinweb | 本仓 | 状态 |
|---|---|---|
| `@` 补全（文件优先本仓既有；agent 附加，agents 置顶） | `src/extension/mention-provider.ts`：`MENTION_TRIGGER /(^|[\s。、？！])@([\w-]*)$/`；命中 handle 才出 agent 行（`@handle` + 状态/描述），否则原样走文件补全；`applyCompletion` 透传 | ✅ P0；与 tintinweb 的差异：命中时只出 agent 行（前缀 span 不一致时不硬拼文件行），见下 |
| 发送语法：句首 `@handle + 非空消息`；裸 handle 回主模型；`@main` 回主；`@agent-` 手打前缀 | `src/tui/mention.ts`：`parseMentionSend`（空白消息不算发送）、`isReservedHandle`、`stripAgentPrefix`、`handleBase/assignHandle`（碰撞 `name-2`） | ✅ P0 |
| roster：live（可 steer 优先）→ resumable（终态续跑）→ 可新建 | live（本 session running/queued）→ resumable（本 session 非 workflow 终态）→ 可启动 types；三段同一 `buildMentionRoster`，补全与路由永不分歧 | ✅ |
| 消息直达 agent、不进主对话 | ✅ 直达：`pi.on("input")` 拦截句首 `@handle message`（`src/extension/mention-input.ts` 纯路由 + `index.ts` 接线）：live→steer、resumable→resume、type→spawn（async），一行 notify；steer 撞完成竞态则同消息 resume 一次。回退：裸 handle/`@main`（transform 去前缀）/未知 handle/带图/extension 来源回主模型；执行抛异常 fail-open 回模型，action 拒绝 fail-closed（handled+通知）。CLI 注意：`pi -p` 里 `@` 开头的 positional 会被当文件，走 stdin 送 `@handle message`。真机验证：后台 scout + `@scout` resume 续跑已通（live-steer 尚未在真机命中，单测覆盖发送/回退） | ✅ |

## 授权门

| Codex | 本仓 | 状态 |
|---|---|---|
| `multi_agents_spec:706`：无明示不 spawn；“深入/彻底”不算授权；先定关键路径本地做，只委托有界 sidecar；wait 少调；不重做 | `src/extension/tool-description.ts` 首条 safety bullet 已追加同义段 | ✅ P0（加法，不动既有契约行） |

## 明确不做 / 行为变更（P0）

1. 不注册 `Agent/get_subagent_result/steer_subagent/SubagentWorkflow`；不支持 `agent()/parallel()/pipeline()` 脚本（对照：`agent→runs.run`、`parallel→runs.all`、`pipeline→runs.lanes`、`steer→runs.steer`）。
2. `inspect` 默认键从 `["return","H"]` 硬切为 `["H"]`；`Enter/→` 改为 smart-enter（live 则 steer，否则 inspect）。用户 `fleetKeybindings` 可改回，`Enter` 被重绑到他键时 smart-enter 让路。
3. `@` 命中 agent 时暂不出文件行（tintinweb 为合并+agents 置顶）；裸 `@` 逛文件不受影响。
4. 以下仍缺（P1）：`Ctrl+O` 全文 transcript、`Shift+Tab` 权限循环、`Alt+P` 换模型、`aboveEditor` widget、磁盘 tombstone 重开、模型别名。`Ctrl+B` 后台化已有现成路径，不在缺口内：配 `{ "foregroundDetachShortcut": "ctrl+b" }` 即 `registerShortcut`→`detachForegroundRun`→executor detach（另有 `/subagents-detach` 同入口，见 `docs/configuration.md`）；默认不开是有意为之，不抢 Pi 的 `cursor-left` 键。
