/**
 * Memory extractor
 *
 * Extracts key information from conversation turns for both session
 * and auto-memory. Uses heuristic extraction (no API call needed).
 */

import { formatDate } from "./storage.js";

// --- Extraction interfaces ---

export interface ExtractionResult {
	/** Brief summary of what happened in this turn */
	summary: string;
	/** Durable facts worth persisting across sessions */
	facts: string[];
	/** Decisions made (architecture, patterns, etc.) */
	decisions: string[];
	/** Code patterns or techniques discovered */
	patterns: string[];
	/** User preferences observed */
	preferences: string[];
	/** Topics/tags for categorization */
	topics: string[];
}

// --- Simple extraction (no LLM call) ---

/**
 * Extract key information from turn messages using heuristics.
 */
export function extractFromTurn(
	assistantText: string,
	toolCalls: Array<{ name: string; input: Record<string, unknown>; output?: string }>,
): ExtractionResult {
	const facts: string[] = [];
	const decisions: string[] = [];
	const patterns: string[] = [];
	const preferences: string[] = [];
	const topics: string[] = [];

	// Extract from tool calls
	const filesRead: string[] = [];
	const filesWritten: string[] = [];
	const commandsRun: string[] = [];

	for (const tc of toolCalls) {
		if (tc.name === "read" && tc.input.path) {
			filesRead.push(String(tc.input.path));
		} else if (tc.name === "write" && tc.input.path) {
			filesWritten.push(String(tc.input.path));
		} else if (tc.name === "edit" && tc.input.path) {
			filesWritten.push(String(tc.input.path));
		} else if (tc.name === "bash" && tc.input.command) {
			const cmd = String(tc.input.command);
			if (cmd.length < 200) {
				commandsRun.push(cmd);
			}
		}
	}

	// Extract topics from file paths
	for (const f of [...filesRead, ...filesWritten]) {
		const parts = f.split("/");
		if (parts.length > 1) {
			topics.push(parts[parts.length - 2]);
		}
		const ext = f.split(".").pop();
		if (ext && ext.length < 6) {
			topics.push(ext);
		}
	}

	// Look for decision patterns in assistant text
	const decisionPatterns = [
		/(?:I|we|let's|should)\s+(?:will|should)?\s*(?:use|go with|implement|choose|decided to|refactor to|switch to)\s+(.+)/gi,
		/(?:the (?:best|recommended|preferred) (?:approach|way|pattern|method) (?:is|would be))\s+(.+)/gi,
	];

	for (const pattern of decisionPatterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(assistantText)) !== null) {
			const decision = match[1]?.trim();
			if (decision && decision.length > 5 && decision.length < 200) {
				decisions.push(decision.slice(0, 150));
			}
		}
	}

	// Build summary
	const parts: string[] = [];
	if (filesRead.length > 0) {
		parts.push(`Read: ${filesRead.slice(0, 5).join(", ")}`);
	}
	if (filesWritten.length > 0) {
		parts.push(`Modified: ${filesWritten.slice(0, 5).join(", ")}`);
	}
	if (commandsRun.length > 0 && commandsRun.length <= 3) {
		parts.push(`Ran: ${commandsRun.map((c) => c.length > 50 ? c.slice(0, 50) + "…" : c).join("; ")}`);
	}
	const summary = parts.join(". ") || "No significant tool activity";

	return {
		summary,
		facts,
		decisions,
		patterns,
		preferences,
		topics: [...new Set(topics)].slice(0, 10),
	};
}

// --- Memory formatting ---

/**
 * Build a session memory update from extraction results.
 */
export function formatSessionMemoryUpdate(
	turnIndex: number,
	extraction: ExtractionResult,
): string {
	const lines: string[] = [];
	lines.push(`### Turn ${turnIndex + 1}`);
	lines.push(`**Summary**: ${extraction.summary}`);

	if (extraction.decisions.length > 0) {
		lines.push("**Decisions**:");
		for (const d of extraction.decisions) {
			lines.push(`- ${d}`);
		}
	}

	if (extraction.facts.length > 0) {
		lines.push("**Facts**:");
		for (const f of extraction.facts) {
			lines.push(`- ${f}`);
		}
	}

	return lines.join("\n") + "\n\n";
}

/**
 * Build auto-memory entries from extraction results.
 */
export function formatAutoMemoryEntries(extraction: ExtractionResult): Array<{
	type: string;
	date: string;
	topics: string[];
	content: string;
}> {
	const entries: Array<{ type: string; date: string; topics: string[]; content: string }> = [];
	const date = formatDate();

	for (const fact of extraction.facts) {
		entries.push({ type: "learned", date, topics: extraction.topics, content: fact });
	}

	for (const decision of extraction.decisions) {
		entries.push({ type: "decision", date, topics: extraction.topics, content: decision });
	}

	for (const pattern of extraction.patterns) {
		entries.push({ type: "pattern", date, topics: extraction.topics, content: pattern });
	}

	for (const pref of extraction.preferences) {
		entries.push({ type: "preference", date, topics: extraction.topics, content: pref });
	}

	return entries;
}
