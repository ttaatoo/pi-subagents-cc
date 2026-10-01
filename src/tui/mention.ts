/** Session-local @handle identities. Sorting never changes a handle's target. */
export const MENTION_TRIGGER = /(^|[\s。、？！])@([\w-]*)$/;
const MENTION_SEND = /^@([\w-]+)\s+([\s\S]+)$/;
const MAX_HANDLE_LENGTH = 64;
const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

export function isReservedHandle(handle: string): boolean {
	return RESERVED_HANDLES.has(handle.toLowerCase());
}

export function handleBase(name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, MAX_HANDLE_LENGTH).replace(/-+$/, "");
	return slug || "agent";
}

export function assignHandle(base: string, taken: ReadonlySet<string>): string {
	let candidate = base;
	let index = 1;
	while (taken.has(candidate) || isReservedHandle(candidate)) {
		const suffix = `-${++index}`;
		candidate = `${base.slice(0, MAX_HANDLE_LENGTH - suffix.length)}${suffix}`;
	}
	return candidate;
}

export function stripAgentPrefix(handle: string): string | undefined {
	return /^agent-(.+)$/i.exec(handle)?.[1] || undefined;
}

export function resolveHandleToType(handle: string, names: readonly string[]): string | undefined {
	const wanted = handle.toLowerCase();
	return isReservedHandle(wanted) ? undefined : names.find((name) => handleBase(name) === wanted);
}

export function parseMentionSend(text: string): { handle: string; message: string } | undefined {
	const match = MENTION_SEND.exec(text.trimStart());
	const message = match?.[2] ?? "";
	return match && message.trim() ? { handle: match[1]!, message } : undefined;
}

export type MentionLiveEntry = {
	source: "async" | "foreground";
	runId: string;
	index: number;
	agent: string;
	state: string;
};

export type MentionTarget =
	| { kind: "live" | "resumable" | "unavailable"; handle: string; entry: MentionLiveEntry }
	| { kind: "type"; handle: string; name: string; description: string };

export interface MentionRosterSnapshot {
	targets: readonly MentionTarget[];
	/** Includes retired handles so they cannot silently fall through to a new launch. */
	resolve(handle: string): MentionTarget | undefined;
}

/** One instance per extension session. Handles remain reserved until that session is replaced. */
export class MentionRoster {
	private readonly handles = new Map<string, string>();
	private readonly entries = new Map<string, MentionLiveEntry>();
	private readonly taken = new Set<string>();

	build(
		live: readonly MentionLiveEntry[],
		resumable: readonly MentionLiveEntry[],
		types: readonly { name: string; description: string }[],
		unavailable: readonly MentionLiveEntry[] = [],
	): MentionRosterSnapshot {
		const targets: MentionTarget[] = [];
		for (const [kind, entries] of [["live", live], ["resumable", resumable], ["unavailable", unavailable]] as const) {
			for (const entry of entries) {
				const key = JSON.stringify([entry.source, entry.runId, entry.index]);
				let handle = this.handles.get(key);
				if (!handle) {
					handle = assignHandle(handleBase(entry.agent), this.taken);
					this.handles.set(key, handle);
					this.taken.add(handle);
				}
				this.entries.set(handle, entry);
				targets.push({ kind, handle, entry });
			}
		}
		const typeHandles = new Set<string>();
		for (const type of types) {
			const handle = handleBase(type.name);
			if (isReservedHandle(handle) || this.taken.has(handle) || typeHandles.has(handle)) continue;
			typeHandles.add(handle);
			targets.push({ kind: "type", handle, name: type.name, description: type.description });
		}
		const current = new Map(targets.map((target) => [target.handle, target]));
		const exact = (handle: string): MentionTarget | undefined => {
			const target = current.get(handle);
			if (target) return target;
			const entry = this.entries.get(handle);
			return entry ? { kind: "unavailable", handle, entry } : undefined;
		};
		return {
			targets,
			resolve(handle) {
				const wanted = handle.toLowerCase();
				const target = exact(wanted);
				if (target) return target;
				const stripped = stripAgentPrefix(wanted);
				return stripped ? exact(stripped) : undefined;
			},
		};
	}
}

export const MENTION_ROUTING_BLOCK = /\n*<agent_mentions>\n[\s\S]*?\n<\/agent_mentions>/u;
export const MENTION_ROUTING_GUIDANCE = [
	"<agent_mentions>",
	"A leading @handle with a message is dispatched before agent processing when its target is known.",
	"- A bare @handle or @main stays with the main model; image and extension input is not rerouted.",
	"- Unknown handles: ask which agent was meant. Never invent a run id.",
	"- Dispatch failures and unavailable known handles are handled without replaying the request here.",
	"</agent_mentions>",
].join("\n");
