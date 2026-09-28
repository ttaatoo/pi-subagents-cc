import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../shared/types.ts";
import type { MentionRosterInput } from "./mention-input.ts";
import { MENTION_TRIGGER, buildMentionRoster, type MentionLiveEntry } from "../tui/mention.ts";

const MAX_MENTION_SUGGESTIONS = 8;

export interface MentionAgentInfo {
	name: string;
	description: string;
	advertise?: boolean;
	disabled?: boolean;
}

export interface MentionProviderDeps {
	state: SubagentState;
	/** Minimal agent shape — the roster only reads name/description/advertise/disabled. */
	getAdvertisedAgents: () => ReadonlyArray<MentionAgentInfo>;
}

function jobAgentLabel(job: { agents?: string[]; steps?: Array<{ agent: string }>; mode?: string }): string {
	return job.agents?.[0] ?? job.steps?.[0]?.agent ?? job.mode ?? "agent";
}

function jobEntryForMention(job: { asyncId: string; asyncDir: string; status: string; agents?: string[]; steps?: Array<{ agent: string; index?: number }>; mode?: string }): MentionLiveEntry {
	const entry: MentionLiveEntry = {
		runId: job.asyncId,
		asyncDir: job.asyncDir,
		agent: jobAgentLabel(job),
		state: job.status,
	};
	const stepIndex = job.steps?.[0]?.index;
	if (stepIndex !== undefined) entry.index = stepIndex;
	return entry;
}

function sameSession(state: SubagentState, jobSessionId: string | undefined): boolean {
	return !state.currentSessionId || !jobSessionId || jobSessionId === state.currentSessionId;
}

function liveEntriesForMention(state: SubagentState): MentionLiveEntry[] {
	const entries: MentionLiveEntry[] = [];
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running" && job.status !== "queued") continue;
		if (!sameSession(state, job.sessionId)) continue;
		entries.push(jobEntryForMention(job));
	}
	return entries;
}

/**
 * Terminal direct children the input router may resume. In-memory only (no
 * filesystem scan): workflow owners resume through their workflow, so only
 * non-workflow runs are candidates — resume still checks eligibility
 * authoritatively and may reject.
 */
export function resumableEntriesForMention(state: SubagentState): MentionLiveEntry[] {
	const entries: MentionLiveEntry[] = [];
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused" && job.status !== "stopped") continue;
		if (job.mode === "workflow" || job.parentWorkflowRunId) continue;
		if (!sameSession(state, job.sessionId)) continue;
		entries.push(jobEntryForMention(job));
	}
	return entries;
}

/**
 * The single source of roster inputs for completion AND the input router.
 * Both read the same live/resumable/type lists so the popup and the
 * dispatcher never disagree about what a handle addresses.
 */
export function collectMentionRosterInput(state: SubagentState, agents: ReadonlyArray<MentionAgentInfo>): MentionRosterInput {
	return {
		live: liveEntriesForMention(state),
		resumable: resumableEntriesForMention(state),
		types: agents
			.filter((agent) => agent.advertise === true && agent.disabled !== true)
			.map((agent) => ({ name: agent.name, description: agent.description })),
	};
}

export function createMentionAutocompleteProvider(
	current: AutocompleteProvider,
	deps: MentionProviderDeps,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const match = MENTION_TRIGGER.exec(currentLine.slice(0, cursorCol));
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const token = (match[2] ?? "").toLowerCase();
			const rosterInput = collectMentionRosterInput(deps.state, deps.getAdvertisedAgents());
			const roster = buildMentionRoster(rosterInput.live, rosterInput.resumable, rosterInput.types)
				.filter((target) => target.handle.toLowerCase().startsWith(token))
				.slice(0, MAX_MENTION_SUGGESTIONS);
			if (options.signal.aborted || roster.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
		}
			return {
				items: roster.map((target) => target.kind === "live"
					? {
						value: `@${target.handle}`,
						label: `@${target.handle}`,
						description: `${target.entry.agent} · ${target.entry.state} — message without restarting`,
					}
					: target.kind === "resumable"
						? {
							value: `@${target.handle}`,
							label: `@${target.handle}`,
							description: `${target.entry.agent} · ${target.entry.state} — resume with message`,
						}
						: {
							value: `@${target.handle}`,
							label: `@${target.handle}`,
							description: `start ${target.name} — ${target.description}`,
						}),
				prefix: `@${match[2] ?? ""}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/**
 * Wire the `@handle` completion provider for one session. Call from the
 * existing `session_start` handler (not as a new `pi.on` registration) so the
 * handler count observed by lifecycle tests stays stable. Additive: `@` stays
 * pi's file picker first — agent rows are offered only when a handle token
 * matches, and everything else falls through to the wrapped provider untouched.
 */
export function installMentionAutocomplete(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	deps: MentionProviderDeps,
): void {
	if (!ctx.hasUI) return;
	// Older hosts predate addAutocompleteProvider; optional chaining keeps this
	// a no-op there instead of a crash.
	ctx.ui.addAutocompleteProvider?.((current) => createMentionAutocompleteProvider(current, deps));
}
