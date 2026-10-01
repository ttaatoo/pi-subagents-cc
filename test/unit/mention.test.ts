import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AsyncJobState, Details, SubagentState } from "../../src/shared/types.ts";
import { collectMentionRoster, createMentionAutocompleteProvider } from "../../src/extension/mention-provider.ts";
import { executeMentionRoute, routeMentionInput, type MentionRouteActions } from "../../src/extension/mention-input.ts";
import { MENTION_TRIGGER, MentionRoster, assignHandle, handleBase, isReservedHandle, parseMentionSend, resolveHandleToType, stripAgentPrefix, type MentionLiveEntry } from "../../src/tui/mention.ts";

function stateForTest(): SubagentState {
	return { baseCwd: process.cwd(), currentSessionId: "S", asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} } };
}
function job(id: string, agent = "scout"): AsyncJobState {
	return { asyncId: id, asyncDir: `/tmp/${id}`, status: "running", sessionId: "S", mode: "single", steps: [{ agent, status: "running", index: 0 }], sessionFile: `/tmp/${id}/session.jsonl` };
}
const entry = (id: string, agent = "scout", index = 0): MentionLiveEntry => ({ source: "async", runId: id, index, agent, state: "running" });
const types = [{ name: "worker", description: "works", advertise: true }];
const route = (text: string, roster: ReturnType<typeof collectMentionRoster>, extra = {}) => routeMentionInput({ text, source: "interactive", imageCount: 0, ...extra }, roster);
const result = (text: string, isError = false): AgentToolResult<Details> => ({ content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } });

function actionsForTest() {
	const calls: string[] = [], notices: Array<{ text: string; type?: string }> = [];
	const actions: MentionRouteActions = {
		steer: async (entry, message) => { calls.push(`steer:${entry.runId}:${entry.index}:${message}`); return result("Steering queued."); },
		resume: async (entry, message) => { calls.push(`resume:${entry.runId}:${entry.index}:${message}`); return result("Follow-up detached."); },
		spawn: async (name, task) => { calls.push(`spawn:${name}:${task}`); return { ...result("Started."), runId: "new-run" }; },
		notify: (text, type) => { notices.push({ text, type }); },
	};
	return { actions, calls, notices };
}

describe("@mention grammar", () => {
	it("triggers at token boundaries, not paths or email", () => {
		for (const text of ["@scout", "hey @scout", "你好。@scout"]) assert.equal(MENTION_TRIGGER.exec(text)?.[2], "scout");
		for (const text of ["@src/foo.ts", "email@host"]) assert.equal(MENTION_TRIGGER.exec(text), null);
	});
	it("sends only a leading handle with a nonempty message", () => {
		assert.deepEqual(parseMentionSend(" @scout map auth"), { handle: "scout", message: "map auth" });
		for (const text of ["@scout", "@scout   ", "hey @scout go"]) assert.equal(parseMentionSend(text), undefined);
	});
	it("slugs names, reserves main, bounds collision suffixes and supports manual prefix", () => {
		assert.equal(handleBase("Code Reviewer!"), "code-reviewer");
		assert.equal(assignHandle("scout", new Set(["scout"])), "scout-2");
		assert.equal(assignHandle("main", new Set()), "main-2");
		assert.equal(assignHandle("x".repeat(64), new Set(["x".repeat(64)])).length, 64);
		assert.ok(isReservedHandle("Main"));
		assert.equal(stripAgentPrefix("agent-scout"), "scout");
		assert.equal(stripAgentPrefix("agent-"), undefined);
		assert.equal(resolveHandleToType("SCOUT", ["scout"]), "scout");
		assert.equal(resolveHandleToType("main", ["main"]), undefined);
	});
});

describe("session-local mention identities", () => {
	it("keeps same-name targets through terminal transitions, reordering and new launches", () => {
		const roster = new MentionRoster(), A = entry("A"), B = entry("B");
		assert.equal(roster.build([A, B], [], []).resolve("scout")?.kind, "live");
		for (const terminal of ["complete", "failed", "paused"]) {
			const next = roster.build([B], [{ ...A, state: terminal }], []);
			assert.equal(next.resolve("scout")?.kind, "resumable");
			assert.equal(next.resolve("scout-2")?.kind, "live");
			const target = next.resolve("scout");
			if (target && target.kind !== "type") assert.equal(target.entry.runId, "A");
		}
		const next = roster.build([entry("C"), B, A], [], []);
		assert.deepEqual(next.targets.map((x) => x.handle), ["scout-3", "scout-2", "scout"]);
	});
	it("distinguishes child indexes and never recycles retired handles", () => {
		const roster = new MentionRoster();
		roster.build([entry("A", "scout", 0), entry("A", "scout", 1)], [], []);
		const next = roster.build([entry("B")], [], [{ name: "scout", description: "scan" }]);
		assert.equal(next.targets[0]?.handle, "scout-3");
		assert.equal(next.resolve("scout")?.kind, "unavailable");
		assert.equal(next.resolve("agent-scout-2")?.kind, "unavailable");
	});
	it("omits reserved and colliding types", () => {
		const snapshot = new MentionRoster().build([entry("A")], [], [{ name: "main", description: "main" }, { name: "scout", description: "scan" }, { name: "worker", description: "work" }]);
		assert.deepEqual(snapshot.targets.map((x) => x.handle), ["scout", "worker"]);
	});
});

describe("authoritative mention projection", () => {
	it("uses the same stable identity for completion and dispatch after state changes", async () => {
		const state = stateForTest(), A = job("A"), B = job("B"); state.asyncJobs.set("A", A); state.asyncJobs.set("B", B);
		const current: AutocompleteProvider = { getSuggestions: async () => null, applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }) };
		const provider = createMentionAutocompleteProvider(current, { state, getAdvertisedAgents: () => types });
		const suggestions = await provider.getSuggestions(["@sc"], 0, 3, { signal: new AbortController().signal });
		assert.deepEqual(suggestions?.items.map((x) => x.value), ["@scout", "@scout-2"]);
		A.status = "complete"; A.steps![0]!.status = "complete";
		const decision = route("@scout continue", collectMentionRoster(state, types));
		assert.equal(decision.kind, "resume");
		if (decision.kind === "resume") assert.equal(decision.target.entry.runId, "A");
	});
	it("requires session ownership and does not advertise workflow roots", () => {
		const state = stateForTest();
		for (const id of ["foreign", "unknown", "workflow"]) state.asyncJobs.set(id, job(id));
		state.asyncJobs.get("foreign")!.sessionId = "other";
		state.asyncJobs.get("unknown")!.sessionId = undefined;
		state.asyncJobs.get("workflow")!.mode = "workflow";
		assert.deepEqual(collectMentionRoster(state, []).targets, []);
	});
	it("projects exact active child indexes instead of the first step", () => {
		const state = stateForTest(), multi = job("multi"); multi.mode = "parallel";
		multi.steps = [{ agent: "done", status: "complete", index: 0 }, { agent: "writer", status: "running", index: 1 }]; state.asyncJobs.set("multi", multi);
		const decision = route("@writer fix", collectMentionRoster(state, []));
		assert.equal(decision.kind, "steer");
		if (decision.kind === "steer") assert.equal(decision.target.entry.index, 1);
	});
	it("does not offer stopped, missing-session or external work as resumable/steerable", () => {
		const state = stateForTest();
		for (const id of ["stopped", "missing", "external"]) state.asyncJobs.set(id, job(id, id));
		const stopped = state.asyncJobs.get("stopped")!; stopped.status = "stopped"; stopped.steps![0]!.status = "stopped";
		const missing = state.asyncJobs.get("missing")!; missing.status = "failed"; missing.steps![0]!.status = "failed"; missing.sessionFile = undefined;
		Object.assign(state.asyncJobs.get("external")!.steps![0]!, { externalJob: { provider: "test" } });
		const roster = collectMentionRoster(state, []);
		assert.ok(roster.targets.every((x) => x.kind === "unavailable"));
		assert.equal(route("@stopped go", roster).kind, "blocked");
	});
	it("offers only controllable workflow-owned foreground children", () => {
		const state = stateForTest(); state.workflowControllers = new Map([["workflow", new AbortController()]]);
		state.foregroundControls.set("F", { runId: "F", parentWorkflowRunId: "workflow", sessionId: "S", mode: "parallel", startedAt: 0, updatedAt: 0,
			activeChildren: new Map([[2, { index: 2, agent: "reviewer", startedAt: 0, updatedAt: 0, steer: async () => ({ state: "queued" }) }]]) });
		const decision = route("@reviewer look", collectMentionRoster(state, []));
		assert.equal(decision.kind, "steer");
		if (decision.kind === "steer") assert.deepEqual(decision.target.entry, { source: "foreground", runId: "F", index: 2, agent: "reviewer", state: "running" });
		state.foregroundControls.get("F")!.parentWorkflowRunId = undefined;
		assert.equal(route("@reviewer look", collectMentionRoster(state, [])).kind, "blocked");
	});
	it("resets reservations for a new session, not for retention", () => {
		const state = stateForTest(); state.asyncJobs.set("A", job("A")); collectMentionRoster(state, []); state.asyncJobs.clear();
		assert.equal(route("@scout go", collectMentionRoster(state, [])).kind, "blocked");
		state.currentSessionId = "new";
		assert.equal(route("@scout go", collectMentionRoster(state, [])).kind, "continue");
	});
});

describe("file completion coexistence", () => {
	it("keeps bare @ file suggestions and appends agents with the same replacement span", async () => {
		const state = stateForTest(); let calls = 0;
		const current: AutocompleteProvider = { getSuggestions: async () => { calls++; return { prefix: "@", items: [{ value: "@file.ts", label: "file.ts" }] }; }, applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }) };
		const provider = createMentionAutocompleteProvider(current, { state, getAdvertisedAgents: () => types });
		assert.deepEqual((await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal }))?.items.map((x) => x.value), ["@file.ts", "@worker"]);
		assert.equal(calls, 1);
	});
	it("preserves conflicting file spans, explicit paths and aborted results", async () => {
		const state = stateForTest(), files = { prefix: "wo", items: [{ value: "worker.ts", label: "worker.ts" }] };
		const current: AutocompleteProvider = { getSuggestions: async () => files, applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }) };
		const provider = createMentionAutocompleteProvider(current, { state, getAdvertisedAgents: () => types });
		for (const text of ["@wo", "@src/wo", "hello"]) assert.deepEqual(await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal }), files);
		const controller = new AbortController(); controller.abort();
		assert.equal(await provider.getSuggestions(["@wo"], 0, 3, { signal: controller.signal }), null);
	});
});

describe("fail-closed mention dispatch", () => {
	const roster = new MentionRoster().build([entry("A")], [{ ...entry("B", "reviewer", 1), state: "complete" }], types);
	it("routes known targets, main, manual prefixes and non-agent input", () => {
		assert.equal(route("@scout look", roster).kind, "steer"); assert.equal(route("@reviewer again", roster).kind, "resume"); assert.equal(route("@agent-worker build", roster).kind, "spawn");
		assert.deepEqual(route("@main continue", roster), { kind: "transform", text: "continue" });
		for (const text of ["@scout", "@unknown go", "hey @scout go"]) assert.equal(route(text, roster).kind, "continue");
		assert.equal(route("@scout go", roster, { imageCount: 1 }).kind, "continue");
		assert.equal(route("@scout go", roster, { source: "extension" }).kind, "continue");
	});
	it("sends exactly one logical action with the exact child index", async () => {
		const { actions, calls } = actionsForTest();
		for (const text of ["@scout look", "@reviewer again", "@worker build"]) {
			const decision = route(text, roster); assert.ok(decision.kind !== "continue" && decision.kind !== "transform");
			assert.deepEqual(await executeMentionRoute(decision, actions), { action: "handled" });
		}
		assert.deepEqual(calls, ["steer:A:0:look", "resume:B:1:again", "spawn:worker:build"]);
	});
	it("never resumes after a rejected or raced steer", async () => {
		const { actions, calls, notices } = actionsForTest(); actions.steer = async () => result("Not running or permission denied.", true);
		const decision = route("@scout go", roster); assert.equal(decision.kind, "steer");
		if (decision.kind === "steer") assert.deepEqual(await executeMentionRoute(decision, actions), { action: "handled" });
		assert.deepEqual(calls, []); assert.equal(notices[0]?.type, "error"); assert.doesNotMatch(notices[0]!.text, /finished mid-send/);
	});
	it("consumes post-launch notification errors and unknown execution outcomes without replay", async () => {
		const { actions, calls } = actionsForTest(); actions.notify = () => { throw new Error("UI failed"); };
		const decision = route("@worker build", roster); assert.equal(decision.kind, "spawn");
		if (decision.kind === "spawn") {
			assert.deepEqual(await executeMentionRoute(decision, actions), { action: "handled" });
			assert.deepEqual(calls, ["spawn:worker:build"]);
			actions.spawn = async () => { throw new Error("Unknown outcome"); };
			assert.deepEqual(await executeMentionRoute(decision, actions), { action: "handled" });
		}
	});
	it("blocks retired targets without trying any execution action", async () => {
		const builder = new MentionRoster(); builder.build([entry("retired")], [], []);
		const decision = route("@scout go", builder.build([], [], [])); assert.equal(decision.kind, "blocked");
		const { actions, calls } = actionsForTest();
		if (decision.kind === "blocked") assert.deepEqual(await executeMentionRoute(decision, actions), { action: "handled" });
		assert.deepEqual(calls, []);
	});
});
