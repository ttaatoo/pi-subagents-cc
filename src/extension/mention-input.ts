import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";
import { isReservedHandle, parseMentionSend, type MentionLiveEntry, type MentionRosterSnapshot, type MentionTarget } from "../tui/mention.ts";

export type MentionRouteInput = {
	text: string;
	source: "interactive" | "rpc" | "extension";
	imageCount: number;
};

export type MentionRouteDecision =
	| { kind: "continue" }
	| { kind: "transform"; text: string }
	| { kind: "steer" | "resume" | "blocked"; target: Exclude<MentionTarget, { kind: "type" }>; message: string }
	| { kind: "spawn"; agentName: string; task: string };

export function routeMentionInput(input: MentionRouteInput, roster: MentionRosterSnapshot): MentionRouteDecision {
	if (input.source === "extension" || input.imageCount > 0) return { kind: "continue" };
	const send = parseMentionSend(input.text);
	if (!send) return { kind: "continue" };
	if (isReservedHandle(send.handle)) return { kind: "transform", text: send.message.trim() };
	const target = roster.resolve(send.handle);
	if (!target) return { kind: "continue" };
	if (target.kind === "type") return { kind: "spawn", agentName: target.name, task: send.message };
	return { kind: target.kind === "live" ? "steer" : target.kind === "resumable" ? "resume" : "blocked", target, message: send.message };
}

export type MentionRouteActions = {
	steer: (entry: MentionLiveEntry, message: string) => Promise<AgentToolResult<Details>>;
	resume: (entry: MentionLiveEntry, message: string) => Promise<AgentToolResult<Details>>;
	spawn: (agentName: string, task: string) => Promise<AgentToolResult<Details> & { runId?: string }>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
};

/** A known-handle input is always consumed, even when execution or notification fails. */
export async function executeMentionRoute(
	decision: Exclude<MentionRouteDecision, { kind: "continue" } | { kind: "transform" }>,
	actions: MentionRouteActions,
): Promise<{ action: "handled" }> {
	const label = decision.kind === "spawn" ? `@${decision.agentName}` : `@${decision.target.handle}`;
	const notify = (message: string, type: "info" | "error") => {
		try { actions.notify(message, type); }
		catch { console.error("[pi-subagents-cc] @mention notification failed; input remains handled. Inspect run status before retrying."); }
	};
	if (decision.kind === "blocked") {
		notify(`${label} cannot control run ${decision.target.entry.runId} child ${decision.target.entry.index}. Inspect it through Fleet/status; no message or replacement was sent.`, "error");
		return { action: "handled" };
	}
	try {
		const result = decision.kind === "spawn" ? await actions.spawn(decision.agentName, decision.task)
			: decision.kind === "steer" ? await actions.steer(decision.target.entry, decision.message)
				: await actions.resume(decision.target.entry, decision.message);
		const text = (result.content.find((item) => item.type === "text")?.text.trim().split("\n")[0] || "Inspect run status for the outcome.").slice(0, 200);
		const runId = "runId" in result && typeof result.runId === "string" ? result.runId : result.details.asyncId;
		notify(decision.kind === "spawn" && !result.isError && runId ? `${label} started as run ${runId}.` : `${label} — ${text}`, result.isError ? "error" : "info");
	} catch (error) {
		const target = decision.kind === "spawn" ? decision.agentName : `run ${decision.target.entry.runId} child ${decision.target.entry.index}`;
		notify(`${label} dispatch failed; outcome may be unknown for ${target}. Inspect Fleet/status before retrying. No automatic resume or main-model replay. ${String(error instanceof Error ? error.message : error).slice(0, 200)}`, "error");
	}
	return { action: "handled" };
}
