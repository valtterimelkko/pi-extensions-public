/**
 * Goal Engine — System Prompt Builder
 *
 * Constructs the goal prompt that is injected into the system prompt
 * at the start of every turn while a goal is active.
 */

import type { GoalState } from "./state.js";

/**
 * Build the goal system prompt block injected into the system prompt.
 */
export function buildGoalPrompt(gs: GoalState): string {
	const parts: string[] = [];

	parts.push("## Active Goal");
	parts.push("");
	parts.push("You are working autonomously toward a defined objective.");
	parts.push("You will continue across MULTIPLE TURNS until it is fully achieved.");
	parts.push("");
	parts.push("### Objective");
	parts.push(gs.objective);

	if (gs.planItems.length > 0) {
		parts.push("");
		parts.push("### Plan");
		for (let i = 0; i < gs.planItems.length; i++) {
			const check = gs.planDone[i] ? "✓" : "☐";
			parts.push(`${check} ${gs.planItems[i]}`);
		}
	}

	parts.push("");
	parts.push("### Rules");
	parts.push("- Do NOT accept proxy signals. Only consider the objective achieved");
	parts.push("  when you have verified it yourself.");
	parts.push("- Treat uncertainty as NOT achieved. If unsure, keep working.");
	if (gs.verifyCommand) {
		parts.push(`- A verification command is configured: ${gs.verifyCommand}`);
		parts.push("  Only signal completion after your own checks indicate this command should pass.");
	}
	parts.push("- At the END of this turn, state one of:");
	parts.push('  • "**Status: CONTINUING**" — more work is needed');
	parts.push('  • "**Status: GOAL_ACHIEVED**" — the objective has been fully met');
	parts.push("- Include concise progress in a parseable form when possible, e.g. 'Progress: 3/10' or 'Species completed: 160/200'.");
	parts.push("- Update your structured summary to reflect current progress.");
	parts.push("- If context has been compacted, re-read key files before continuing.");
	parts.push("");
	parts.push("### Current State");
	parts.push(`Agent run ${gs.turnCount + 1} — ${gs.turnCount === 0 ? "Starting now." : "Continue from where you left off."}`);
	if (gs.maxTurns !== null) parts.push(`Max agent runs before pausing: ${gs.maxTurns}`);
	if (gs.progressCurrent !== null && gs.progressTotal !== null) {
		parts.push(`${gs.progressLabel ?? "Progress"}: ${gs.progressCurrent}/${gs.progressTotal}`);
	}
	if (gs.compactionCount > 0) parts.push(`Compactions so far: ${gs.compactionCount}`);

	return parts.join("\n");
}
