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

## Why it exists

Delegated-agent workflows are powerful, but they can also become noisy or runaway-prone. This extension aims to keep the benefits while reducing some common failure modes.
