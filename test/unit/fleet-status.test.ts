import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import { EXTERNAL_RUN_REGISTRY_KEY, EXTERNAL_RUN_REGISTRY_VERSION, registerExternalRun } from "../../src/api/external-runs.ts";
import {
	FLEET_STATUS_WIDGET_KEY,
	SubagentFleetStatus,
	collectFleetStatusEntries,
	fleetAgentIdentityColor,
	formatFleetElapsed,
	formatFleetTokens,
	resolveFleetViewPlacement,
} from "../../src/tui/fleet-status.ts";

function clearExternalRuns(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

type Mounted = { render(width: number): string[]; invalidate(): void; dispose?(): void };
type Factory = (tui: unknown, theme: unknown) => Mounted;

function singleJob(id: string, overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return {
		asyncId: id,
		asyncDir: `/tmp/${id}`,
		mode: "single",
		status: "running",
		startedAt: 1_000,
		agents: [id],
		...overrides,
	} as AsyncJobState;
}

function harness(inspector: (key: string) => void = () => {}, uiTheme: typeof theme = theme) {
	const state = stateForTest();
	const mounted = new Map<string, Mounted>();
	const setWidgetCalls: Array<{ key: string; cleared: boolean }> = [];
	let requests = 0;
	let editorText = "";
	const tui = { requestRender() { requests++; }, focusedComponent: Object.create(Editor.prototype) };
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			getEditorText: () => editorText,
			onTerminalInput: () => () => {},
			notify() {},
			setWidget(key: string, factory: Factory | undefined) {
				mounted.delete(key);
				setWidgetCalls.push({ key, cleared: factory === undefined });
				// Invoke immediately like the real TUI: this wires this.tui
				// (focus tracking) at registration time.
				if (factory) mounted.set(key, factory(tui, uiTheme));
			},
		},
	} as unknown as ExtensionContext;
	const seenInspectorKeys: string[] = [];
	const fleet = new SubagentFleetStatus(state, (key) => {
		seenInspectorKeys.push(key);
		inspector(key);
	}, { refreshMs: 60_000 });
	fleet.setContext(ctx);
	return {
		state,
		fleet,
		ctx,
		mounted,
		setWidgetCalls,
		seenInspectorKeys,
		get requests() { return requests; },
		setEditorText(value: string) { editorText = value; },
		sync() { fleet.refresh(); },
		text(width = 120): string {
			return mounted.get(FLEET_STATUS_WIDGET_KEY)?.render(width).join("\n") ?? "";
		},
		down() { return fleet.handleKey("\x1b[B"); },
		up() { return fleet.handleKey("\x1b[A"); },
		esc() { return fleet.handleKey("\x1b"); },
		enter() { return fleet.handleKey("\r"); },
		close() { fleet.dispose(); },
	};
}

function addWorkflow(h: ReturnType<typeof harness>, id: string, childIds: string[], description = `${id} survey`): void {
	h.state.asyncJobs.set(id, {
		asyncId: id,
		asyncDir: `/tmp/${id}`,
		mode: "workflow",
		status: "running",
		startedAt: 1_000,
		description,
	});
	for (const [index, childId] of childIds.entries()) {
		h.state.asyncJobs.set(childId, {
			...singleJob(childId, { startedAt: 2_000 + index, parentWorkflowRunId: id }),
			agents: [`${childId}-worker`],
		});
	}
	h.sync();
}

describe("below-editor subagent FleetView", () => {
	it("formats elapsed time and token counts like the Claude Code fleet", () => {
		assert.equal(formatFleetElapsed(10_600), "11s");
		assert.equal(formatFleetTokens(999), "↓ 999 tokens");
		assert.equal(formatFleetTokens(13_100), "↓ 13.1k tokens");
		assert.equal(formatFleetTokens(1_250_000), "↓ 1.3M tokens");
		assert.equal(formatFleetTokens(484_000, 129_000), "↓ 129.0k window · 484.0k spent");
	});

	it("resolves configured FleetView placement with a below-editor fallback", () => {
		assert.equal(resolveFleetViewPlacement(undefined), "belowEditor");
		assert.equal(resolveFleetViewPlacement("belowEditor"), "belowEditor");
		assert.equal(resolveFleetViewPlacement("aboveEditor"), "aboveEditor");
		assert.equal(resolveFleetViewPlacement("side"), "belowEditor");
	});

	it("registers above the editor when configured", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		let placement: string | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown, options?: { placement?: string }) {
					if (content) placement = options?.placement;
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000, placement: "aboveEditor" });
		try {
			fleet.setContext(ctx);
			assert.equal(placement, "aboveEditor");
		} finally {
			fleet.dispose();
		}
	});

	it("keeps common FleetView agent identities on distinct theme colors", () => {
		for (const [left, right] of [["scout", "worker"], ["tester", "explorer"], ["debug", "videoReview"]] as const) {
			assert.notEqual(fleetAgentIdentityColor(left), fleetAgentIdentityColor(right));
		}
	});

	it("keeps agent color stable when async display labels differ", () => {
		const colorTheme = {
			fg: (name: string, text: string) => `⟦${name}⟧${text}⟦/⟧`,
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const h = harness(() => {}, colorTheme);
		try {
			h.state.asyncJobs.set("labeled-agents", {
				asyncId: "labeled-agents",
				asyncDir: "/tmp/labeled-agents",
				status: "running",
				mode: "parallel",
				startedAt: Date.now() - 1_000,
				updatedAt: Date.now(),
				steps: [
					{ agent: "scout", label: "Find seams", status: "running", index: 0 },
					{ agent: "scout", label: "Audit API", status: "running", index: 1 },
				],
			});
			h.sync();
			h.down();
			const lines = h.text(160).split("\n");
			const colorFor = (label: string) => lines.find((line) => line.includes(label))?.match(new RegExp(`⟦(\\w+)⟧${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))?.[1];
			assert.equal(colorFor("Find seams (scout)"), colorFor("Audit API (scout)"));
			assert.equal(colorFor("Find seams (scout)"), fleetAgentIdentityColor("scout"));
		} finally {
			h.close();
		}
	});

	it("shows nothing without entries and stops the tick", () => {
		const h = harness();
		try {
			assert.equal(h.text(), "");
			assert.ok(!h.mounted.has(FLEET_STATUS_WIDGET_KEY));
			h.state.asyncJobs.set("w1", singleJob("w1"));
			h.sync();
			assert.ok(h.mounted.has(FLEET_STATUS_WIDGET_KEY));
			h.state.asyncJobs.clear();
			h.sync();
			assert.equal(h.text(), "");
			assert.deepEqual(
				h.setWidgetCalls.filter((call) => call.key === FLEET_STATUS_WIDGET_KEY).map((call) => call.cleared),
				[false, true],
			);
		} finally {
			h.close();
		}
	});

	it("renders main plus agents earliest-first with selection bullets", () => {
		const h = harness();
		try {
			h.state.asyncJobs.set("late", singleJob("late", { startedAt: 3_000, agents: ["late-worker"] }));
			h.state.asyncJobs.set("early", singleJob("early", { startedAt: 2_000, agents: ["early-worker"] }));
			h.sync();
			const lines = h.text().split("\n");
			assert.match(lines[0]!, /esc to interrupt · ← for agents · ↓ to manage/);
			assert.match(lines[2]!, /● main/);
			assert.ok(lines.findIndex((line) => line.includes("early-worker")) < lines.findIndex((line) => line.includes("late-worker")));
			assert.match(lines.find((line) => line.includes("early-worker"))!, /○/);
			h.down();
			h.down();
			const active = h.text().split("\n");
			assert.match(active[0]!, /↑↓ select · enter view · esc back/);
			assert.match(active[2]!, /○ main/);
			assert.match(active.find((line) => line.includes("early-worker"))!, /●/);
		} finally {
			h.close();
		}
	});

	it("lists workflow runs above their agents with counts", () => {
		const h = harness();
		try {
			addWorkflow(h, "wf", ["a", "b"]);
			const lines = h.text().split("\n");
			const order = ["main", "workflow", "a-worker", "b-worker"].map((needle) => lines.findIndex((line) => line.includes(needle)));
			assert.deepEqual([...order].sort((x, y) => x - y), order);
			assert.match(lines.find((line) => line.includes("workflow"))!, /2 agents/);
			assert.doesNotMatch(h.text(), /checklist|bottleneck/);
		} finally {
			h.close();
		}
	});

	it("windows to five rows with more indicators", () => {
		const h = harness();
		try {
			addWorkflow(h, "wf", ["c1", "c2", "c3", "c4", "c5", "c6"]);
			const lines = h.text().split("\n");
			assert.match(lines.find((line) => /↓ \d+ more/.test(line))!, /↓ 2 more/);
			h.down();
			for (let n = 0; n < 7; n++) h.down();
			const scrolled = h.text().split("\n");
			assert.match(scrolled.find((line) => /↑ \d+ more/.test(line))!, /↑ 2 more/);
			assert.doesNotMatch(scrolled.join("\n"), /↓ \d+ more/);
			for (const line of scrolled) assert.ok(visibleWidth(line) <= 120);
		} finally {
			h.close();
		}
	});

	it("activates on down/left at an empty prompt, never on right or with text", () => {
		const h = harness();
		try {
			h.state.asyncJobs.set("w1", singleJob("w1"));
			h.sync();
			assert.deepEqual(h.fleet.handleKey("\x1b[C"), undefined);
			assert.match(h.text().split("\n")[0]!, /↓ to manage/);
			h.setEditorText("x");
			assert.deepEqual(h.down(), undefined);
			assert.match(h.text().split("\n")[0]!, /↓ to manage/);
			h.setEditorText("");
			assert.deepEqual(h.fleet.handleKey("\x1b[D"), { consume: true });
			assert.match(h.text().split("\n")[0]!, /enter view/);
		} finally {
			h.close();
		}
	});

	it("navigates, inspects, and exits like the upstream roster", async () => {
		const seen: string[] = [];
		const h = harness((key) => { seen.push(key); });
		const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
		try {
			h.state.asyncJobs.set("w1", singleJob("w1", { agents: ["w1-worker"] }));
			h.sync();
			h.down();
			h.down();
			assert.deepEqual(h.enter(), { consume: true });
			await flush();
			assert.deepEqual(seen, ["async:w1:0"]);
			assert.deepEqual(h.esc(), { consume: true });
			assert.match(h.text().split("\n")[0]!, /↓ to manage/);
			h.down();
			h.up();
			assert.match(h.text().split("\n")[0]!, /↓ to manage/);
			h.down();
			h.down();
			assert.deepEqual(h.fleet.handleKey("x"), undefined);
			assert.match(h.text().split("\n")[0]!, /↓ to manage/);
		} finally {
			h.close();
		}
	});

	it("entering on main returns to the prompt without inspecting", () => {
		const h = harness(() => { throw new Error("must not inspect"); });
		try {
			h.state.asyncJobs.set("w1", singleJob("w1"));
			h.sync();
			h.down();
			assert.deepEqual(h.enter(), { consume: true });
			assert.match(h.text().split("\n")[0]!, /↓ to manage/);
		} finally {
			h.close();
		}
	});

	it("keeps the stats tail intact on narrow screens", () => {
		const h = harness();
		try {
			h.state.asyncJobs.set("w1", singleJob("w1", {
				agents: ["worker (muse-spark-1.3-contributor)"],
				totalTokens: { input: 100, output: 100, total: 2_900, window: 2_600 },
			}));
			h.sync();
			const lines = h.text(60).split("\n");
			for (const line of lines) assert.ok(visibleWidth(line) <= 60);
			const row = lines.find((line) => line.includes("worker"))!;
			assert.match(row, /↓ 2\.6k window · 2\.9k spent/);
		} finally {
			h.close();
		}
	});

	it("shows queued agents without a state word, like upstream", () => {
		const h = harness();
		try {
			h.state.asyncJobs.set("q1", singleJob("q1", { status: "queued", agents: ["queued-worker"] }));
			h.sync();
			const row = h.text().split("\n").find((line) => line.includes("queued-worker"))!;
			assert.ok(row);
			assert.doesNotMatch(row, /queued.*·.*queued/);
		} finally {
			h.close();
		}
	});

	it("renders cached external jobs with elapsed time and no token tail", () => {
		clearExternalRuns();
		registerExternalRun({
			id: "external-review",
			sessionId: "session-current",
			source: "interactive-shell",
			label: "Dependency review",
			state: "running",
			startedAt: Date.now() - 11_000,
			currentAction: "Inspecting package metadata",
		});
		const h = harness();
		try {
			assert.deepEqual(collectFleetStatusEntries(h.state).map((entry) => ({ key: entry.key, agent: entry.agent, description: entry.description })), [{
				key: "external:external-review",
				agent: "external · Dependency review",
				description: "Inspecting package metadata",
			}]);
			h.sync();
			const row = h.text(80).split("\n").find((line) => line.includes("Dependency review"))!;
			assert.match(row, /11s/);
			assert.doesNotMatch(row, /tokens/);
		} finally {
			h.close();
			clearExternalRuns();
		}
	});

	it("warns when external job inspection fails", () => {
		clearExternalRuns();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = {
			version: EXTERNAL_RUN_REGISTRY_VERSION + 1,
			runs: new Map(),
		};
		try {
			assert.deepEqual(collectFleetStatusEntries(stateForTest()), []);
			assert.match(warnings[0]!, /Failed to inspect external jobs/);
		} finally {
			console.warn = originalWarn;
			clearExternalRuns();
		}
	});

	it("clamps selection when rows shrink", () => {
		const h = harness();
		try {
			addWorkflow(h, "wf", ["a", "b"]);
			h.down();
			for (let n = 0; n < 4; n++) h.down();
			h.state.asyncJobs.clear();
			h.sync();
			assert.equal(h.text(), "");
			h.state.asyncJobs.set("w1", singleJob("w1"));
			h.sync();
			h.down();
			assert.match(h.text().split("\n")[0]!, /enter view/);
		} finally {
			h.close();
		}
	});

	it("repaints running entries on the tick but keeps queued-only ticks quiet", () => {
		const refreshCount = (status: "running" | "queued"): number => {
			const h = harness();
			try {
				h.state.asyncJobs.set(`run-${status}`, singleJob(`run-${status}`, { status }));
				h.sync();
				assert.ok(h.mounted.has(FLEET_STATUS_WIDGET_KEY));
				const before = h.requests;
				h.sync();
				return h.requests - before;
			} finally {
				h.close();
			}
		};

		assert.equal(refreshCount("running"), 1);
		assert.equal(refreshCount("queued"), 0);
	});

	it("stops refreshing when the captured extension context becomes stale", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		let stale = false;
		let contextReads = 0;
		let inputUnsubscribes = 0;
		let widgetRemovals = 0;
		const ctx = {
			get hasUI() {
				contextReads++;
				if (stale) {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}
				return true;
			},
			ui: {
				setWidget(_key: string, content: unknown) {
					if (content === undefined) widgetRemovals++;
				},
				onTerminalInput() { return () => { inputUnsubscribes++; }; },
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			stale = true;
			assert.doesNotThrow(() => fleet.refresh());
			assert.equal(inputUnsubscribes, 1);
			assert.equal(widgetRemovals, 1);
			assert.equal((fleet as unknown as { timer?: unknown }).timer, undefined);
			const readsAfterStaleRefresh = contextReads;
			fleet.refresh();
			assert.equal(contextReads, readsAfterStaleRefresh, "later refreshes must not reuse the stale context");
		} finally {
			fleet.dispose();
		}
	});

	it("does not swallow unrelated widget cleanup errors", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown) {
					if (content === undefined) throw new Error("widget cleanup failed");
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		fleet.setContext(ctx);
		assert.throws(() => fleet.dispose(), /widget cleanup failed/);
	});

	it("preserves multiple unrelated UI cleanup errors", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown) {
					if (content === undefined) throw new Error("widget cleanup failed");
				},
				onTerminalInput() {
					return () => { throw new Error("input cleanup failed"); };
				},
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		fleet.setContext(ctx);
		assert.throws(
			() => fleet.dispose(),
			(error: unknown) => error instanceof AggregateError
				&& error.errors.map(String).join("\n").includes("input cleanup failed")
				&& error.errors.map(String).join("\n").includes("widget cleanup failed"),
		);
	});

	it("keeps widget ownership through invalidation so an empty refresh removes it", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		let widgetFactory: ((tui: unknown, theme: typeof theme) => { render(width: number): string[]; invalidate(): void }) | undefined;
		let removals = 0;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: typeof widgetFactory | undefined) {
					if (content) widgetFactory = content;
					else removals++;
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {} }, theme);
			component.invalidate();
			state.foregroundControls.clear();
			fleet.refresh();
			assert.equal(removals, 1);
		} finally {
			fleet.dispose();
		}
	});

	it("removes the dynamic widget while the fleet inspector owns the viewport", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		const registrations: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown) {
					registrations.push(content ? "shown" : "hidden");
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			state.fleetInspectorOpen = true;
			fleet.refresh();
			state.fleetInspectorOpen = false;
			fleet.refresh();
			assert.deepEqual(registrations, ["shown", "hidden", "shown"]);
		} finally {
			fleet.dispose();
		}
	});
});
