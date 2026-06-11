/**
 * Goal Engine — Compaction Hooks
 *
 * Hooks into Pi's compaction lifecycle to preserve goal state across
 * context summarization and re-inject context afterward.
 *
 * Session-scoped: derives the session key from ExtensionContext at event time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGoalPrompt } from "./prompt.js";
import { isActive, getSessionKey } from "./state.js";
import type { GoalStateResolver } from "./auto-continue.js";
import { isGoalStatusWidgetVisible, showGoalStatusWidget } from "./status-ui.js";

/**
 * Register compaction lifecycle handlers.
 * Uses the resolver to derive per-session state from the event context.
 */
export function registerCompactionHooks(
	pi: ExtensionAPI,
	resolve: GoalStateResolver,
): void {
	// ── Before compaction: persist goal state ──────────────────
	pi.on("session_before_compact", async (_event, ctx) => {
		const { getState, saveState } = resolve(ctx);
		const gs = getState();
		if (!isActive(gs)) return;
		saveState(gs);
	});

	// ── After compaction: inject context recovery for the agent ──
	pi.on("session_compact", async (event, ctx) => {
		const { getState, setState, saveState } = resolve(ctx);
		const gs = getState();
		if (!isActive(gs)) return;

		gs.compactionCount += 1;
		gs.lastCompactedAt = Date.now();
		gs.lastCompactionTokens = event.compactionEntry.tokensBefore ?? null;
		gs.lastCompactionEntryId = event.compactionEntry.id ?? null;
		setState(gs);
		saveState(gs);

		ctx.ui.notify(
			`📦 Goal "${gs.objective.slice(0, 40)}${gs.objective.length > 40 ? "…" : ""}" — context compacted, goal still active`,
			"info",
		);

		if (isGoalStatusWidgetVisible(ctx)) showGoalStatusWidget(gs, ctx);

		// Inject a context-recovery message that the agent sees next turn.
		// This primes it to re-read files and re-orient itself.
		pi.sendMessage(
			{
				customType: "goal_context_restored",
				content: [
					"CONTEXT COMPACTED. The conversation has been summarized.\n",
					"Your goal is still active. The goal prompt will be re-injected.\n",
					"Re-read any files you were working on before continuing.\n",
					buildGoalPrompt(gs),
				].join("\n"),
				display: true,
				details: { label: "Goal context restored after compaction" },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
