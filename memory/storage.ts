/**
 * Memory storage utilities
 *
 * Manages reading/writing memory files with proper truncation,
 * directory management, and project slug generation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

// --- Limits (matching Claude Code's memory system) ---

export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const MAX_SESSION_MEMORY_LINES = 300;
export const MAX_SESSION_MEMORY_BYTES = 40_000;
export const MAX_TOPIC_LINES = 500;
export const MAX_TOPIC_BYTES = 50_000;

// --- Path helpers ---

export function getAgentDir(): string {
	return AGENT_DIR;
}

export function getMemoryDir(projectSlug: string): string {
	return path.join(AGENT_DIR, "memory", projectSlug);
}

export function getSessionMemoryDir(): string {
	return path.join(AGENT_DIR, "session-memory");
}

export function getEntrypointPath(projectSlug: string): string {
	return path.join(getMemoryDir(projectSlug), "MEMORY.md");
}

export function getSessionMemoryPath(sessionFile: string | undefined): string | null {
	if (!sessionFile) return null;
	// Use hash of session file path as identifier
	const hash = crypto.createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
	return path.join(getSessionMemoryDir(), `${hash}.md`);
}

/**
 * Generate a project slug from cwd.
 * e.g. "/home/user/projects/my-app" → "my-app"
 * e.g. "/home/user/projects/my-app" + "/home/user/pi-web-ui" → "pi-web-ui"
 */
export function projectSlug(cwd: string): string {
	const base = path.basename(cwd);
	// Sanitize for filesystem
	return base.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
}

// --- Truncation ---

export interface TruncationResult {
	content: string;
	wasTruncated: boolean;
	originalLines: number;
	originalBytes: number;
}

/**
 * Truncate content to fit within line and byte limits.
 * Line-truncate first, then byte-truncate at the last newline boundary.
 */
export function truncateContent(
	content: string,
	maxLines: number,
	maxBytes: number,
): TruncationResult {
	const originalLines = content.split("\n").length;
	const originalBytes = Buffer.byteLength(content, "utf-8");

	let result = content;

	// Step 1: Line truncation
	const lines = result.split("\n");
	if (lines.length > maxLines) {
		result = lines.slice(0, maxLines).join("\n");
		result += `\n\n<!-- Memory truncated at ${maxLines} lines (was ${originalLines}) -->`;
	}

	// Step 2: Byte truncation at newline boundary
	const bytes = Buffer.byteLength(result, "utf-8");
	if (bytes > maxBytes) {
		// Walk backwards from maxBytes to find a newline
		const buf = Buffer.from(result, "utf-8");
		let cutPoint = maxBytes;
		while (cutPoint > 0 && buf[cutPoint] !== 0x0a) {
			cutPoint--;
		}
		if (cutPoint === 0) cutPoint = maxBytes; // No newline found, hard cut
		result = buf.slice(0, cutPoint).toString("utf-8");
		result += `\n\n<!-- Memory truncated at ~${maxBytes} bytes -->`;
	}

	return {
		content: result,
		wasTruncated: originalLines > maxLines || originalBytes > maxBytes,
		originalLines,
		originalBytes,
	};
}

// --- File I/O ---

export async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

export async function readFileContent(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8");
	} catch {
		return null;
	}
}

export async function writeFileContent(filePath: string, content: string): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, content, "utf-8");
}

export async function appendFileContent(filePath: string, content: string): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await fs.appendFile(filePath, content, "utf-8");
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function deleteFile(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath);
	} catch {
		// Ignore if file doesn't exist
	}
}

export async function listFiles(dirPath: string, extension: string = ".md"): Promise<string[]> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile() && e.name.endsWith(extension))
			.map((e) => e.name);
	} catch {
		return [];
	}
}

// --- Memory formatting ---

export interface MemoryEntry {
	type: string;
	date: string;
	topics: string[];
	content: string;
}

/**
 * Parse frontmatter from a memory file.
 * Supports simple YAML-like frontmatter between --- delimiters.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const fm: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value: unknown = line.slice(colonIdx + 1).trim();
		// Parse arrays like [a, b, c]
		if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
			value = value.slice(1, -1).split(",").map((s) => s.trim());
		}
		fm[key] = value;
	}

	return { frontmatter: fm, body: match[2] };
}

/**
 * Create a memory entry with frontmatter.
 */
export function formatMemoryEntry(entry: MemoryEntry): string {
	const topics = entry.topics.length > 0 ? `[${entry.topics.join(", ")}]` : "[]";
	return `---\ntype: ${entry.type}\ndate: ${entry.date}\ntopics: ${topics}\n---\n\n${entry.content}\n`;
}

/**
 * Format current date as YYYY-MM-DD.
 */
export function formatDate(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10);
}
