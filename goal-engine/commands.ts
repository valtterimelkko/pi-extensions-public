/**
 * Goal Engine — Commands
 *
 * Registers the /goal command and its subcommands with Pi.
 *
 * All state operations are session-scoped: each command handler derives
 * per-session getState/setState/saveState from the ExtensionCommandContext.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isActive, loadSessionDiskGoalState, DEFAULT_MAX_TURNS, findMostRecentGoal, type GoalState } from "./state.js";
import {
	formatGoalReport,
	hideGoalStatusWidget,
	isGoalStatusWidgetVisible,
	showGoalStatusWidget,
	toggleGoalStatusWidget,
} from "./status-ui.js";

export type SaveGoalState = (gs: GoalState) => void;

export interface CommandSessionDeps {
	getState: () => GoalState;
	setState: (gs: GoalState) => void;
	saveState: SaveGoalState;
	clearState: () => GoalState;
	resetErrors: () => void;
}

export type CommandResolver = (ctx: ExtensionCommandContext) => CommandSessionDeps;

interface GoalStartOptions {
	objective: string;
	verifyCommand: string | null;
	maxTurns: number | null;
}

/**
 * Register all goal-engine commands.
 */
export function registerCommands(
	pi: ExtensionAPI,
	resolve: CommandResolver,
): void {
	// ═══════════════════════════════════════════════════════
	// /goal [objective]
	// ═══════════════════════════════════════════════════════
	pi.registerCommand("goal", {
		description:
			"Define and start an autonomous goal. Subcommands: pause, pause-now, resume, resume-last, clear, status, report, limit.",
		handler: async (args, ctx) => {
			const input = parseGoalCommandInput(args);

			if (!input) {
				const { getState } = resolve(ctx);
				await showGoalStatus(getState(), ctx, "toggle");
				return;
			}

			const { subcommand, rest } = splitSubcommand(input);
			switch (subcommand) {
				case "pause":
					await pauseGoal(resolve(ctx), ctx);
					return;
				case "pause-now":
					await pauseNowGoal(resolve(ctx), ctx);
					return;
				case "resume":
					await resumeGoal(resolve(ctx), pi, ctx);
					return;
				case "resume-last":
					await resumeLastGoal(resolve(ctx), pi, ctx);
					return;
				case "clear":
					await clearGoal(resolve(ctx), ctx);
					return;
				case "status":
					{ const { getState } = resolve(ctx);
					await showGoalStatus(getState(), ctx, parseStatusMode(rest)); }
					return;
				case "report":
					{ const { getState } = resolve(ctx);
					showGoalReport(getState(), ctx); }
					return;
				case "list":
					showGoalList(ctx);
					return;
				case "limit":
					await setGoalLimit(rest, resolve(ctx), ctx);
					return;
			}

			const startOptions = parseGoalStartOptions(input);
			await startGoal(startOptions, resolve(ctx), pi, ctx);
		},
	});

	// ═══════════════════════════════════════════════════════
	// Convenience subcommands as separate commands
	// ═══════════════════════════════════════════════════════

	pi.registerCommand("goal-pause", {
		description: "Pause the active goal (wraps up current turn)",
		handler: async (_args, ctx) => {
			await pauseGoal(resolve(ctx), ctx);
		},
	});

	pi.registerCommand("goal-pause-now", {
		description: "Immediately pause the active goal and abort the current run",
		handler: async (_args, ctx) => {
			await pauseNowGoal(resolve(ctx), ctx);
		},
	});

	pi.registerCommand("goal-resume", {
		description: "Resume a paused goal",
		handler: async (_args, ctx) => {
			await resumeGoal(resolve(ctx), pi, ctx);
		},
	});

	pi.registerCommand("goal-clear", {
		description: "Clear the current goal",
		handler: async (_args, ctx) => {
			await clearGoal(resolve(ctx), ctx);
		},
	});

	pi.registerCommand("goal-status", {
		description: "Toggle current goal status widget",
		handler: async (args, ctx) => {
			const { getState } = resolve(ctx);
			await showGoalStatus(getState(), ctx, parseStatusMode(args.trim()));
		},
	});
}

export function parseGoalCommandInput(args: unknown): string {
	const raw =
		typeof args === "string"
			? args
			: typeof (args as { objective?: unknown } | null)?.objective === "string"
				? (args as { objective: string }).objective
				: "";

	return raw.trim();
}

const QUOTE_PAIRS: Record<string, string> = {
	'"': '"',
	"'": "'",
	"“": "”",
	"‘": "’",
};

export function stripWrappingQuotes(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const expectedLast = QUOTE_PAIRS[first];
	if (expectedLast && last === expectedLast) return trimmed.slice(1, -1).trim();
	// Be forgiving of mixed straight/smart quotes pasted from rich text.
	if ((first === '"' || first === "“") && (last === '"' || last === "”")) return trimmed.slice(1, -1).trim();
	if ((first === "'" || first === "‘") && (last === "'" || last === "’")) return trimmed.slice(1, -1).trim();
	return trimmed;
}

function splitSubcommand(input: string): { subcommand: string; rest: string } {
	const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	return { subcommand: (match?.[1] ?? "").toLowerCase(), rest: (match?.[2] ?? "").trim() };
}

function parseStatusMode(input: string): "toggle" | "show" | "hide" {
	const mode = input.trim().toLowerCase();
	if (mode === "show") return "show";
	if (mode === "hide" || mode === "off" || mode === "clear") return "hide";
	return "toggle";
}

function parseGoalStartOptions(input: string): GoalStartOptions {
	let working = input.trim();
	let verifyCommand: string | null = null;
	let maxTurns: number | null = DEFAULT_MAX_TURNS;

	working = working.replace(/\s+--verify\s+(?:"([^"]+)"|'([^']+)'|“([^”]+)”|(\S+))/g, (_all, dbl, single, smart, bare) => {
		verifyCommand = (dbl ?? single ?? smart ?? bare ?? "").trim() || null;
		return "";
	});

	working = working.replace(/\s+--max-turns\s+(\d+)/g, (_all, value) => {
		const parsed = Number(value);
		maxTurns = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TURNS;
		return "";
	});

	return {
		objective: stripWrappingQuotes(working),
		verifyCommand,
		maxTurns,
	};
}

// ═══════════════════════════════════════════════════════════
// Command handlers
// ═══════════════════════════════════════════════════════════

async function startGoal(
	options: GoalStartOptions,
	deps: CommandSessionDeps,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, setState, saveState, resetErrors } = deps;
	const objective = options.objective;
	if (!objective) {
		ctx.ui.notify("Usage: /goal \"objective\" [--max-turns N] [--verify \"command\"]", "warning");
		return;
	}

	const existing = getState();
	if (isActive(existing)) {
		const override = await ctx.ui.confirm(
			"Goal already active",
			`A goal is currently ${existing.status}: "${existing.objective.slice(0, 60)}${existing.objective.length > 60 ? "…" : ""}"\n\nOverride with new goal?`,
		);
		if (!override) {
			ctx.ui.notify("Goal unchanged. Use /goal pause or /goal clear first.", "info");
			return;
		}
	}

	const gs: GoalState = {
		objective,
		planItems: [],
		planDone: [],
		status: "running",
		turnCount: 0,
		startedAt: Date.now(),
		completedAt: null,
		verifyCommand: options.verifyCommand,
		maxTurns: options.maxTurns,
		progressCurrent: null,
		progressTotal: null,
		progressLabel: null,
		consecutiveErrors: 0,
		lastErrorMessage: null,
		lastErrorAt: null,
		compactionCount: 0,
		lastCompactedAt: null,
		lastCompactionTokens: null,
		lastCompactionEntryId: null,
	};

	setState(gs);
	saveState(gs);
	resetErrors();
	hideGoalStatusWidget(ctx);

	ctx.ui.notify(
		`🎯 Goal started: "${objective.slice(0, 60)}${objective.length > 60 ? "…" : ""}"\nUse /goal pause, /goal status, /goal report, or /goal clear to manage.`,
		"info",
	);

	await ctx.waitForIdle();
	pi.sendUserMessage(
		`Goal: ${objective}\n\nBegin working toward this objective. Start by exploring the codebase, understanding what needs to change, and creating a plan. Then execute the plan, verifying your progress at each step.`,
	);
}

async function pauseGoal(
	deps: CommandSessionDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, setState, saveState } = deps;
	const gs = getState();
	if (gs.status === "paused") {
		ctx.ui.notify("Goal is already paused. Use /goal resume to continue.", "info");
		return;
	}
	if (gs.status === "wrapping-up") {
		ctx.ui.notify("Goal is already pausing — it will stop after the current run.", "info");
		return;
	}
	if (gs.status !== "running") {
		ctx.ui.notify(`No active goal to pause (status: ${gs.status})`, "warning");
		return;
	}

	gs.status = ctx.isIdle() ? "paused" : "wrapping-up";
	setState(gs);
	saveState(gs);
	refreshStatusWidget(gs, ctx);
	ctx.ui.notify(
		gs.status === "paused"
			? "⏸ Goal paused. Use /goal resume to continue."
			: "⏸ Pausing — the agent will finish its current run then stop. Use /goal resume to continue.",
		"info",
	);
}

async function pauseNowGoal(
	deps: CommandSessionDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, setState, saveState } = deps;
	const gs = getState();
	if (gs.status === "idle" || !gs.objective) {
		ctx.ui.notify(`No active goal to pause (status: ${gs.status})`, "warning");
		return;
	}
	if (gs.status === "paused") {
		ctx.ui.notify("Goal is already paused. Use /goal resume to continue.", "info");
		return;
	}

	gs.status = "paused";
	setState(gs);
	saveState(gs);
	refreshStatusWidget(gs, ctx);
	if (!ctx.isIdle()) ctx.abort();
	ctx.ui.notify("⏸ Goal paused immediately. Use /goal resume to continue.", "info");
}

async function resumeGoal(
	deps: CommandSessionDeps,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, setState, saveState, resetErrors } = deps;
	const gs = getState();
	if (gs.status !== "paused") {
		ctx.ui.notify(`No paused goal to resume (status: ${gs.status}). Use /goal "objective" to start one.`, "warning");
		return;
	}

	gs.status = "running";
	gs.consecutiveErrors = 0;
	setState(gs);
	saveState(gs);
	resetErrors();

	ctx.ui.notify(`▶ Resuming goal: "${gs.objective.slice(0, 50)}${gs.objective.length > 50 ? "…" : ""}" (Run ${gs.turnCount + 1})`, "info");

	await ctx.waitForIdle();
	pi.sendUserMessage(
		"Resume working toward the goal. Continue from where you left off. Report progress and whether the objective has been fully achieved.",
	);
}

async function resumeLastGoal(
	deps: CommandSessionDeps,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, setState, saveState, resetErrors } = deps;
	const existing = getState();
	if (isActive(existing)) {
		ctx.ui.notify("A goal is already active in this session.", "warning");
		return;
	}

	const found = findMostRecentGoal();
	if (!found || found.goal.status === "idle") {
		ctx.ui.notify("No resumable disk-persisted goal found.", "info");
		return;
	}

	found.goal.status = "running";
	found.goal.consecutiveErrors = 0;
	setState(found.goal);
	saveState(found.goal);
	resetErrors();
	ctx.ui.notify(`▶ Resuming last persisted goal: "${found.goal.objective.slice(0, 60)}${found.goal.objective.length > 60 ? "…" : ""}"`, "info");
	await ctx.waitForIdle();
	pi.sendUserMessage("Resume the persisted goal. Re-read key files, reconstruct progress, and continue from the latest verified state.");
}

async function clearGoal(
	deps: CommandSessionDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, clearState } = deps;
	const gs = getState();
	if (!isActive(gs) && gs.status !== "paused") {
		ctx.ui.notify("No active goal to clear.", "warning");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Clear goal?",
		`This will permanently stop the goal:\n"${gs.objective.slice(0, 80)}${gs.objective.length > 80 ? "…" : ""}"\n\n${gs.turnCount} agent runs completed. Progress will not be saved as active.`,
	);

	if (!confirmed) {
		ctx.ui.notify("Goal unchanged.", "info");
		return;
	}

	clearState();
	hideGoalStatusWidget(ctx);
	ctx.ui.notify("🗑 Goal cleared.", "info");
}

async function showGoalStatus(gs: GoalState, ctx: ExtensionCommandContext, mode: "toggle" | "show" | "hide"): Promise<void> {
	if (mode === "hide") {
		hideGoalStatusWidget(ctx);
		return;
	}
	if (mode === "show") {
		showGoalStatusWidget(gs, ctx);
		return;
	}
	toggleGoalStatusWidget(gs, ctx);
}

function showGoalReport(gs: GoalState, ctx: ExtensionCommandContext): void {
	ctx.ui.notify(formatGoalReport(gs), "info");
}

function showGoalList(ctx: ExtensionCommandContext): void {
	const found = findMostRecentGoal();
	if (!found || !found.goal.objective) {
		ctx.ui.notify("No disk-persisted goal found.", "info");
		return;
	}
	ctx.ui.notify(formatGoalReport(found.goal), "info");
}

async function setGoalLimit(
	input: string,
	deps: CommandSessionDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { getState, setState, saveState } = deps;
	const gs = getState();
	if (!gs.objective || gs.status === "idle") {
		ctx.ui.notify("No active or paused goal to limit.", "warning");
		return;
	}
	const parsed = Number(input.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) {
		ctx.ui.notify("Usage: /goal limit <max-agent-runs>", "warning");
		return;
	}
	gs.maxTurns = Math.floor(parsed);
	setState(gs);
	saveState(gs);
	ctx.ui.notify(`Goal run limit set to ${gs.maxTurns}.`, "info");
}

function refreshStatusWidget(gs: GoalState, ctx: ExtensionCommandContext): void {
	if (isGoalStatusWidgetVisible(ctx)) showGoalStatusWidget(gs, ctx);
}
