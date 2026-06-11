import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionKey, type GoalState } from "./state.js";

const STATUS_WIDGET_ID = "goal-engine-status";
const visibleSessionKeys = new Set<string>();

export function isGoalStatusWidgetVisible(ctx: ExtensionContext): boolean {
	return visibleSessionKeys.has(getSessionKey(ctx));
}

export function hideGoalStatusWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(STATUS_WIDGET_ID, undefined);
	visibleSessionKeys.delete(getSessionKey(ctx));
}

export function showGoalStatusWidget(gs: GoalState, ctx: ExtensionContext): void {
	if (gs.status === "idle") {
		hideGoalStatusWidget(ctx);
		ctx.ui.notify("No active goal. Use /goal \"objective\" to start one.", "info");
		return;
	}

	ctx.ui.setWidget(STATUS_WIDGET_ID, [...formatGoalStatusLines(gs), "", "Run /goal status again to hide."]);
	visibleSessionKeys.add(getSessionKey(ctx));
}

export function toggleGoalStatusWidget(gs: GoalState, ctx: ExtensionContext): void {
	if (isGoalStatusWidgetVisible(ctx)) {
		hideGoalStatusWidget(ctx);
		return;
	}
	showGoalStatusWidget(gs, ctx);
}

export function formatGoalStatusLines(gs: GoalState): string[] {
	const statusLabel: Record<string, string> = {
		idle: "Idle",
		running: "▶ Running",
		"wrapping-up": "⏸ Wrapping up…",
		paused: "⏸ Paused",
	};

	const lines: string[] = [];
	lines.push(`🎯 Goal Status`);
	lines.push(`Status: ${statusLabel[gs.status] || gs.status}`);
	lines.push(`Objective: ${gs.objective}`);
	lines.push(`Started: ${gs.startedAt ? new Date(gs.startedAt).toLocaleString() : "n/a"}`);
	lines.push(`Agent runs: ${gs.turnCount}`);
	if (gs.maxTurns !== null) lines.push(`Max runs: ${gs.maxTurns}`);

	if (gs.progressCurrent !== null && gs.progressTotal !== null) {
		const label = gs.progressLabel ?? "Progress";
		lines.push(`${label}: ${gs.progressCurrent}/${gs.progressTotal}`);
	}

	if (gs.verifyCommand) lines.push(`Verification: ${gs.verifyCommand}`);

	if (gs.compactionCount > 0) {
		lines.push(`Compactions: ${gs.compactionCount}`);
		if (gs.lastCompactedAt) lines.push(`Last compaction: ${new Date(gs.lastCompactedAt).toLocaleString()}`);
		if (gs.lastCompactionTokens !== null) lines.push(`Last compacted tokens: ${gs.lastCompactionTokens}`);
	}

	if (gs.consecutiveErrors > 0 || gs.lastErrorMessage) {
		lines.push(`Consecutive errors: ${gs.consecutiveErrors}`);
		if (gs.lastErrorMessage) lines.push(`Last error: ${gs.lastErrorMessage}`);
		if (gs.lastErrorAt) lines.push(`Last error at: ${new Date(gs.lastErrorAt).toLocaleString()}`);
	}

	if (gs.planItems.length > 0) {
		lines.push("");
		lines.push("Plan:");
		for (let i = 0; i < gs.planItems.length; i++) {
			lines.push(`  ${gs.planDone[i] ? "✓" : "☐"} ${gs.planItems[i]}`);
		}
	}

	if (gs.completedAt) {
		lines.push("");
		lines.push(`Completed: ${new Date(gs.completedAt).toLocaleString()}`);
	}

	return lines;
}

export function formatGoalReport(gs: GoalState): string {
	if (!gs.objective) return "No goal has been recorded in this session.";
	const lines = formatGoalStatusLines(gs);
	lines[0] = "🎯 Goal Report";
	return lines.join("\n");
}
