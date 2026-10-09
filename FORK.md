# Fork notes — pi-subagents-cc

Independent fork (omp-style: **not** created via GitHub's fork button, no upstream fork network link), maintained by [ttaatoo](https://github.com/ttaatoo).

## Credits

- Base / upstream: [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) by Nico Bailon (MIT). All core delegation, workflow orchestration, supervision, and observability work belongs there.
- Claude Code style: [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT) — FleetView, conversation-viewer, agent mentions, and keyboard interaction. This fork does not adopt its tool names or workflow DSL.

## Base commit

- `nicobailon/pi-subagents@a859d1de` — `fix(runner): strip inherited Git routing environment (#2440)`, 2026-09-23. Package version at fork time: `0.70.1`.
- First sync point: `964481f4` (`fix(workflows): show a revived workflow child as its key's latest run (#2585)`), selective. Applied: MCP hash align, compaction-abort recovery, retention reclaim, inheritSkills skills drop, reload-stopped reuse, undici 8.10.2, agent fixture root, watchdog/retention/supervisor perf, Herdr coordinator count, sibling-stopped states, project-trust inheritance, user-stop descendants, schema anchor, revived-child latest run.
- Current sync point: `ad11b7ab` (`fix: keep a run's final result when a consumer of its paused result cleans up (#2757)`, v0.76.1, 2026-10-08), full-tree. The branch `sync/upstream-ad11b7ab` was cut from the upstream commit and the cc layer replayed on top (`git apply --3way` of `git diff 964481f4 main`), then resolved per the verdicts below. Package version at this sync: fork `0.74.0`.

### Verdicts at the `ad11b7ab` sync

| Upstream change | Verdict | Notes |
|---|---|---|
| `#2588` workflow contract (`workflow: true` / path / named resource; `workflowScript`+`workflowScriptPath` removed from the public schema) | **ADOPT (breaking, no shims)** | Owner decision per `VISION.md` hard-cutover policy. The internal `workflowScript` field remains an executor-internal carrier, as upstream designed it. |
| `#2596` script-free `tasks`/`chain` | **ADOPT, unconditional** | The fork has no `disabledFeatures` surface, so `tasks`/`chain` are always available alongside `workflow` (schema, executor `structuredWorkflows: true`, docs). |
| `disabledFeatures` config `#2542` | **SKIP (stay removed)** | One delegation surface; a per-feature kill switch contradicts fork scope discipline. `disabled-features.ts` and its tests stay deleted; `chain`/`tasks` rehomed as above. |
| Built-in MCP direct tools `#2555` + adapter priority `#2575` + `mcp-direct-tool-allowlist` evolution | **ADOPT** | Restores the shared safety file to upstream shape; later upstream fixes assume this foundation. |
| scoped-model `scoped` token `#2538` (+ `model-scope`/`model-resolution`/`async-execution` threading) | **ADOPT** | Reverted the fork's earlier removal; the feature is upstream-owned and the fork layer does not depend on its absence. |
| codemode registration `#2574` | **SKIP** | No codemode integration in this fork; a registration hook without an integration is dead surface. Omitted during `extension/index.ts` resolution. |
| deslop refactor (pre-`#2585`, previously skipped) | **ADOPT** | Comments-only; arrived with the full-tree base. The original skip reason (textual conflict inflation) inverted once the base became upstream itself. |
| Message blocks `#2753`, provider/model display `#2734`, tmux inspector `#2719`, OSC 7501 `#2725`, runnerLaunchers `#2577/#2720`, zoned daily/weekly schedules `#2656`, worktree-cleanup apply `#2655`, child command supervision `#2598`, `requireForAllRunners` `#2643`, `toolActivation` `#2589/#2595`, async widget collapse `#2621` | **ADOPT** | Arrive with the base; `extension/index.ts` and `tui/render.ts` keep their upstream wiring. |
| Progressive-widget growth/shrink (`#2651`-family) and lanes-in-compact-card (`#2578`-family) | **SKIP for now** | The fork keeps its simplified progressive widget (`tui/render.ts` resolved to the fork side); the line-budget concept returns with the planned TUI rebuild (`agent-widget.ts`). `asyncWidgetCollapsed` (`#2621`) is adopted; the `rows` layout (`#2738`) arrives via config but the fork-simplified widget ignores advanced layout tiers. |

## What this fork changes (vs upstream)

## What this fork changes (vs upstream)

1. Identity: package `pi-subagents-cc`, installed and removed through Pi's Git package manager: `pi install https://github.com/ttaatoo/pi-subagents-cc` / `pi remove https://github.com/ttaatoo/pi-subagents-cc`. There is no standalone installer/bin or npm publication workflow; source and compiled smoke artifacts are private. Public imports use `pi-subagents-cc/<subpath>` with no old-name alias. Tools, event protocols, and run storage retain the upstream contract, so enable only one of upstream and this fork in a session.
2. Claude Code parity at the presentation layer only (contract: `docs/claude-parity.md`); no second execution path — `@handle` dispatch reuses the existing steer/resume/spawn paths, per `VISION.md` one operator, one delegation layer:
   - `@mention` routing (`src/tui/mention.ts`, `src/extension/mention-input.ts`, `src/extension/mention-provider.ts`): live → steer, resumable → resume, advertised type → spawn; bare/`@main`/unknown/image/extension input stays with the main model.
   - Fleet inspector: smart-`Enter`/`→` opens the inline steer composer for live children (else external inspector); `inspect` default is `H` only; `Esc`/`←` backs out of composer, stop-confirm, and Prompt Audit; `m` cycles transcript `md` → `md+` → `raw` with a 16 KB per-result cap.
   - FleetView simplified: running rows use `accent` (no thinking-level colors); inline workflow coverage, workflow/project-pane rows, and nested-children expansion are removed in favor of the inspector.
3. `README.md` fork banner + this file; `LICENSE` preserves the upstream MIT notice.

## What this fork does NOT change

- No `Agent` / `get_subagent_result` / `steer_subagent` / `SubagentWorkflow` registration; no `agent()` / `parallel()` / `pipeline()` scripting (mapping: `agent` → `runs.run`, `parallel` → `runs.all`, `pipeline` → `runs.lanes`, `steer` → `runs.steer`). No local `~/.pi/agent` modifications were merged (none existed).
- Upstream `CHANGELOG.md` is kept as-is for provenance; new fork entries go under a `pi-subagents-cc` section at the top when they exist.
