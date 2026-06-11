/**
 * Goal Engine — Auto-Continuation Loop
 *
 * After each full agent run, if the goal is still active and not paused, queues a
 * follow-up message so the agent continues working without user input.
 *
 * All state access is session-scoped via a resolver function that derives the
 * session key from the ExtensionContext at event time.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isGoalAchieved, extractAssistantText } from "./verify.js";
import { isActive, getSessionKey, type GoalState } from "./state.js";
import type { SaveGoalState } from "./commands.js";
import { hideGoalStatusWidget, isGoalStatusWidgetVisible, showGoalStatusWidget } from "./status-ui.js";

const MAX_CONSECUTIVE_ERRORS = 3;

// Per-session error counters (companion to GoalState.consecutiveErrors).
const errorCounters = new Map<string, number>();

function findLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return undefined;
}

export interface GoalStateResolver {
	(ctx: ExtensionContext): {
		getState: () => GoalState;
		setState: (gs: GoalState) => void;
		saveState: (gs: GoalState) => void;
	};
}

export interface GoalErrorControl {
	resetErrors(sessionKey: string): void;
	getConsecutiveErrors(sessionKey: string): number;
}

export function registerAutoContinueHooks(
	pi: ExtensionAPI,
	resolve: GoalStateResolver,
): GoalErrorControl {
	function incErrors(sessionKey: string): number {
		const n = (errorCounters.get(sessionKey) ?? 0) + 1;
		errorCounters.set(sessionKey, n);
		return n;
	}

	const errorControl: GoalErrorControl = {
		resetErrors(sessionKey: string) {
			errorCounters.set(sessionKey, 0);
		},
		getConsecutiveErrors(sessionKey: string): number {
			return errorCounters.get(sessionKey) ?? 0;
		},
	};

	pi.on("agent_end", async (event, ctx) => {
		const { getState, setState, saveState } = resolve(ctx);
		const sessionKey = getSessionKey(ctx);
		const gs = getState();
		if (!isActive(gs)) return;

		const finalAssistantMessage = findLastAssistantMessage(event.messages);
		const assistantText = finalAssistantMessage ? extractAssistantText(finalAssistantMessage) : "";
		const stopReason =
			finalAssistantMessage !== undefined && "stopReason" in finalAssistantMessage
				? (finalAssistantMessage as { stopReason?: string }).stopReason
				: undefined;
		const countThisRun = shouldCountRun(finalAssistantMessage, assistantText, stopReason);
		if (countThisRun) {
			const nextRunCount = gs.turnCount + 1;
			gs.turnCount = nextRunCount;
			updateProgressFromAssistant(gs, assistantText);
		}

		if (stopReason === "aborted") {
			gs.status = "paused";
			gs.lastErrorMessage = "Goal run aborted by user; auto-continuation paused.";
			gs.lastErrorAt = Date.now();
			errorControl.resetErrors(sessionKey);
			gs.consecutiveErrors = 0;
			setState(gs);
			saveState(gs);
			ctx.ui.notify(
				`⏸ Goal paused after an aborted run${countThisRun ? ` (Run ${gs.turnCount})` : ""}. Use /goal resume to continue.`,
				"info",
			);
			refreshVisibleStatus(gs, ctx);
			return;
		}

		const isError = stopReason === "error";

		if (isError) {
			const consecutiveErrors = incErrors(sessionKey);
			gs.consecutiveErrors = consecutiveErrors;
			gs.lastErrorMessage = (finalAssistantMessage as { errorMessage?: string }).errorMessage ?? "Assistant turn ended with stopReason=error";
			gs.lastErrorAt = Date.now();
			if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				gs.status = "paused";
				setState(gs);
				saveState(gs);
				ctx.ui.notify(
					`⚠ Goal paused after ${consecutiveErrors} consecutive errors. Use /goal resume to retry.`,
					"warning",
				);
				refreshVisibleStatus(gs, ctx);
				return;
			}
			ctx.ui.notify(
				`⚠ Goal run ${gs.turnCount} ended with error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}). Retrying…`,
				"warning",
			);
		} else {
			errorControl.resetErrors(sessionKey);
			gs.consecutiveErrors = 0;
		}

		// Check for goal completion once the full agent prompt has ended.
		if (isGoalAchieved(assistantText)) {
			const verification = await verifyCompletionIfNeeded(pi, gs);
			if (!verification.ok) {
				gs.lastErrorMessage = verification.message;
				gs.lastErrorAt = Date.now();
				setState(gs);
				saveState(gs);
				ctx.ui.notify(`⚠ Goal completion signal rejected by verification: ${verification.message}`, "warning");
				queueContinuation(pi, getState);
				refreshVisibleStatus(gs, ctx);
				return;
			}

			gs.status = "idle";
			gs.completedAt = Date.now();
			setState(gs);
			saveState(gs);
			hideGoalStatusWidget(ctx);
			ctx.ui.notify(
				`🎯 Goal achieved in ${gs.turnCount} agent runs: "${gs.objective.slice(0, 50)}${gs.objective.length > 50 ? "…" : ""}"`,
				"info",
			);
			errorControl.resetErrors(sessionKey);
			return;
		}

		// Handle wrapping-up → pause after the current agent prompt fully finishes.
		if (gs.status === "wrapping-up") {
			gs.status = "paused";
			setState(gs);
			saveState(gs);
			ctx.ui.notify(
				`⏸ Goal paused after ${gs.turnCount} agent runs — use /goal resume to continue`,
				"info",
			);
			errorControl.resetErrors(sessionKey);
			refreshVisibleStatus(gs, ctx);
			return;
		}

		if (gs.maxTurns !== null && gs.turnCount >= gs.maxTurns) {
			gs.status = "paused";
			setState(gs);
			saveState(gs);
			ctx.ui.notify(`⏸ Goal paused after reaching max runs (${gs.maxTurns}). Use /goal limit <n> and /goal resume to continue.`, "warning");
			refreshVisibleStatus(gs, ctx);
			return;
		}

		setState(gs);
		saveState(gs);
		refreshVisibleStatus(gs, ctx);
		queueContinuation(pi, getState);
	});

	return errorControl;
}

function shouldCountRun(
	finalAssistantMessage: AgentMessage | undefined,
	assistantText: string,
	stopReason: string | undefined,
): boolean {
	if (finalAssistantMessage === undefined) return false;
	if (stopReason === "aborted" && assistantText.trim().length === 0) return false;
	return true;
}

function queueContinuation(pi: ExtensionAPI, getState: () => GoalState): void {
	setTimeout(() => {
		const fresh = getState();
		if (fresh.status !== "running") return;

		pi.sendUserMessage(
			"Continue working toward the goal. Report your progress and state whether the objective has been fully achieved.",
			{ deliverAs: "followUp" },
		);
	}, 200);
}

function refreshVisibleStatus(gs: GoalState, ctx: Parameters<typeof showGoalStatusWidget>[1]): void {
	if (isGoalStatusWidgetVisible(ctx)) showGoalStatusWidget(gs, ctx);
}

async function verifyCompletionIfNeeded(pi: ExtensionAPI, gs: GoalState): Promise<{ ok: boolean; message: string }> {
	if (!gs.verifyCommand) return { ok: true, message: "No verification command configured." };
	try {
		const result = await pi.exec("bash", ["-lc", gs.verifyCommand], { timeout: 120_000 });
		if (result.code === 0) return { ok: true, message: "Verification passed." };
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		return { ok: false, message: output || `Verification exited with code ${result.code}` };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

function updateProgressFromAssistant(gs: GoalState, assistantText: string): void {
	const progress = parseProgress(assistantText);
	if (progress) {
		gs.progressCurrent = progress.current;
		gs.progressTotal = progress.total;
		gs.progressLabel = progress.label;
	}

	const checklist = parseChecklist(assistantText);
	if (checklist.items.length > 0) {
		gs.planItems = checklist.items;
		gs.planDone = checklist.done;
	}
}

function parseProgress(text: string): { current: number; total: number; label: string } | null {
	const patterns: Array<{ regex: RegExp; label: string }> = [
		{ regex: /species completed:\s*(\d+)\s*\/\s*(\d+)/i, label: "Species" },
		{ regex: /completed:\s*(\d+)\s*\/\s*(\d+)/i, label: "Progress" },
		{ regex: /progress:\s*(\d+)\s*\/\s*(\d+)/i, label: "Progress" },
		{ regex: /\b(\d+)\s+of\s+(\d+)\b/i, label: "Progress" },
	];

	for (const { regex, label } of patterns) {
		const match = text.match(regex);
		if (!match) continue;
		const current = Number(match[1]);
		const total = Number(match[2]);
		if (Number.isFinite(current) && Number.isFinite(total) && total > 0) return { current, total, label };
	}
	return null;
}

function parseChecklist(text: string): { items: string[]; done: boolean[] } {
	const items: string[] = [];
	const done: boolean[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
		if (!match) continue;
		items.push(match[2].trim());
		done.push(match[1].toLowerCase() === "x");
	}
	return { items, done };
}
