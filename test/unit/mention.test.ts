import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createMentionAutocompleteProvider } from "../../src/extension/mention-provider.ts";
import { executeMentionRoute, routeMentionInput, type MentionRouteActions } from "../../src/extension/mention-input.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../src/shared/types.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import {
	MENTION_TRIGGER,
	assignHandle,
	buildMentionRoster,
	handleBase,
	isReservedHandle,
	parseMentionSend,
	resolveHandleToType,
	stripAgentPrefix,
} from "../../src/tui/mention.ts";

describe("@mention grammar", () => {
	it("triggers on @ at a token boundary, never inside a path", () => {
		assert.ok(MENTION_TRIGGER.exec("@scout")?.[2] === "scout");
		assert.ok(MENTION_TRIGGER.exec("hey @reviewer")?.[2] === "reviewer");
		assert.equal(MENTION_TRIGGER.exec("@src/foo.ts"), null);
		assert.equal(MENTION_TRIGGER.exec("email@host"), null);
	});

	it("recognizes sends only at the start with a non-empty message", () => {
		assert.deepEqual(parseMentionSend("@scout map the auth flow"), { handle: "scout", message: "map the auth flow" });
		assert.equal(parseMentionSend("@scout"), undefined);
		assert.equal(parseMentionSend("@scout   "), undefined);
		assert.equal(parseMentionSend("hey @scout go"), undefined);
	});

	it("slugs handles and numbers collisions", () => {
		assert.equal(handleBase("Scout"), "scout");
		assert.equal(handleBase("Code Reviewer!"), "code-reviewer");
		assert.equal(assignHandle("scout", new Set()), "scout");
		assert.equal(assignHandle("scout", new Set(["scout"])), "scout-2");
		assert.equal(assignHandle("main", new Set()), "main-2");
	});

	it("reserves main and supports the @agent- prefix", () => {
		assert.equal(isReservedHandle("main"), true);
		assert.equal(isReservedHandle("Main"), true);
		assert.equal(isReservedHandle("scout"), false);
		assert.equal(stripAgentPrefix("@agent-scout"), undefined);
		assert.equal(stripAgentPrefix("agent-scout"), "scout");
		assert.equal(stripAgentPrefix("agent-"), undefined);
		assert.equal(resolveHandleToType("scout", ["scout", "worker"]), "scout");
		assert.equal(resolveHandleToType("SCOUT", ["scout"]), "scout");
		assert.equal(resolveHandleToType("main", ["main"]), undefined);
		assert.equal(resolveHandleToType("unknown", ["scout"]), undefined);
	});
});

describe("@mention autocomplete provider", () => {
	const current: AutocompleteProvider = {
		async getSuggestions() {
			return { items: [{ value: "file.ts", label: "file.ts" }], prefix: "fi" };
		},
		applyCompletion(lines) {
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
	};
	// Full-state literal (mirrors fleet.test.ts stateForTest): no assertions needed.
	const state: SubagentState = {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map([
			["run-1", { asyncId: "run-1", asyncDir: "/tmp/run-1", status: "running", sessionId: "session-current", agents: ["reviewer"] }],
		]),
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
	const deps = {
		state,
		// No assertion: MentionAgentInfo is the minimal roster shape.
		getAdvertisedAgents: () => [
			{ name: "reviewer", description: "reviews code", advertise: true },
			{ name: "scout", description: "scouts code", advertise: true },
		],
	};
	const provider = createMentionAutocompleteProvider(current, deps);
	const options = { signal: new AbortController().signal };

	it("offers agent handles for @ tokens and falls back to files otherwise", async () => {
		const agents = await provider.getSuggestions(["@rev"], 0, 4, options);
		assert.deepEqual(agents?.items.map((item) => item.value), ["@reviewer"]);
		assert.equal(agents?.prefix, "@rev");
		const files = await provider.getSuggestions(["@src/ma"], 0, 7, options);
		assert.deepEqual(files?.items.map((item) => item.value), ["file.ts"]);
		const plain = await provider.getSuggestions(["hello"], 0, 5, options);
		assert.deepEqual(plain?.items.map((item) => item.value), ["file.ts"]);
	});

	it("offers startable types alongside live agents", async () => {
		const suggestions = await provider.getSuggestions(["@"], 0, 1, options);
		assert.deepEqual(suggestions?.items.map((item) => item.value), ["@reviewer", "@scout"]);
	});
});

describe("@mention roster", () => {
	it("orders live agents first, then resumable, then startable types", () => {
		const roster = buildMentionRoster(
			[
				{ runId: "b", asyncDir: "/tmp/b", agent: "scout", state: "complete" },
			],
			[
				{ runId: "a", asyncDir: "/tmp/a", agent: "reviewer", state: "running" },
				{ runId: "c", asyncDir: "/tmp/c", agent: "reviewer", state: "running" },
			],
			[
				{ name: "reviewer", description: "reviews" },
				{ name: "scout", description: "scouts" },
				{ name: "worker", description: "works" },
			],
		);
		assert.deepEqual(roster.map((target) => target.handle), ["scout", "reviewer", "reviewer-2", "worker"]);
		assert.equal(roster[0]?.kind, "live");
		assert.equal(roster[1]?.kind, "resumable");
		assert.equal(roster[3]?.kind, "type");
	});

	it("keeps the two-arg call working with no resumable segment", () => {
		const roster = buildMentionRoster(
			[{ runId: "a", asyncDir: "/tmp/a", agent: "reviewer", state: "running" }],
			[],
			[{ name: "worker", description: "works" }],
		);
		assert.deepEqual(roster.map((target) => target.handle), ["reviewer", "worker"]);
	});

	it("returns an empty roster when nothing is addressable", () => {
		assert.deepEqual(buildMentionRoster([], []), []);
	});
});

describe("@mention direct routing", () => {
	const rosterInput = {
		live: [{ runId: "run-1", asyncDir: "/tmp/run-1", agent: "reviewer", state: "running" }],
		resumable: [{ runId: "run-0", asyncDir: "/tmp/run-0", agent: "scout", state: "complete" }],
		types: [
			{ name: "reviewer", description: "reviews" },
			{ name: "scout", description: "scouts" },
			{ name: "worker", description: "works" },
		],
	};
	const route = (text: string, extra: Partial<{ source: "interactive" | "rpc" | "extension"; imageCount: number }> = {}) =>
		routeMentionInput({ text, source: extra.source ?? "interactive", imageCount: extra.imageCount ?? 0 }, rosterInput);

	it("steers live handles, resumes finished ones, spawns known types", () => {
		assert.deepEqual(route("@reviewer look again"), {
			kind: "steer",
			target: { kind: "live", handle: "reviewer", entry: rosterInput.live[0] },
			message: "look again",
		});
		assert.deepEqual(route("@scout what did you find"), {
			kind: "resume",
			target: { kind: "resumable", handle: "scout", entry: rosterInput.resumable[0] },
			message: "what did you find",
		});
		assert.deepEqual(route("@worker implement this"), {
			kind: "spawn",
			agentName: "worker",
			task: "implement this",
		});
		assert.deepEqual(route("@agent-worker implement this"), {
			kind: "spawn",
			agentName: "worker",
			task: "implement this",
		});
	});

	it("passes everything else through to the main model", () => {
		assert.deepEqual(route("@reviewer"), { kind: "continue" });
		assert.deepEqual(route("hello @reviewer look"), { kind: "continue" });
		assert.deepEqual(route("@unknown go"), { kind: "continue" });
		assert.deepEqual(route("@reviewer look", { source: "extension" }), { kind: "continue" });
		assert.deepEqual(route("@reviewer look", { imageCount: 1 }), { kind: "continue" });
	});

	it("transforms @main with a message back to the main model", () => {
		assert.deepEqual(route("@main please continue"), { kind: "transform", text: "please continue" });
		assert.deepEqual(route("@main"), { kind: "continue" });
	});

	it("notifies one line per dispatch and retries a raced steer as resume", async () => {
		const notices: Array<{ message: string; type?: string }> = [];
		const ok = (text: string): AgentToolResult<Details> => ({
			content: [{ type: "text", text }],
			isError: false,
			details: { mode: "management", results: [] },
		});
		const fail = (text: string): AgentToolResult<Details> => ({
			content: [{ type: "text", text }],
			isError: true,
			details: { mode: "management", results: [] },
		});
		const actions: MentionRouteActions = {
			steer: async () => ok("Steering queued."),
			resume: async () => ok("Follow-up detached."),
			spawn: async () => ({ ...ok("Async run 'abc123' started."), runId: "abc123" }),
			notify: (message, type) => { notices.push({ message, type }); },
		};
		const decision = route("@reviewer look again");
		assert.equal(decision.kind, "steer");
		if (decision.kind === "steer") await executeMentionRoute(decision, actions);
		assert.deepEqual(notices, [{ message: "@reviewer — Steering queued.", type: "info" }]);

		notices.length = 0;
		const racing: MentionRouteActions = {
			...actions,
			steer: async () => fail("Async run 'run-1' is no longer running."),
		};
		if (decision.kind === "steer") await executeMentionRoute(decision, racing);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!.message, /finished mid-send/);
		assert.equal(notices[0]!.type, "info");

		notices.length = 0;
		const resumeDecision = route("@scout what did you find");
		assert.equal(resumeDecision.kind, "resume");
		if (resumeDecision.kind === "resume") await executeMentionRoute(resumeDecision, actions);
		assert.deepEqual(notices, [{ message: "@scout — Follow-up detached.", type: "info" }]);

		notices.length = 0;
		const spawnDecision = route("@worker implement this");
		assert.equal(spawnDecision.kind, "spawn");
		if (spawnDecision.kind === "spawn") await executeMentionRoute(spawnDecision, actions);
		assert.deepEqual(notices, [{ message: "@worker started as run abc123.", type: "info" }]);
	});
});
