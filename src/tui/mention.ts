/**
 * mention.ts — the `@handle` grammar for addressing a subagent from the prompt.
 *
 * Pure logic, no pi imports, unit-testable. Ported from Claude Code's grammar
 * (via tintinweb/pi-subagents) so the two behave identically:
 *
 *   - suggestions fire on `@` at the start of the input or after whitespace,
 *     followed by `[\w-]*` (so `@src/foo.ts` is a file, never an agent);
 *   - a send is recognized only at the START of the input, and only with a
 *     non-empty message after the handle. That is why a bare `@scout`
 *     goes to the main model rather than anywhere near the agent.
 *
 * A run's own identity is a UUID plus a description, neither of which is
 * typeable, so the handle is derived from the agent name. Colliding handles
 * are numbered (`scout`, `scout-2`), which is also what Claude Code's
 * `allocateName` does.
 */

/** Suggestion trigger: `@` at a token boundary plus the partial handle typed so far. */
export const MENTION_TRIGGER = /(^|[\s。、？！])@([\w-]*)$/;

/** Send grammar: leading `@handle`, then a non-empty message. */
const MENTION_SEND = /^@([\w-]+)\s+([\s\S]+)$/;

/**
 * Upper bound on a handle. Nothing here generates a name this long, but an
 * agent name can be arbitrary text, and an unbounded handle would wrap the
 * suggestion popup.
 */
const MAX_HANDLE_LENGTH = 64;

/**
 * Handles that address something other than a subagent, and so can never be
 * allocated to one. `main` routes to the main conversation instead.
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

/** Whether `@handle` names the main conversation rather than any subagent. */
export function isReservedHandle(handle: string): boolean {
	return RESERVED_HANDLES.has(handle.toLowerCase());
}

/** Slug of an agent name, restricted to the `[\w-]` the grammar allows. */
export function handleBase(name: string): string {
	const slug = name.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_HANDLE_LENGTH)
		.replace(/-+$/, "");
	return slug || "agent";
}

/**
 * `base`, else `base-2`, `base-3`, … — the first form that is neither `taken`
 * nor reserved. Callers pass one shared `taken` set covering live handles and
 * type-derived handles alike, so the two can never collide.
 */
export function assignHandle(base: string, taken: ReadonlySet<string>): string {
	let candidate = base;
	let index = 1;
	while (taken.has(candidate) || RESERVED_HANDLES.has(candidate)) {
		index++;
		candidate = `${base}-${index}`;
	}
	return candidate;
}

/**
 * Claude Code documents `@agent-<name>` as the form you type by hand when the
 * picker isn't involved. Accepted here as an exact synonym: the caller tries
 * the handle as written first, and only falls back to this when that finds
 * nothing. Returns undefined when the prefix is absent or is the whole handle.
 */
export function stripAgentPrefix(handle: string): string | undefined {
	const rest = /^agent-(.+)$/i.exec(handle)?.[1];
	return rest || undefined;
}

/**
 * Map a typed handle back to a registered agent name, so `@scout fix it`
 * reaches the scout agent even when no instance is running. `handleBase` is
 * the single source of truth in both directions.
 */
export function resolveHandleToType(handle: string, names: readonly string[]): string | undefined {
	const wanted = handle.toLowerCase();
	if (RESERVED_HANDLES.has(wanted)) return undefined;
	return names.find((name) => handleBase(name) === wanted);
}

/** Split a leading `@handle message` send; undefined when the text is not a send. */
export function parseMentionSend(text: string): { handle: string; message: string } | undefined {
	const match = MENTION_SEND.exec(text.trimStart());
	if (!match) return undefined;
	const message = match[2] ?? "";
	if (!message.trim()) return undefined;
	return { handle: match[1]!, message };
}

export type MentionLiveEntry = {
	runId: string;
	asyncDir: string;
	index?: number;
	agent: string;
	state: string;
};

/**
 * One thing `@` can address. Live agents sort earliest-launched first with
 * steerable (running/queued) ones ahead; agent types with no live instance
 * follow so `@scout` can start one. A type whose handle a live record already
 * holds is omitted — that name addresses the existing agent. Resumable
 * terminal runs sit between live agents and types so a handle keeps addressing
 * the same run after it finishes.
 */
export type MentionTarget =
	| { kind: "live"; handle: string; entry: MentionLiveEntry }
	| { kind: "resumable"; handle: string; entry: MentionLiveEntry }
	| { kind: "type"; handle: string; name: string; description: string };

export function buildMentionRoster(
	live: readonly MentionLiveEntry[],
	resumable: readonly MentionLiveEntry[] = [],
	types: readonly { name: string; description: string }[] = [],
): MentionTarget[] {
	const liveFirst = [...live].sort((a, b) => {
		const running = (entry: MentionLiveEntry) => entry.state === "running" || entry.state === "queued" ? 1 : 0;
		return running(b) - running(a);
	});
	const taken = new Set<string>();
	const targets: MentionTarget[] = [];
	for (const entry of liveFirst) {
		const handle = assignHandle(handleBase(entry.agent), taken);
		taken.add(handle.toLowerCase());
		targets.push({ kind: "live", handle, entry });
	}
	for (const entry of resumable) {
		const handle = assignHandle(handleBase(entry.agent), taken);
		taken.add(handle.toLowerCase());
		targets.push({ kind: "resumable", handle, entry });
	}
	for (const type of types) {
		const handle = handleBase(type.name);
		if (taken.has(handle)) continue;
		taken.add(handle);
		targets.push({ kind: "type", handle, name: type.name, description: type.description });
	}
	return targets;
}

/**
 * Find the roster target for a typed handle. Exact match first (case-insensitive),
 * then the `@agent-<name>` hand-typed synonym. The caller must have built the
 * roster from the same live/resumable/type inputs as completion so the two agree.
 */
export function resolveMentionTarget(roster: readonly MentionTarget[], handle: string): MentionTarget | undefined {
	const wanted = handle.toLowerCase();
	const exact = roster.find((target) => target.handle.toLowerCase() === wanted);
	if (exact) return exact;
	const stripped = stripAgentPrefix(handle)?.toLowerCase();
	if (!stripped) return undefined;
	return roster.find((target) => target.handle.toLowerCase() === stripped);
}

/**
 * Model-facing routing rules for `@handle` text that reaches the main model.
 * Known-handle sends are intercepted by the input handler and never arrive
 * here; what is left is unknown handles and bare handles.
 *
 * `MENTION_ROUTING_BLOCK` strips a stale block with the same lifecycle as the
 * advertised-agents block: when nothing is addressable the prompt returns to
 * exactly what the caller passed in.
 */
export const MENTION_ROUTING_BLOCK = /\n*<agent_mentions>\n[\s\S]*?\n<\/agent_mentions>/u;

export const MENTION_ROUTING_GUIDANCE = [
	"<agent_mentions>",
	"A leading `@handle` reaches you only when it matches nothing addressable, or has no message:",
	"- A bare `@handle` with no message, or `@main`, always stays with the main model.",
	"- An unknown `@handle` with a message: ask which agent was meant, or treat it as a plain request. Never invent a run id.",
	"- Known handles (live, resumable, advertised types) never reach you — they are dispatched before agent processing.",
	"</agent_mentions>",
].join("\n");
