/**
 * Subagent Evaluator Extension
 *
 * Post-hoc interrogation of a subagent you ALREADY ran with the `subagent`
 * tool. This tool does NOT start new top-level work. It re-engages the SAME
 * subagent (with memory of its original task and the report it produced) so the
 * orchestrating agent can ask pointed, even tough, follow-up questions when a
 * report came back vague, summarized, or missing detail.
 *
 * Design intent:
 *   - `subagent`            → launch / delegate (returns a run_id)
 *   - `evaluated_subagent`  → interrogate that run_id afterwards (this file)
 *
 * Flow:
 *   1. Main agent runs `subagent({ agent, task })` → gets a report + run_id.
 *   2. If the report is insufficient, main agent calls
 *        evaluated_subagent({ run_id, questions: [...] })
 *      which re-spawns the same agent with its prior task + report + the
 *      follow-up questions, and returns detailed answers.
 *   3. Repeat with the same run_id to keep digging (each round is remembered).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// === Harness constants (harmonized with the subagent extension) ===
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SUBAGENT_DEPTH = 5;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
// Cap how many prior interrogation rounds we replay into the child prompt so
// repeated questioning does not blow up the context window.
const MAX_PRIOR_ROUNDS_IN_PROMPT = 3;

function getCurrentDepth(): number {
	const depthStr = process.env[SUBAGENT_DEPTH_ENV];
	if (!depthStr) return 0;
	const depth = parseInt(depthStr, 10);
	return Number.isNaN(depth) ? 0 : depth;
}

function canSpawnSubagent(currentDepth: number): boolean {
	return currentDepth < MAX_SUBAGENT_DEPTH;
}

// === Subagent run store (shared on-disk registry written by the subagent tool) ===
interface SubagentRunRecord {
	runId: string;
	agent: string;
	agentSource: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	task: string;
	cwd: string;
	report: string;
	toolTrail: string[];
	rounds: { questions: string[]; answer: string }[];
	createdAt: string;
}

function getRunStoreDir(): string {
	const dir = path.join(getAgentDir(), "subagent-runs");
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		/* ignore */
	}
	return dir;
}

function runRecordPath(runId: string): string {
	const safe = runId.replace(/[^\w.-]+/g, "");
	return path.join(getRunStoreDir(), `${safe}.json`);
}

function loadRunRecord(runId: string): SubagentRunRecord | null {
	try {
		const p = runRecordPath(runId);
		if (!fs.existsSync(p)) return null;
		return JSON.parse(fs.readFileSync(p, "utf-8")) as SubagentRunRecord;
	} catch {
		return null;
	}
}

function saveRunRecord(record: SubagentRunRecord): void {
	try {
		fs.writeFileSync(runRecordPath(record.runId), JSON.stringify(record), {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {
		/* best-effort */
	}
}

// === Usage formatting ===
interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function formatUsageStats(usage: Usage): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turns`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

// === Legacy fallback: discover an agent's persona from disk by name ===
// Used only when a run record predates persona persistence.
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);
	if (!match) return { frontmatter: {}, body: content };
	const lines = match[1].split("\n");
	const frontmatter: Record<string, string> = {};
	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			frontmatter[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
		}
	}
	return { frontmatter, body: match[2] };
}

function discoverAgentByName(cwd: string, name: string): SubagentRunRecord | null {
	const dirs: string[] = [path.join(getAgentDir(), "agents")];
	let currentDir = cwd;
	while (true) {
		dirs.push(path.join(currentDir, ".pi", "agents"));
		const parent = path.dirname(currentDir);
		if (parent === currentDir) break;
		currentDir = parent;
	}
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir)) {
			if (!entry.endsWith(".md")) continue;
			try {
				const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(dir, entry), "utf-8"));
				if (frontmatter.name === name) {
					const tools = frontmatter.tools
						?.split(",")
						.map((t) => t.trim())
						.filter(Boolean);
					return {
						runId: "",
						agent: name,
						agentSource: dir.includes(".pi/agents") ? "project" : "user",
						model: frontmatter.model,
						tools: tools && tools.length > 0 ? tools : undefined,
						systemPrompt: body,
						task: "",
						cwd,
						report: "",
						toolTrail: [],
						rounds: [],
						createdAt: new Date().toISOString(),
					};
				}
			} catch {
				/* skip */
			}
		}
	}
	return null;
}

// === Run a child pi process for the same agent persona ===
interface ChildResult {
	output: string;
	diagnostics: string;
	usage: Usage;
	exitCode: number;
	timedOut: boolean;
	hadFinalOutput: boolean;
	errorMessage?: string;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evaluator-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

async function runChildAgent(
	persona: { agent: string; systemPrompt: string; model?: string; tools?: string[] },
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	currentDepth: number,
	timeoutMs: number,
): Promise<ChildResult> {
	if (!canSpawnSubagent(currentDepth)) {
		return {
			output: `Subagent did not run: maximum subagent depth (${MAX_SUBAGENT_DEPTH}) exceeded.`,
			diagnostics: `Maximum subagent depth (${MAX_SUBAGENT_DEPTH}) exceeded.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			exitCode: 1,
			timedOut: false,
			hadFinalOutput: false,
			errorMessage: "Max depth exceeded",
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (persona.model) args.push("--model", persona.model);
	if (persona.tools && persona.tools.length > 0) args.push("--tools", persona.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const messages: Message[] = [];
	let stderr = "";
	let wasAborted = false;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let errorMessage: string | undefined;

	try {
		if (persona.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(persona.agent, persona.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const childEnv = { ...process.env, [SUBAGENT_DEPTH_ENV]: String(currentDepth + 1) };
		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: Message };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					const msg = event.message;
					messages.push(msg);
					if (event.type === "message_end" && msg.role === "assistant") {
						usage.turns++;
						const msgUsage = msg.usage;
						if (msgUsage) {
							usage.input += msgUsage.input || 0;
							usage.output += msgUsage.output || 0;
							usage.cacheRead += msgUsage.cacheRead || 0;
							usage.cacheWrite += msgUsage.cacheWrite || 0;
							usage.cost += msgUsage.cost?.total || 0;
						}
						if (msg.errorMessage) errorMessage = msg.errorMessage;
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			timeoutId = setTimeout(() => {
				wasAborted = true;
				stderr += `Subagent timed out after ${timeoutMs / 1000} seconds. Terminating...\n`;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);

			proc.on("close", (code) => {
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
				if (buffer.trim()) processLine(buffer);
				resolve(wasAborted ? 124 : (code ?? 0));
			});

			proc.on("error", () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		// Extract final assistant text.
		let output = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				for (const part of msg.content) {
					if (part.type === "text") {
						output = part.text;
						break;
					}
				}
				if (output) break;
			}
		}

		const hadFinalOutput = Boolean(output);
		if (!output) {
			output = wasAborted
				? `Subagent timed out after ${timeoutMs / 1000} seconds. No final assistant answer was produced.`
				: "Subagent finished without a final assistant answer.";
		}

		// Diagnostics are kept strictly separate from report content. We never
		// promote stderr into the answer text.
		return {
			output,
			diagnostics: stderr,
			usage,
			exitCode,
			timedOut: wasAborted || exitCode === 124,
			hadFinalOutput,
			errorMessage,
		};
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

// === Build the interrogation prompt for the re-engaged subagent ===
function buildInterrogationPrompt(record: SubagentRunRecord, questions: string[], successCriteria?: string): string {
	const priorRounds = record.rounds.slice(-MAX_PRIOR_ROUNDS_IN_PROMPT);
	const sections: string[] = [];

	sections.push(
		[
			"You are being re-engaged by the orchestrating agent to answer follow-up questions",
			"about work you previously performed as a delegated subagent. Treat this as an interrogation:",
			"be specific, concrete, and evidence-backed. Do NOT be vague or over-summarize.",
			"Re-inspect files, run read-only commands, and quote exact paths / line numbers where relevant.",
			"If you cannot determine something, say so explicitly rather than guessing.",
		].join(" "),
	);

	sections.push(`## Your original task\n${record.task}`);

	if (record.report.trim()) {
		sections.push(`## The report you previously returned\n${record.report.trim()}`);
	}

	if (record.toolTrail.length > 0) {
		sections.push(`## Actions you took (tool trail)\n${record.toolTrail.map((t) => `- ${t}`).join("\n")}`);
	}

	for (const round of priorRounds) {
		sections.push(
			`## Earlier follow-up round\nQuestions:\n${round.questions
				.map((q, i) => `${i + 1}. ${q}`)
				.join("\n")}\n\nYour answer:\n${round.answer}`,
		);
	}

	sections.push(
		`## New follow-up questions (answer every one, in order)\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
	);

	if (successCriteria?.trim()) {
		sections.push(`## What a satisfactory answer must include\n${successCriteria.trim()}`);
	}

	sections.push(
		"Answer each question directly and in detail. Number your answers to match the questions. Return partial findings before stopping if you run low on time.",
	);

	return sections.join("\n\n");
}

// === Schema ===
const EvaluatedSubagentParams = Type.Object({
	run_id: Type.String({
		description:
			"The run_id returned by a prior `subagent` call. Identifies which subagent run you want to interrogate. Run `subagent` first if you do not have one.",
	}),
	questions: Type.Array(Type.String(), {
		description:
			"One or more pointed follow-up questions for the subagent about what it actually did, the evidence, edge cases, or gaps in its report.",
		minItems: 1,
	}),
	success_criteria: Type.Optional(
		Type.String({ description: "Optional: what a satisfactory set of answers must include." }),
	),
	timeout_seconds: Type.Optional(
		Type.Number({
			description: "Interrogation child timeout in seconds (default 600).",
			default: 600,
			minimum: 30,
			maximum: 1800,
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory override (defaults to the original run's cwd)." }),
	),
});

export default function subagentEvaluatorExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "evaluated_subagent",
		label: "Interrogate Subagent",
		description: [
			"Ask follow-up / probing questions to a subagent you ALREADY ran with the `subagent` tool.",
			"Use this when a subagent's report was vague, summarized, or missing detail: it re-engages the SAME subagent",
			"(with memory of its original task and prior report) so it can answer your specific questions in depth.",
			"Requires the run_id returned by a prior `subagent` call. This does NOT start new top-level work — run `subagent` first.",
			"Call it again with the same run_id to keep digging; each round is remembered.",
		].join(" "),
		parameters: EvaluatedSubagentParams,
		promptSnippet: 'evaluated_subagent({ run_id: "sa_...", questions: ["..."] })',
		promptGuidelines: [
			"Only call this AFTER a `subagent` run whose report needs more depth — never as the first delegation step.",
			"Pass the run_id from that subagent result.",
			"Ask specific, pointed questions about what the subagent actually did, its evidence, edge cases, and gaps.",
			"Call again with the same run_id to interrogate further until the answers are detailed enough.",
		],

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
			const currentDepth = getCurrentDepth();
			if (currentDepth > 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`Error: evaluated_subagent can only be called from the main agent (depth 0). ` +
								`Current depth: ${currentDepth}. This prevents runaway recursion.`,
						},
					],
					error: true,
				};
			}

			if (!params.questions || params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Provide at least one follow-up question in `questions`." }],
					error: true,
				};
			}

			const record = loadRunRecord(params.run_id);
			if (!record) {
				return {
					content: [
						{
							type: "text",
							text:
								`No subagent run found for run_id "${params.run_id}". ` +
								`Run the \`subagent\` tool first, then pass the run_id it returns here to interrogate that subagent. ` +
								`evaluated_subagent does not start new top-level work.`,
						},
					],
					error: true,
				};
			}

			// Prefer the persona persisted with the run. Fall back to disk discovery
			// for legacy records that predate persona persistence.
			let persona = {
				agent: record.agent,
				systemPrompt: record.systemPrompt ?? "",
				model: record.model,
				tools: record.tools,
			};
			if (!persona.systemPrompt) {
				const discovered = discoverAgentByName(params.cwd ?? record.cwd ?? ctx.cwd, record.agent);
				if (discovered) {
					persona = {
						agent: discovered.agent,
						systemPrompt: discovered.systemPrompt,
						model: discovered.model ?? record.model,
						tools: discovered.tools ?? record.tools,
					};
				}
			}

			const timeoutMs = Math.min(Math.max(params.timeout_seconds ?? 600, 30), 1800) * 1000 || DEFAULT_TIMEOUT_MS;
			const cwd = params.cwd ?? record.cwd ?? ctx.cwd;
			const prompt = buildInterrogationPrompt(record, params.questions, params.success_criteria);

			const result = await runChildAgent(persona, prompt, cwd, signal, currentDepth, timeoutMs);
			const round = record.rounds.length + 1;

			if (!result.hadFinalOutput || result.timedOut || result.exitCode !== 0) {
				// Preserve the record so the orchestrator can retry with narrower
				// questions. Keep diagnostics clearly separate from any answer text.
				return {
					content: [
						{
							type: "text",
							text: [
								`The subagent did not produce a usable answer for this interrogation round.`,
								`Status: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}`,
								result.output,
								result.diagnostics ? `\nDiagnostics:\n${result.diagnostics}` : "",
								`Retry with fewer/narrower questions (run_id ${record.runId} is still available).`,
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: {
						run_id: record.runId,
						agent: record.agent,
						round,
						failed: true,
						timedOut: result.timedOut,
						hadFinalOutput: result.hadFinalOutput,
						exitCode: result.exitCode,
						diagnostics: result.diagnostics,
						usage: result.usage,
					},
					error: true,
				};
			}

			record.rounds.push({ questions: params.questions, answer: result.output });
			saveRunRecord(record);

			const header = `📋 SUBAGENT INTERROGATION — ${record.agent} (run_id ${record.runId}, round ${round})`;
			const questionList = params.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
			const body = [
				header,
				"",
				"Questions asked:",
				questionList,
				"",
				"Subagent's answers:",
				result.output,
			].join("\n");

			return {
				content: [{ type: "text", text: body }],
				details: {
					run_id: record.runId,
					agent: record.agent,
					round,
					timedOut: result.timedOut,
					hadFinalOutput: result.hadFinalOutput,
					exitCode: result.exitCode,
					usage: result.usage,
				},
			};
		},

		renderResult(result, options, theme) {
			const details = result.details as
				| { agent?: string; round?: number; usage?: Usage; failed?: boolean }
				| undefined;
			if (!details) {
				return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
			}

			const container = new Container();
			const isError = details.failed === true;
			const head = isError
				? theme.fg("error", `✗ Interrogation failed (${details.agent ?? "?"}, round ${details.round ?? "?"})`)
				: theme.fg("accent", `📋 Subagent Interrogation — ${details.agent ?? "?"} (round ${details.round ?? "?"})`);
			container.addChild(new Text(head, 0, 0));

			if (options.expanded) {
				container.addChild(new Text("", 0, 0));
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				const lines = text.split("\n").slice(0, 40);
				container.addChild(new Text(lines.join("\n"), 0, 0));
				if (text.split("\n").length > 40) {
					container.addChild(new Text(theme.fg("muted", "... (Ctrl+O collapsed; truncated)"), 0, 0));
				}
			} else {
				container.addChild(new Text(theme.fg("muted", "Answers received (Ctrl+O to expand)."), 0, 0));
			}

			if (details.usage) {
				container.addChild(new Text(theme.fg("dim", formatUsageStats(details.usage)), 0, 0));
			}
			return container;
		},
	});
}
