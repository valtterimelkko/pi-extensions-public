# Subagent Evaluator Extension

A Pi Coding Agent extension that lets the orchestrating agent **interrogate a subagent
it already ran** — asking pointed, even tough, follow-up questions when a subagent's
report comes back vague, summarized, or missing detail.

## Design intent

Two tools, two distinct jobs:

| Tool | Role |
|------|------|
| `subagent` (subagent extension) | **Launch / delegate.** Runs a specialized subagent in an isolated context and returns a report **plus a `run_id`**. |
| `evaluated_subagent` (this extension) | **Interrogate afterwards.** Re-engages the *same* subagent (with memory of its original task and report) to answer follow-up questions in depth. |

`evaluated_subagent` is **not** a launcher. It does not start new top-level work. You
must run `subagent` first and pass the `run_id` it returns. This is the whole point:
delegation goes through `subagent`; deeper questioning goes through `evaluated_subagent`.

## Why

Subagents return a report and then their process exits. Reports are often
over-summarized: they state conclusions but omit the evidence, edge cases, and the
"what did you actually check?" detail the orchestrator needs. Re-running the whole task
from scratch is wasteful and loses continuity. `evaluated_subagent` instead re-engages
the same persona with its prior task + report as context, so it can answer precisely.

## Usage

```typescript
// 1. Launch (subagent tool) — returns a run_id
subagent({ agent: "reviewer", task: "Review the screen-view changes for parity bugs" })
// → report ... "[subagent run_id: sa_1750..._ab12cd3]"

// 2. Interrogate (this tool) — pass that run_id
evaluated_subagent({
  run_id: "sa_1750..._ab12cd3",
  questions: [
    "Which exact files and line numbers did you inspect for the tool-collapse parity claim?",
    "Did you actually run the conformance test, or infer the result? Quote the command if you ran it.",
    "What edge cases did you NOT cover?"
  ],
  success_criteria: "Each answer cites concrete paths/lines and distinguishes verified vs inferred."
})

// 3. Repeat with the same run_id to keep digging. Each round is remembered.
```

### Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `run_id` | yes | The `run_id` returned by a prior `subagent` call. |
| `questions` | yes | One or more pointed follow-up questions (≥1). |
| `success_criteria` | no | What a satisfactory set of answers must include. |
| `timeout_seconds` | no | Interrogation child timeout (default 600, 30–1800). |
| `cwd` | no | Working directory override (defaults to the original run's cwd). |

## How it works

- The `subagent` tool persists every run to `~/.pi/agent/subagent-runs/<run_id>.json`
  (agent persona, original task, report, tool trail).
- `evaluated_subagent` loads that record, builds an interrogation prompt
  (original task + prior report + tool trail + prior rounds + your questions), and
  re-spawns the **same** agent persona (`pi --mode json -p --no-session`).
- The subagent's answers are returned to the orchestrator and appended to the run
  record, so subsequent rounds keep full context (last few rounds are replayed).

## Robustness

- Diagnostics (`stderr`) are kept strictly separate from answer text — stderr is never
  promoted into a report.
- If a round times out or produces no final answer, the tool returns a clear,
  structured failure (with `hadFinalOutput`, `timedOut`, `exitCode`, diagnostics) and
  **keeps the run record** so you can retry with narrower questions.
- Recursion guard: `evaluated_subagent` only runs from the main agent (depth 0);
  interrogation children run one level deeper and are bounded by `MAX_SUBAGENT_DEPTH`.

## License

MIT - Part of Pi Enhancement Project
