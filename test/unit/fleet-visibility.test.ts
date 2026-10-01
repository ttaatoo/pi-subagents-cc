import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import { collectFleetStatusEntries } from "../../src/tui/fleet-status.ts";
import { collectMentionRoster } from "../../src/extension/mention-provider.ts";
import { MENTION_ROUTING_GUIDANCE } from "../../src/tui/mention.ts";
import { buildSubagentToolDescription } from "../../src/extension/tool-description.ts";

function stateForTest(): SubagentState {
	return { baseCwd: process.cwd(), currentSessionId: "S", asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} } };
}
function job(id: string, overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return { asyncId: id, asyncDir: `/tmp/${id}`, mode: "single", status: "running", sessionId: "S", startedAt: 1_000, agents: ["worker"], steps: [{ agent: "worker", status: "running", index: 0 }], ...overrides } as AsyncJobState;
}

describe("simplified Fleet visibility contract", () => {
	it("keeps concurrent workflows, nested children and foreground work addressable without inline expansion", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow", job("workflow", { mode: "workflow", description: "survey", steps: [{ agent: "scout", status: "running", index: 0, workflowKey: "lane.a" }] }));
		state.asyncJobs.set("nested-parent", job("nested-parent", { nestedChildren: [{ runId: "nested-child", agent: "worker", status: "running" }] }));
		state.asyncJobs.set("background", job("background", { agents: ["reviewer"], steps: [{ agent: "reviewer", status: "running", index: 0 }] }));
		state.workflowControllers = new Map([["workflow", new AbortController()]]);
		state.foregroundControls.set("F", { runId: "F", parentWorkflowRunId: "workflow", sessionId: "S", mode: "parallel", startedAt: 1, updatedAt: 1,
			activeChildren: new Map([[0, { index: 0, agent: "scout", startedAt: 1, updatedAt: 1, steer: async () => ({ state: "queued" }) }]]) });
		const entries = collectFleetStatusEntries(state);
		const keys = entries.map((entry) => entry.key);
		assert.ok(keys.some((key) => key === "async:workflow"), "workflow shell stays visible");
		assert.ok(keys.some((key) => key === "async:background:0"), "background child stays visible");
		assert.ok(keys.some((key) => key === "foreground-active:F:0"), "foreground child stays visible");
		const mention = collectMentionRoster(state, []);
		assert.ok(mention.targets.some((target) => target.kind === "live" && target.entry.runId === "background"));
	});

	it("does not present terminal runs as active Fleet work", () => {
		const state = stateForTest();
		for (const [id, status] of [["done", "complete"], ["failed", "failed"], ["paused", "paused"], ["stopped", "stopped"]] as const) {
			state.asyncJobs.set(id, job(id, { status, steps: [{ agent: "worker", status, index: 0 }], sessionFile: `/tmp/${id}/session.jsonl` }));
		}
		assert.deepEqual(collectFleetStatusEntries(state), []);
	});

	it("windows overflow instead of hiding it", () => {
		const state = stateForTest();
		for (let index = 0; index < 8; index++) state.asyncJobs.set(`run-${index}`, job(`run-${index}`, { startedAt: 1_000 + index }));
		const entries = collectFleetStatusEntries(state);
		assert.equal(entries.length > 5, true);
		assert.deepEqual([...new Set(entries.map((entry) => entry.key))].length, entries.length);
	});
});

describe("hot-path and context baselines", () => {
	it("collects Fleet and mention projections for 200 jobs within budget", () => {
		const state = stateForTest();
		for (let index = 0; index < 200; index++) state.asyncJobs.set(`run-${index}`, job(`run-${index}`, { startedAt: index }));
		const started = performance.now();
		const entries = collectFleetStatusEntries(state);
		const roster = collectMentionRoster(state, [{ name: "worker", description: "works", advertise: true }]);
		const elapsed = performance.now() - started;
		assert.equal(entries.length > 0, true);
		assert.equal(roster.targets.length > 0, true);
		assert.ok(elapsed < 500, `projection took ${elapsed.toFixed(1)}ms`);
	});

	it("records the current prompt footprint instead of asserting a fixed budget", () => {
		const description = buildSubagentToolDescription({});
		const guidance = MENTION_ROUTING_GUIDANCE;
		assert.ok(description.length > 0 && guidance.length > 0);
		console.log(`baseline: toolDescription=${description.length} mentionGuidance=${guidance.length}`);
	});
});
