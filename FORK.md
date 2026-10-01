# Fork notes — pi-subagents-cc

Independent fork (omp-style: **not** created via GitHub's fork button, no upstream fork network link), maintained by [ttaatoo](https://github.com/ttaatoo).

## Credits

- Base / upstream: [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) by Nico Bailon (MIT). All core delegation, workflow orchestration, supervision, and observability work belongs there.
- Claude Code style: [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT) — FleetView, conversation-viewer, agent mentions, and keyboard interaction. This fork does not adopt its tool names or workflow DSL.

## Base commit

- `nicobailon/pi-subagents@a859d1de` — `fix(runner): strip inherited Git routing environment (#2440)`, 2026-09-23. Package version at fork time: `0.70.1`.
- Upstream sync point: `964481f4` (`fix(workflows): show a revived workflow child as its key's latest run (#2585)`), selective. Applied: MCP hash align, compaction-abort recovery, retention reclaim, inheritSkills skills drop, reload-stopped reuse, undici 8.10.2, agent fixture root, watchdog/retention/supervisor perf, Herdr coordinator count, sibling-stopped states, project-trust inheritance, user-stop descendants, schema anchor, revived-child latest run. Intentionally skipped: scoped-model token, disable-features config, deslop refactor, built-in MCP support, codemode registration, MCP-adapter priority (needs the skipped MCP feat), and the two progressive-widget TUI fixes (lanes/agent-count conflict with this fork's inspector-owned Fleet simplification). The `sync/upstream-*` branches replay the cc layer below on top of upstream; full upstream history lives upstream.
- Full upstream history lives upstream; this repo starts fresh with the tree at that commit plus the fork branding below.

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
