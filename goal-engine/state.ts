/**
 * Goal Engine — State Management
 *
 * Goal state is persisted both in the Pi session via pi.appendEntry("goal_engine", ...)
 * and on disk per-session so goals are never leaked across sessions.
 *
 * In the Pi CLI a single session makes this straightforward.
 * In the Web UI Pi SDK route multiple AgentSession instances can be active
 * simultaneously, so every persistence path is keyed by session file path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type GoalStatus = "idle" | "running" | "wrapping-up" | "paused";

export interface GoalState {
	objective: string;
	/** Plan items — extracted from assistant checklists when available. */
	planItems: string[];
	/** Which items have been marked done by the agent. */
	planDone: boolean[];
	status: GoalStatus;
	/** Number of full agent runs processed for this goal, including the final completion run. */
	turnCount: number;
	startedAt: number;
	completedAt: number | null;
	/** Optional shell command that must pass before completion is accepted. */
	verifyCommand: string | null;
	/** Safety limit for full agent runs. */
	maxTurns: number | null;
	/** Last parsed numeric progress, if the assistant reports e.g. 160 / 200. */
	progressCurrent: number | null;
	progressTotal: number | null;
	progressLabel: string | null;
	/** Error/retry diagnostics. */
	consecutiveErrors: number;
	lastErrorMessage: string | null;
	lastErrorAt: number | null;
	/** Compaction diagnostics. */
	compactionCount: number;
	lastCompactedAt: number | null;
	lastCompactionTokens: number | null;
	lastCompactionEntryId: string | null;
}

export const DEFAULT_MAX_TURNS = 100;

export const EMPTY_GOAL_STATE: GoalState = {
	objective: "",
	planItems: [],
	planDone: [],
	status: "idle",
	turnCount: 0,
	startedAt: 0,
	completedAt: null,
	verifyCommand: null,
	maxTurns: DEFAULT_MAX_TURNS,
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

// ═══════════════════════════════════════════════════════════
// Session key helpers
// ═══════════════════════════════════════════════════════════

const GOAL_DIR = path.join(os.homedir(), ".pi", "agent", "goal-engine");
const GLOBAL_LEGACY_PATH = path.join(GOAL_DIR, "current-goal.json");

/**
 * Derive a stable session key from extension context.
 * Uses getSessionFile() when available (Pi SDK / Web UI) so every session
 * gets its own namespace. Falls back to cwd for legacy contexts.
 */
export function getSessionKey(ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } }): string {
	try {
		const file = (ctx.sessionManager as { getSessionFile?: () => string } | undefined)?.getSessionFile?.();
		if (file) return file;
	} catch { /* fall back to cwd */ }
	return ctx.cwd ?? "default";
}

/**
 * Convert a raw session key (file path or cwd) into a filename-safe slug.
 */
function slugFromKey(sessionKey: string): string {
	const base = path.basename(sessionKey, path.extname(sessionKey));
	return base.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

/**
 * Per-session goal state disk path.
 */
export function getSessionGoalStatePath(sessionKey: string): string {
	return path.join(GOAL_DIR, `${slugFromKey(sessionKey)}.goal.json`);
}

// ═══════════════════════════════════════════════════════════
// Normalisation
// ═══════════════════════════════════════════════════════════

function normalizeGoalState(data: Partial<GoalState> | undefined): GoalState {
	return { ...EMPTY_GOAL_STATE, ...(data ?? {}) };
}

// ═══════════════════════════════════════════════════════════
// Session-entry persistence (already session-scoped by design)
// ═══════════════════════════════════════════════════════════

const ENTRY_TYPE = "goal_engine";

/**
 * Call on session_start / session_reload to reconstruct state from the
 * most recent goal_engine entry in the session branch.
 */
export function loadGoalState(ctx: ExtensionContext): GoalState {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && "customType" in entry && entry.customType === ENTRY_TYPE) {
			const data = (entry as { data?: Partial<GoalState> }).data;
			if (data) return normalizeGoalState(data);
		}
	}
	return { ...EMPTY_GOAL_STATE };
}

/**
 * Persist a copy of state to both session entries and per-session disk.
 * The sessionKey ensures no cross-session leakage.
 */
export function saveGoalState(goalState: GoalState, pi: { appendEntry<T>(type: string, data?: T): void }, sessionKey: string): void {
	const snapshot = normalizeGoalState(goalState);
	pi.appendEntry(ENTRY_TYPE, snapshot);
	saveGoalStateToDisk(snapshot, sessionKey);
}

/**
 * Reset to empty in session entries and remove per-session disk file.
 */
export function clearGoalState(pi: { appendEntry<T>(type: string, data?: T): void }, sessionKey: string): GoalState {
	const cleared = { ...EMPTY_GOAL_STATE };
	pi.appendEntry(ENTRY_TYPE, cleared);
	removeSessionDiskFile(sessionKey);
	return cleared;
}

// ═══════════════════════════════════════════════════════════
// Per-session disk persistence
// ═══════════════════════════════════════════════════════════

export function saveGoalStateToDisk(goalState: GoalState, sessionKey: string): void {
	const diskPath = getSessionGoalStatePath(sessionKey);
	try {
		fs.mkdirSync(path.dirname(diskPath), { recursive: true });
		fs.writeFileSync(diskPath, JSON.stringify(normalizeGoalState(goalState), null, 2), "utf8");
	} catch {
		// Disk persistence is a convenience; session persistence remains primary.
	}
}

export function loadSessionDiskGoalState(sessionKey: string): GoalState | null {
	const diskPath = getSessionGoalStatePath(sessionKey);
	return loadFileIfExists(diskPath);
}

function loadFileIfExists(filePath: string): GoalState | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GoalState>;
		return normalizeGoalState(parsed);
	} catch {
		return null;
	}
}

function removeSessionDiskFile(sessionKey: string): void {
	try {
		const diskPath = getSessionGoalStatePath(sessionKey);
		if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
		// Also remove legacy global file to prevent stale cross-session reads.
		if (fs.existsSync(GLOBAL_LEGACY_PATH)) fs.unlinkSync(GLOBAL_LEGACY_PATH);
	} catch {
		// Not critical.
	}
}

// ═══════════════════════════════════════════════════════════
// Cross-session lookup (resume-last)
// ═══════════════════════════════════════════════════════════

export interface StoredGoal {
	sessionKey: string;
	sessionSlug: string;
	goal: GoalState;
	updatedAt: number;
}

/**
 * Find the most recent non-idle goal across ALL per-session disk files.
 * Used by /goal resume-last to resume a goal from a different session.
 * Also checks the legacy global file for backward compat.
 */
export function findMostRecentGoal(): StoredGoal | null {
	const candidates: StoredGoal[] = [];

	try {
		if (!fs.existsSync(GOAL_DIR)) return null;

		for (const entry of fs.readdirSync(GOAL_DIR, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".goal.json")) continue;
			const filePath = path.join(GOAL_DIR, entry.name);
			try {
				const stat = fs.statSync(filePath);
				const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GoalState>;
				const goal = normalizeGoalState(parsed);
				if (!goal.objective || goal.status === "idle") continue;
				candidates.push({
					sessionKey: "",
					sessionSlug: entry.name.replace(/\.goal\.json$/, ""),
					goal,
					updatedAt: stat.mtimeMs,
				});
			} catch {
				// Skip unreadable files.
			}
		}
	} catch {
		// Directory may not exist yet.
	}

	try {
		const legacyGoal = loadFileIfExists(GLOBAL_LEGACY_PATH);
		if (legacyGoal && legacyGoal.objective && legacyGoal.status !== "idle") {
			const stat = fs.statSync(GLOBAL_LEGACY_PATH);
			candidates.push({
				sessionKey: "",
				sessionSlug: "current-goal",
				goal: legacyGoal,
				updatedAt: stat.mtimeMs,
			});
		}
	} catch {
		// Legacy file is optional.
	}

	// Sort by startedAt descending (most recent first).
	candidates.sort((a, b) => b.goal.startedAt - a.goal.startedAt);
	return candidates.length > 0 ? candidates[0] : null;
}

// ═══════════════════════════════════════════════════════════
// Legacy (deprecated) — kept for backward compat in Pi CLI only
// ═══════════════════════════════════════════════════════════

/** @deprecated Use loadSessionDiskGoalState(sessionKey) instead. */
export function loadDiskGoalState(): GoalState | null {
	return loadFileIfExists(GLOBAL_LEGACY_PATH);
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

export function isActive(gs: GoalState): boolean {
	return gs.status === "running" || gs.status === "wrapping-up";
}

export function progressText(gs: GoalState): string {
	if (gs.progressCurrent !== null && gs.progressTotal !== null) {
		const label = gs.progressLabel ?? "Progress";
		return `${label}: ${gs.progressCurrent}/${gs.progressTotal} — Run ${gs.turnCount}`;
	}
	if (gs.planItems.length === 0) return `Run ${gs.turnCount}`;
	const done = gs.planDone.filter(Boolean).length;
	const total = gs.planItems.length;
	return `${done}/${total} items done — Run ${gs.turnCount}`;
}
