# Subagent

A delegated-agent extension for the Pi Coding Agent with additional safety constraints.

## What it does

This extension spawns separate Pi processes for delegated tasks so they get isolated context windows.

Supported modes:
- single delegated task
- parallel delegated tasks
- chained delegated tasks using previous output

## Safety additions

Compared with a minimal delegated-agent flow, this variant adds guardrails such as:
- timeout limits
- maximum nesting depth
- clearer usage/accounting surfaces

## Run IDs and follow-up interrogation

Every run returns a **`run_id`** and is persisted to `~/.pi/agent/subagent-runs/`.
This makes `subagent` the *launcher*, and pairs it with the companion
`evaluated_subagent` tool (subagent-evaluator extension), which is the
*post-hoc interrogation* tool: if a subagent's report is vague or under-detailed,
the orchestrator passes that `run_id` to `evaluated_subagent` to re-engage the
**same** subagent with pointed follow-up questions — instead of re-running the
whole task from scratch.

## Why it exists

Delegated-agent workflows are powerful, but they can also become noisy or runaway-prone. This extension aims to keep the benefits while reducing some common failure modes.
