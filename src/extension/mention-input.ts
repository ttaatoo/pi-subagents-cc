import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";
import {
	buildMentionRoster,
	isReservedHandle,
	parseMentionSend,
	resolveMentionTarget,
	type MentionLiveEntry,
	type MentionTarget,
} from "../tui/mention.ts";

export type MentionRouteInput = {
	text: string;
	/** Where the input came from. Extension-sourced input is never rerouted. */
	source: "interactive" | "rpc" | "extension";
	imageCount: number;
};

export type MentionRosterInput = {
	live: readonly MentionLiveEntry[];
	resumable: readonly MentionLiveEntry[];
	types: readonly { name: string; description: string }[];
};

export type MentionRouteDecision =
	| { kind: "continue" }
	| { kind: "transform"; text: string }
	| { kind: "steer"; target: MentionTarget & { kind: "live" }; message: string }
	| { kind: "resume"; target: MentionTarget & { kind: "resumable" }; message: string }
	| { kind: "spawn"; agentName: string; task: string };

/**
 * Pure routing for a leading `@handle message` send. Returns `continue` for
 * everything that must reach the main model: non-interactive plumbing,
 * inputs with images (steer is text-only), bare handles, `@main`, and unknown
 * handles. Known handles resolve against the SAME roster inputs as completion
 * so the popup and the router never disagree.
 */
export function routeMentionInput(input: MentionRouteInput, rosterInput: MentionRosterInput): MentionRouteDecision {
	if (input.source === "extension") return { kind: "continue" };
	if (input.imageCount > 0) return { kind: "continue" };
	const send = parseMentionSend(input.text);
	if (!send) return { kind: "continue" };
	if (isReservedHandle(send.handle)) {
		const rest = send.message.trim();
		if (!rest) return { kind: "continue" };
		return { kind: "transform", text: rest };
	}
	const roster = buildMentionRoster(rosterInput.live, rosterInput.resumable, rosterInput.types);
	const target = resolveMentionTarget(roster, send.handle);
	if (!target) return { kind: "continue" };
	if (target.kind === "live") return { kind: "steer", target, message: send.message };
	if (target.kind === "resumable") return { kind: "resume", target, message: send.message };
	return { kind: "spawn", agentName: target.name, task: send.message };
}

export type MentionRouteActions = {
	steer: (entry: MentionLiveEntry, message: string) => Promise<AgentToolResult<Details>>;
	resume: (entry: MentionLiveEntry, message: string) => Promise<AgentToolResult<Details>>;
	spawn: (agentName: string, task: string) => Promise<AgentToolResult<Details> & { runId?: string }>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
};

function resultText(result: AgentToolResult<Details> | null, fallback: string) {
	const text = result?.content.find((item) => item.type === "text")?.text.trim() || fallback;
	const [firstLine] = text.split("\n");
	const bounded = (firstLine ?? text).slice(0, 200);
	return { text: bounded, isError: result?.isError === true };
}

/**
 * Execute a non-continue decision and report back in one user-visible line.
 * A steer that fails because the child raced to completion retries once as a
 * resume with the same message, so the message is never silently dropped.
 */
export async function executeMentionRoute(
	decision: Exclude<MentionRouteDecision, { kind: "continue" } | { kind: "transform" }>,
	actions: MentionRouteActions,
): Promise<void> {
	if (decision.kind === "steer") {
		const steered = resultText(await actions.steer(decision.target.entry, decision.message), "Steering failed.");
		if (!steered.isError) {
			actions.notify(`@${decision.target.handle} — ${steered.text}`, "info");
			return;
		}
		const resumed = resultText(await actions.resume(decision.target.entry, decision.message), "Resume failed.");
		actions.notify(
			resumed.isError
				? `@${decision.target.handle} — steer failed (${steered.text}); resume failed (${resumed.text})`
				: `@${decision.target.handle} — finished mid-send; resumed: ${resumed.text}`,
			resumed.isError ? "error" : "info",
		);
		return;
	}
	if (decision.kind === "resume") {
		const resumed = resultText(await actions.resume(decision.target.entry, decision.message), "Resume failed.");
		actions.notify(`@${decision.target.handle} — ${resumed.text}`, resumed.isError ? "error" : "info");
		return;
	}
	const spawned = await actions.spawn(decision.agentName, decision.task);
	const runId = spawned.runId ?? /run\s+([A-Za-z0-9_-]+)/.exec(resultText(spawned, "").text)?.[1];
	const outcome = resultText(spawned, "Launch failed.");
	actions.notify(
		outcome.isError ? `@${decision.agentName} — ${outcome.text}` : `@${decision.agentName} started${runId ? ` as run ${runId}` : ""}.`,
		outcome.isError ? "error" : "info",
	);
}
