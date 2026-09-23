# Fork notes — pi-subagents-cc

Independent fork (omp-style: **not** created via GitHub's fork button, no upstream fork network link), maintained by [ttaatoo](https://github.com/ttaatoo).

## Credits

- Base / upstream: [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) by Nico Bailon (MIT). All core delegation, workflow orchestration, supervision, and observability work belongs there.
- Claude Code style: [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT) — Claude Code-style autonomous sub-agent conventions (`Agent`, `get_subagent_result`, `steer_subagent`), FleetView/conversation-viewer/agent-mention UX language, and the `SubagentWorkflow` `agent()/parallel()/pipeline()` scripting shape this fork's user-facing style follows.

## Base commit

- `nicobailon/pi-subagents@a859d1de` — `fix(runner): strip inherited Git routing environment (#2440)`, 2026-09-23. Package version at fork time: `0.70.1`.
- Full upstream history lives upstream; this repo starts fresh with the tree at that commit plus the fork branding below.

## What this fork changes (vs upstream)

1. Identity: package `pi-subagents` → `pi-subagents-cc`, installer bin `pi-subagents-cc`, install dir `~/.pi/agent/extensions/subagent-cc` (no collision with upstream installs), install via `pi install https://github.com/ttaatoo/pi-subagents-cc`.
2. User-facing style follows tintinweb's Claude Code conventions (tool naming, docs tone); no second execution path was added — per `VISION.md`, one operator, one delegation layer.
3. `README.md` fork banner + this file; `LICENSE` keeps the upstream MIT notice and appends the fork copyright line.

## What this fork does NOT change

- No feature diff vs the base commit; no local `~/.pi/agent` modifications were merged (none existed).
- Upstream `CHANGELOG.md` is kept as-is for provenance; new fork entries go under a `pi-subagents-cc` section at the top when they exist.
