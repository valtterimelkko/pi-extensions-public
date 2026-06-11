/**
 * Goal Engine — Autonomous Multi-Turn Goal Execution for Pi
 *
 * Defines a verifiable objective that Pi will keep working toward across
 * multiple turns until the goal is achieved, paused, or cleared.
 *
 * State is session-scoped via per-session Map + per-session disk files so
 * goals never leak across concurrent sessions in the Web UI Pi SDK route.
 *
 * Commands:
 *   /goal "objective"       — Start a new autonomous goal
 *   /goal pause             — Pause (wraps up current run)
 *   /goal resume            — Continue from paused
 *   /goal resume-last       — Resume the latest disk-persisted goal
 *   /goal clear             — Abandon the current goal
 *   /goal status            — Toggle goal progress widget
 *   /goal report            — Show goal execution report
 *   /goal limit <n>         — Set max agent-run limit
 *   /goal                   — Alias for status toggle
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands, type CommandResolver } from "./commands.js";
import { registerCompactionHooks } from "./compaction.js";
import { registerAutoContinueHooks, type GoalStateResolver } from "./auto-continue.js";
import { buildGoalPrompt } from "./prompt.js";
import {
	isActive,
	loadGoalState,
	loadSessionDiskGoalState,
	saveGoalState,
	clearGoalState,
	getSessionKey,
	type GoalState,
	EMPTY_GOAL_STATE,
} from "./state.js";

// ── Per-session goal store ─────────────────────────────────
// Each session (identified by its file path) gets its own entry
// so concurrent sessions in the Web UI never cross-contaminate.

interface SessionGoalEntry {
	goalState: GoalState;
	lastSavedSnapshot: string;
}

const goalEntries = new Map<string, SessionGoalEntry>();

function getEntry(sessionKey: string): SessionGoalEntry {
	let entry = goalEntries.get(sessionKey);
	if (!entry) {
		entry = { goalState: { ...EMPTY_GOAL_STATE }, lastSavedSnapshot: "" };
		goalEntries.set(sessionKey, entry);
	}
	return entry;
}

// ── Shared ExtensionAPI reference (set below before any event fires) ──

let piRef: ExtensionAPI = null!;

// ── State resolvers ──────────────────────────────────────────

/**
 * Resolve per-session state closures from ExtensionContext at event time.
 * Used by auto-continue + compaction hooks.
 */
const resolveGoalState: GoalStateResolver = (ctx: ExtensionContext) => {
	const sessionKey = getSessionKey(ctx);
	const entry = getEntry(sessionKey);
	return {
		getState: () => entry.goalState,
		setState: (gs: GoalState) => { entry.goalState = gs; },
		saveState: (gs: GoalState) => {
			const serialized = JSON.stringify(gs);
			if (serialized === entry.lastSavedSnapshot) return;
			saveGoalState(gs, piRef, sessionKey);
			entry.lastSavedSnapshot = serialized;
		},
	};
};

/**
 * Resolve per-session command deps from ExtensionCommandContext at event time.
 * Used by /goal command handlers.
 */
const resolveCommandDeps: CommandResolver = (ctx) => {
	const sessionKey = getSessionKey(ctx);
	const entry = getEntry(sessionKey);
	return {
		getState: () => entry.goalState,
		setState: (gs: GoalState) => { entry.goalState = gs; },
		saveState: (gs: GoalState) => {
			const serialized = JSON.stringify(gs);
			if (serialized === entry.lastSavedSnapshot) return;
			saveGoalState(gs, piRef, sessionKey);
			entry.lastSavedSnapshot = serialized;
		},
		clearState: () => {
			const cleared = clearGoalState(piRef, sessionKey);
			entry.goalState = cleared;
			entry.lastSavedSnapshot = JSON.stringify(cleared);
			return cleared;
		},
		resetErrors: () => {
			// Reset per-session error counters (managed in auto-continue.ts).
			errorControl.resetErrors(sessionKey);
		},
	};
};

// ── Error control (populated after hooks register) ──────────

let errorControl = { resetErrors: (_key: string) => {} };

// ═══════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI): void {
	piRef = pi;

	// ── Auto-continue hooks (session-scoped) ────────────────────
	errorControl = registerAutoContinueHooks(pi, resolveGoalState);

	// ── Compaction hooks (session-scoped) ───────────────────────
	registerCompactionHooks(pi, resolveGoalState);

	// ── Commands (session-scoped) ──────────────────────────────
	registerCommands(pi, resolveCommandDeps);

	// ═══════════════════════════════════════════════════════
	// Session lifecycle — reconstruct state on load
	// ═══════════════════════════════════════════════════════

	pi.on("session_start", async (_event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		const entry = getEntry(sessionKey);

		// 1. Load from this session's branch entries (already scoped).
		const branchGoal = loadGoalState(ctx);
		if (branchGoal.objective) {
			entry.goalState = branchGoal;
			entry.lastSavedSnapshot = JSON.stringify(branchGoal);
			if (isActive(branchGoal)) {
				ctx.ui.notify(
					`🎯 Goal restored: "${branchGoal.objective.slice(0, 50)}${branchGoal.objective.length > 50 ? "…" : ""}" — use /goal resume to continue`,
					"info",
				);
			}
			return;
		}

		// 2. Check this session's own disk file (NOT a global file).
		const diskGoal = loadSessionDiskGoalState(sessionKey);
		if (diskGoal && diskGoal.objective && diskGoal.status !== "idle") {
			entry.goalState = diskGoal;
			entry.lastSavedSnapshot = JSON.stringify(diskGoal);
			ctx.ui.notify(
				`🎯 Previous goal available: "${diskGoal.objective.slice(0, 50)}${diskGoal.objective.length > 50 ? "…" : ""}" — use /goal resume-last to continue`,
				"info",
			);
		}
	});

	// ═══════════════════════════════════════════════════════
	// System prompt injection — every turn while active
	// ═══════════════════════════════════════════════════════

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		const gs = getEntry(sessionKey).goalState;
		if (!isActive(gs)) return;
		const goalBlock = buildGoalPrompt(gs);
		return { systemPrompt: event.systemPrompt + "\n\n" + goalBlock };
	});
}
