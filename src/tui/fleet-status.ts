import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { snapshotExternalRuns } from "../api/external-runs.ts";
import { formatModelThinking } from "../shared/formatters.ts";
import type { AsyncJobState, AsyncJobStep, FleetViewPlacement, SubagentState } from "../shared/types.ts";
import { isStaleExtensionContextError } from "../shared/extension-context.ts";

export const FLEET_STATUS_WIDGET_KEY = "subagent-fleet-status";

// Claude Code-style FleetView below the editor: `main` plus each active
// workflow run and subagent as a flat, navigable list. One row per agent;
// runs sit above their agents. Mirrors tintinweb/pi-subagents
// src/ui/fleet-list.ts: the roster is glanceable status only, detail lives in
// the inspector overlay. Progress numbers appear exactly once (here), never as
// a second copy of the async widget above.
/** Max agent rows shown at once; extras collapse into "more" indicators. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const REFRESH_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];

const FLEET_AGENT_IDENTITY_COLORS = [
	"mdLink",
	"mdHeading",
	"syntaxFunction",
	"syntaxKeyword",
	"syntaxNumber",
	"syntaxType",
	"syntaxVariable",
	"customMessageLabel",
	"toolTitle",
	"thinkingMedium",
	"thinkingHigh",
	"mdQuote",
	"bashMode",
	"userMessageText",
	"mdCode",
	"syntaxOperator",
] as const satisfies readonly Exclude<Parameters<Theme["fg"]>[0], "accent" | "success" | "error" | "warning" | "muted" | "dim">[];

export function fleetAgentIdentityColor(identity: string): (typeof FLEET_AGENT_IDENTITY_COLORS)[number] {
	let hash = 2166136261;
	for (let i = 0; i < identity.length; i++) {
		hash ^= identity.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return FLEET_AGENT_IDENTITY_COLORS[(hash >>> 0) % FLEET_AGENT_IDENTITY_COLORS.length]!;
}

type FleetStatusTui = {
	requestRender(): void;
};
type FleetStatusEntry = {
	key: string;
	parentKey?: string;
	agent: string;
	displayLabel?: string;
	modelThinking?: string;
	description?: string;
	startedAt: number;
	tokens: number;
	window?: number;
	state: string;
	external?: true;
};

type FleetRosterRow =
	| { kind: "workflow"; entry: FleetStatusEntry; children: FleetStatusEntry[] }
	| { kind: "agent"; entry: FleetStatusEntry };

export interface FleetStatusOptions {
	refreshMs?: number;
	placement?: FleetViewPlacement;
}

export function resolveFleetViewPlacement(value: unknown): FleetViewPlacement {
	return value === "aboveEditor" ? "aboveEditor" : "belowEditor";
}

export function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFleetTokens(count: number, window?: number, windowCount = 1): string {
	const compact = (value: number): string => value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}M`
		: value >= 1_000
			? `${(value / 1_000).toFixed(1)}k`
			: `${Math.max(0, Math.round(value))}`;
	return window !== undefined
		? `↓ ${compact(window)} ${windowCount > 1 ? "Σ windows" : "window"} · ${compact(count)} spent`
		: `↓ ${compact(count)} tokens`;
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const leftClamped = truncateToWidth(left, maxLeftWidth);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

function isActiveState(value: string): boolean {
	return value === "running" || value === "queued" || value === "pending";
}

function foregroundDescription(control: { parentWorkflowRunId?: string; workflowKey?: string }, description: string | undefined): string | undefined {
	if (!control.parentWorkflowRunId) return description;
	const workflow = `workflow child: ${control.parentWorkflowRunId}${control.workflowKey ? ` (${control.workflowKey})` : ""}`;
	return description ? `${workflow} · ${description}` : workflow;
}

function linkedWorkflowParentKey(parentWorkflowRunId: string | undefined, activeWorkflowKeys: ReadonlySet<string>): string | undefined {
	if (!parentWorkflowRunId) return undefined;
	const parentKey = `async:${parentWorkflowRunId}`;
	return activeWorkflowKeys.has(parentKey) ? parentKey : undefined;
}

export function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {
	const now = Date.now();
	const entries: FleetStatusEntry[] = [];
	const activeWorkflowKeys = new Set([...state.asyncJobs.values()]
		.filter((job) => job.mode === "workflow" && isActiveState(job.status))
		.map((job) => `async:${job.asyncId}`));
	for (const control of state.foregroundControls.values()) {
		const linkedParentKey = linkedWorkflowParentKey(control.parentWorkflowRunId, activeWorkflowKeys);
		if (control.activeChildren) {
			for (const child of [...control.activeChildren.values()].sort((left, right) => left.index - right.index)) {
				const modelThinking = formatModelThinking(child.model, child.thinking) || undefined;
				entries.push({
					key: `foreground-active:${control.runId}:${child.index}`,
					...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
					agent: child.agent,
					...(modelThinking ? { modelThinking } : {}),
					description: foregroundDescription(control, child.description),
					startedAt: child.startedAt,
					tokens: child.tokens ?? 0,
					...(child.window !== undefined ? { window: child.window } : {}),
					state: "running",
				});
			}
			continue;
		}
		const modelThinking = formatModelThinking(control.model, control.thinking) || undefined;
		entries.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
			agent: control.currentAgent ?? control.mode,
			...(modelThinking ? { modelThinking } : {}),
			description: foregroundDescription(control, control.description),
			startedAt: control.startedAt,
			tokens: control.tokens ?? 0,
			...(control.window !== undefined ? { window: control.window } : {}),
			state: "running",
		});
	}

	for (const job of state.asyncJobs.values()) {
		if (!isActiveState(job.status)) continue;
		const startedAt = job.startedAt ?? job.updatedAt ?? now;
		const linkedParentKey = linkedWorkflowParentKey(job.parentWorkflowRunId, activeWorkflowKeys);
		if (job.mode === "workflow") {
			entries.push({
				key: `async:${job.asyncId}`,
				...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
				agent: "workflow",
				description: job.description,
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
				...(job.totalTokens?.window !== undefined ? { window: job.totalTokens.window } : {}),
				state: job.status,
			});
			continue;
		}
		const steps: AsyncJobStep[] | undefined = job.steps?.length
			? job.steps
			: job.agents?.map((agent, index) => {
				const pending = job.status === "queued"
					|| (job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0));
				return { agent, index, status: pending ? "pending" : "running" };
			});
		if (!steps?.length) {
			entries.push({
				key: `async:${job.asyncId}`,
				...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
				agent: job.mode ?? "subagent",
				description: job.description,
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
				...(job.totalTokens?.window !== undefined ? { window: job.totalTokens.window } : {}),
				state: job.status,
			});
			continue;
		}
		for (const [offset, step] of steps.entries()) {
			if (!isActiveState(step.status)) continue;
			const index = step.index ?? offset;
			if (step.status === "pending" && job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0)) continue;
			const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
			entries.push({
				key: `async:${job.asyncId}:${index}`,
				...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
				agent: step.agent,
				...(step.label ? { displayLabel: `${step.label} (${step.agent})` } : {}),
				...(modelThinking ? { modelThinking } : {}),
				description: step.description ?? job.description,
				startedAt: step.startedAt ?? startedAt,
				tokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),
				...((step.tokens?.window ?? (steps.length === 1 ? job.totalTokens?.window : undefined)) !== undefined
					? { window: step.tokens?.window ?? job.totalTokens?.window }
					: {}),
				state: step.status,
			});
		}
	}

	if (state.currentSessionId) {
		try {
			for (const run of snapshotExternalRuns(state.currentSessionId, { ignoreMalformed: true, onMalformedRecord: (message) => console.warn(`[pi-subagents] Removed ${message}`) })) {
				if (!isActiveState(run.state)) continue;
				entries.push({
					key: `external:${run.id}`,
					agent: `external · ${run.label}`,
					description: run.currentAction ?? `source: ${run.source}`,
					startedAt: run.startedAt,
					tokens: 0,
					state: run.state,
					external: true,
				});
			}
		} catch (cause) {
			console.warn(`[pi-subagents] Failed to inspect external jobs: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	return entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
}

export class SubagentFleetStatus {
	private ctx: ExtensionContext | undefined;
	private ui: ExtensionContext["ui"] | undefined;
	private tui: FleetStatusTui | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	/** Whether arrow keys currently navigate the list (vs. flow to the editor). */
	private active = false;
	/** 0 = `main`, 1..N = roster rows. */
	private selectedIndex = 0;
	private inspectorOpen = false;
	private lastRenderKey = "";
	private entries: FleetStatusEntry[] = [];
	private readonly state: SubagentState;
	private readonly openInspector: (itemKey: string) => Promise<void> | void;
	private readonly refreshMs: number;
	private readonly placement: FleetViewPlacement;

	constructor(
		state: SubagentState,
		openInspector: (itemKey: string) => Promise<void> | void,
		options: FleetStatusOptions = {},
	) {
		this.state = state;
		this.openInspector = openInspector;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.placement = options.placement ?? "belowEditor";
	}

	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			this.clearUiRegistration();
			return;
		}
		const ui = ctx.ui;
		if (this.ui === ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.clearUiRegistration();
		this.ctx = ctx;
		this.ui = ui;
		if (typeof ui.onTerminalInput === "function") {
			this.inputUnsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
		}
		this.ensureTimer();
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
		this.ui = undefined;
		this.entries = [];
		this.active = false;
		this.selectedIndex = 0;
		this.inspectorOpen = false;
		this.lastRenderKey = "";
	}

	private ensureTimer(): void {
		if (this.timer || !this.ui) return;
		this.timer = setInterval(() => this.refresh(), this.refreshMs);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	refresh(): void {
		const ctx = this.getActiveUiContext();
		if (!ctx) return;
		if (this.state.widgetsSuspended) {
			this.clearWidget();
			return;
		}
		this.entries = collectFleetStatusEntries(this.state);
		this.clampSelection();
		if (this.inspectorOpen || this.state.fleetInspectorOpen) {
			this.lastRenderKey = "";
			this.clearWidget();
			return;
		}
		if (!this.hasInlineSurface()) {
			this.active = false;
			this.selectedIndex = 0;
			this.lastRenderKey = "";
			this.clearWidget();
			// Nothing to show: stop the tick. The next setContext (tool_result
			// or session start) and any refresh with live entries restart it.
			this.stopTimer();
			return;
		}
		this.ensureTimer();

		const renderKey = this.getRenderKey();
		if (!this.widgetRegistered) {
			ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {
						this.lastRenderKey = "";
					},
					dispose: () => {
						if (this.tui !== tui) return;
						this.widgetRegistered = false;
						this.tui = undefined;
					},
				};
			}, { placement: this.placement });
			this.widgetRegistered = true;
			this.lastRenderKey = renderKey;
			return;
		}
		if (renderKey === this.lastRenderKey) {
			// Repaint anyway while anything is running so the wall-clock
			// elapsed ticks between state changes.
			if (this.entries.some((entry) => entry.state === "running")) this.tui?.requestRender();
			return;
		}
		this.lastRenderKey = renderKey;
		this.tui?.requestRender();
	}

	/** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (this.state.widgetsSuspended) return undefined;
		const ctx = this.getActiveUiContext();
		if (!ctx || this.entries.length === 0 || isKeyRelease(data)) return undefined;
		if (this.inspectorOpen) return undefined;
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}

		if (!this.active) {
			// Activate: ↓ or ← at an empty prompt moves focus into the list.
			const activates = matchesKey(data, "down") || matchesKey(data, "left");
			if (!activates || ctx.ui.getEditorText() !== "") return undefined;
			this.active = true;
			this.selectedIndex = 0;
			this.refresh();
			return { consume: true };
		}

		// Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
		const max = this.rosterRows().length;
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(max, this.selectedIndex + 1);
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedIndex -= 1;
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			this.openSelected(ctx);
			return { consume: true };
		}

		// Any other key cancels navigation and flows to the editor.
		this.deactivate();
		return undefined;
	}

	render(width: number, theme: Theme): string[] {
		if (!this.hasInlineSurface() || this.state.widgetsSuspended || this.inspectorOpen || this.state.fleetInspectorOpen) {
			return [];
		}
		return this.renderBar(width, theme);
	}

	private renderBar(width: number, theme: Theme): string[] {
		const rows = this.rosterRows();
		if (rows.length === 0) return [];
		// Clamp locally so a render between a roster shrink and the next refresh
		// never loses the selection marker.
		const sel = Math.min(this.selectedIndex, rows.length);

		const hint = this.active
			? "↑↓ select · enter view · esc back"
			: "esc to interrupt · ← for agents · ↓ to manage";
		const lines: string[] = [];
		lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
		lines.push("");
		lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

		// Window the rows so the selected one stays visible.
		const visible = Math.min(MAX_AGENT_ROWS, rows.length);
		const selRow = Math.max(0, sel - 1);
		const start = selRow < visible ? 0 : selRow - visible + 1;
		const hiddenBelow = rows.length - (start + visible);

		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let a = start; a < start + visible; a++) {
			const row = rows[a]!;
			lines.push(
				row.kind === "workflow"
					? this.renderWorkflowRow(a + 1, sel, row, width, theme)
					: this.renderAgentRow(a + 1, sel, row.entry, width, theme),
			);
		}
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

		return lines;
	}

	private bullet(rosterIndex: number, sel: number, theme: Theme): string {
		return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
	}

	/**
	 * A run's row. Shaped like an agent's — bullet, kind, name, stats flush
	 * right — so the two read as one list, with the agent count where an agent
	 * has its description and the same elapsed/token tail. Lane-level detail
	 * (checklist, bottleneck, steps) lives in the inspector, never here.
	 */
	private renderWorkflowRow(
		rosterIndex: number,
		sel: number,
		row: Extract<FleetRosterRow, { kind: "workflow" }>,
		width: number,
		theme: Theme,
	): string {
		const name = row.entry.description ?? row.entry.displayLabel ?? row.entry.agent;
		const left = `  ${this.bullet(rosterIndex, sel, theme)} ${theme.fg("muted", "workflow")}  ${name}`;
		const elapsed = formatFleetElapsed(Date.now() - row.entry.startedAt);
		// The run's own token counter only sees orchestration spend; the parts
		// live on the child rows below, so the tail sums the children into the
		// one run total instead of gesturing at them.
		const tokens = row.children.reduce((total, child) => total + child.tokens, 0);
		const windows = row.children.map((child) => child.window).filter((window): window is number => window !== undefined);
		const stats = `${row.children.length} agent${row.children.length === 1 ? "" : "s"} · ${elapsed} · ${formatFleetTokens(tokens, windows.length ? windows.reduce((a, b) => a + b, 0) : undefined, Math.max(1, windows.length))}`;
		return rightAlign(left, theme.fg("dim", stats), width);
	}

	private renderAgentRow(rosterIndex: number, sel: number, entry: FleetStatusEntry, width: number, theme: Theme): string {
		// No per-row state word: the list only holds live work, and the elapsed
		// clock ticking on the right already says so. Truncation therefore eats
		// the identity/description first and can never produce "run...".
		const label = entry.displayLabel ?? entry.agent;
		const name = theme.fg(fleetAgentIdentityColor(entry.agent), label);
		const left = entry.description
			? `  ${this.bullet(rosterIndex, sel, theme)} ${name}  ${theme.fg("dim", entry.description)}`
			: `  ${this.bullet(rosterIndex, sel, theme)} ${name}`;
		const elapsed = formatFleetElapsed(Date.now() - entry.startedAt);
		const right = entry.external
			? theme.fg("dim", elapsed)
			: theme.fg("dim", `${elapsed} · ${formatFleetTokens(entry.tokens, entry.window)}`);
		return rightAlign(left, right, width);
	}

	/**
	 * Runs sit above the agents rather than interleaved by start time: a run owns
	 * most of the agents under it, so listing the container first is what makes
	 * the list read as a hierarchy rather than a shuffle.
	 */
	private rosterRows(): FleetRosterRow[] {
		const childrenByParent = new Map<string, FleetStatusEntry[]>();
		for (const entry of this.entries) {
			if (!entry.parentKey) continue;
			const children = childrenByParent.get(entry.parentKey) ?? [];
			children.push(entry);
			childrenByParent.set(entry.parentKey, children);
		}
		const workflows: FleetRosterRow[] = [];
		const agents: FleetRosterRow[] = [];
		for (const entry of this.entries) {
			const children = childrenByParent.get(entry.key);
			if (children?.length) workflows.push({ kind: "workflow", entry, children });
			else agents.push({ kind: "agent", entry });
		}
		return [...workflows, ...agents];
	}

	private clampSelection(): void {
		const max = this.rosterRows().length;
		if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	private openSelected(ctx: ExtensionContext): void {
	 // `main` = return to the prompt; the native transcript is already shown.
		if (this.selectedIndex === 0) {
			this.deactivate();
			return;
		}
		const row = this.rosterRows()[this.selectedIndex - 1];
		if (!row) {
			this.deactivate();
			return;
		}
		this.openSelectedInspector(ctx, row.entry.key);
	}

	private openSelectedInspector(ctx: ExtensionContext, itemKey: string): void {
		this.inspectorOpen = true;
		this.refresh();
		void Promise.resolve()
			.then(() => this.openInspector(itemKey))
			.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
			.finally(() => {
				this.inspectorOpen = false;
				this.refresh();
			});
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.refresh();
	}

	private editorHasFocus(): boolean {
		// pi-tui exposes focus mutation but no focus getter, so inspect the focused
		// component structurally. instanceof is unreliable across jiti module boundaries.
		const focused = (this.tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (!focused || typeof focused !== "object") return false;
		const candidate = focused as Partial<EditorComponent>;
		return typeof candidate.render === "function"
			&& typeof candidate.invalidate === "function"
			&& typeof candidate.handleInput === "function"
			&& typeof candidate.getText === "function"
			&& typeof candidate.setText === "function";
	}

	private getActiveUiContext(): ExtensionContext | undefined {
		const ctx = this.ctx;
		if (!ctx) return undefined;
		try {
			return ctx.hasUI ? ctx : undefined;
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			this.clearUiRegistration();
			return undefined;
		}
	}

	private hasInlineSurface(): boolean {
		return this.entries.length > 0;
	}

	private getRenderKey(): string {
		const now = Date.now();
		return JSON.stringify({
			active: this.active,
			selected: this.selectedIndex,
			inspectorOpen: this.inspectorOpen,
			entries: this.entries.map((entry) => [
				entry.key,
				entry.parentKey,
				entry.agent,
				entry.displayLabel,
				entry.description,
				entry.state,
				entry.tokens,
				entry.window,
				Math.round((now - entry.startedAt) / 1000),
			]),
		});
	}

	private clearWidget(): void {
		if (!this.widgetRegistered) return;
		try {
			this.ui?.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			this.clearUiRegistration();
			return;
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private clearUiRegistration(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;

		const inputUnsubscribe = this.inputUnsubscribe;
		const ui = this.ui;
		const widgetRegistered = this.widgetRegistered;
		this.inputUnsubscribe = undefined;
		this.ctx = undefined;
		this.ui = undefined;
		this.widgetRegistered = false;
		this.tui = undefined;

		const cleanupErrors: unknown[] = [];
		try {
			inputUnsubscribe?.();
		} catch (error) {
			if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
		}
		if (ui && widgetRegistered) {
			try {
				ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) {
			throw new AggregateError(cleanupErrors, "Failed to clean up FleetView UI registration");
		}
	}
}
