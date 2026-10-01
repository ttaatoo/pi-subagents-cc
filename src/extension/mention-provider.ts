import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../shared/types.ts";
import { MENTION_TRIGGER, MentionRoster, type MentionLiveEntry, type MentionRosterSnapshot } from "../tui/mention.ts";

const MAX_MENTION_SUGGESTIONS = 8;
const rosters = new WeakMap<SubagentState, { sessionId: string | null | undefined; roster: MentionRoster }>();

export interface MentionAgentInfo {
	name: string;
	description: string;
	advertise?: boolean;
	disabled?: boolean;
}

export interface MentionProviderDeps {
	state: SubagentState;
	getAdvertisedAgents: () => ReadonlyArray<MentionAgentInfo>;
}

/** Memory-only projection; execution still performs authoritative ownership and capability checks. */
export function collectMentionRoster(state: SubagentState, agents: ReadonlyArray<MentionAgentInfo>): MentionRosterSnapshot {
	let cached = rosters.get(state);
	if (!cached || cached.sessionId !== state.currentSessionId) {
		cached = { sessionId: state.currentSessionId, roster: new MentionRoster() };
		rosters.set(state, cached);
	}
	const live: MentionLiveEntry[] = [], resumable: MentionLiveEntry[] = [], unavailable: MentionLiveEntry[] = [];
	const sameSession = (id: string | undefined) => Boolean(state.currentSessionId && id === state.currentSessionId);
	for (const job of state.asyncJobs.values()) {
		if (!sameSession(job.sessionId) || job.mode === "workflow") continue;
		const steps = job.steps?.length ? job.steps : (job.agents?.length === 1
			? [{ agent: job.agents[0]!, status: job.status, index: 0 }]
			: []);
		for (const [offset, step] of steps.entries()) {
			const entry: MentionLiveEntry = { source: "async", runId: job.asyncId, index: step.index ?? offset, agent: step.agent, state: step.status };
			const native = !("runner" in step && step.runner) && !("externalJob" in step && step.externalJob) && !("externalProcess" in step && step.externalProcess);
			const active = (job.status === "running" || job.status === "queued") && (step.status === "running" || step.status === "pending");
			const terminal = ["complete", "completed", "failed", "partial", "paused"].includes(step.status);
			const sessionFile = ("sessionFile" in step && step.sessionFile) || (steps.length === 1 && job.sessionFile);
			if (native && active && !job.stopped) live.push(entry);
			else if (native && terminal && sessionFile && job.status !== "stopped" && !job.stopped && !job.parentWorkflowRunId
				&& job.status !== "running" && job.status !== "queued") resumable.push(entry);
			else unavailable.push(entry);
		}
	}
	// The public steer action supports exact workflow-owned foreground children.
	// Ordinary foreground and external work remain controllable through Fleet, not a guessed mention route.
	for (const control of state.foregroundControls?.values() ?? []) {
		if (!sameSession(control.sessionId) || !control.parentWorkflowRunId || !state.workflowControllers?.has(control.parentWorkflowRunId)) continue;
		for (const child of control.activeChildren?.values() ?? []) {
			if (child.steer) live.push({ source: "foreground", runId: control.runId, index: child.index, agent: child.agent, state: "running" });
		}
	}
	return cached.roster.build(live, resumable, agents.filter((agent) => agent.advertise === true && !agent.disabled), unavailable);
}

export function createMentionAutocompleteProvider(current: AutocompleteProvider, deps: MentionProviderDeps): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const match = MENTION_TRIGGER.exec((lines[cursorLine] ?? "").slice(0, cursorCol));
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const token = (match[2] ?? "").toLowerCase();
			// Preserve the host's file picker, including a file whose name is an agent handle.
			const files = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return null;
			const roster = collectMentionRoster(deps.state, deps.getAdvertisedAgents()).targets
				.filter((target) => target.kind !== "unavailable" && target.handle.startsWith(token))
				.slice(0, MAX_MENTION_SUGGESTIONS);
			if (!roster.length) return files;
			const prefix = `@${match[2] ?? ""}`;
			// Different replacement spans cannot be safely merged. Keep real file results.
			if (files?.items.length && files.prefix !== prefix) return files;
			const items = files?.items.slice() ?? [];
			for (const target of roster) {
				if (items.some((item) => item.value === `@${target.handle}`)) continue;
				items.push({
					value: `@${target.handle}`, label: `@${target.handle}`,
					description: target.kind === "type" ? `start ${target.name} — ${target.description}`
						: `${target.entry.agent} · ${target.entry.state} — ${target.kind === "resumable" ? "resume" : "message"} run ${target.entry.runId} child ${target.entry.index}`,
				});
			}
			return { items, prefix };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function installMentionAutocomplete(ctx: Pick<ExtensionContext, "hasUI" | "ui">, deps: MentionProviderDeps): void {
	if (ctx.hasUI) ctx.ui.addAutocompleteProvider?.((current) => createMentionAutocompleteProvider(current, deps));
}
