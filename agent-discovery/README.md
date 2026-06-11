# Agent Discovery Extension

Automatically injects available subagent names into the system prompt so the LLM knows what agents are available BEFORE making tool calls.

## Problem

When using the `subagent` tool, the LLM doesn't know which agents exist. This leads to:

1. **Wrong agent names** - LLM calls `web-search` instead of `scout` or `web-researcher`
2. **Skills vs Agents confusion** - LLM calls skills as if they were agents
3. **Wasted turns** - Failed calls, error messages, retries

## Solution

This extension:

1. **Discovers agents** from `~/.pi/agent/agents/` and `.pi/agents/` on every turn
2. **Injects agent list** into system prompt via `before_agent_start` hook
3. **Validates subagent calls** via `tool_call` hook with helpful error messages

## Installation

```bash
# Create extension directory
mkdir -p ~/.pi/agent/extensions/agent-discovery

# Copy extension
cp index.ts ~/.pi/agent/extensions/agent-discovery/

# Reload Pi
pi /reload
```

## How It Works

### Before (Without This Extension)

```
LLM: "I'll use subagent to search the web..."
Tool Call: subagent({ agent: "web-search", task: "..." })
Error: Unknown agent: "web-search". Available agents: scout, web-researcher, ...
LLM: "Let me try again with web-researcher..."
```

### After (With This Extension)

```
System Prompt includes:
  ## Available Subagents
  - **scout**: Codebase reconnaissance
  - **web-researcher**: Quick web research
  - **deep-research**: Exhaustive analysis
  ...

LLM: "I'll use the web-researcher agent..."
Tool Call: subagent({ agent: "web-researcher", task: "..." })
Success!
```

## Features

### System Prompt Injection

The extension adds a section to the system prompt listing all available agents:

```
## Available Subagents

The following agents are available for the `subagent` tool:

- **scout**: Codebase reconnaissance
- **web-researcher**: Quick web research (1-2 min)
- **deep-research**: Exhaustive analysis (5-6 min)
- **planner**: Implementation planning
- **architect**: System design
- **worker**: Task execution
- **reviewer**: Code review

Usage: `subagent({ agent: "agent-name", task: "..." })`
```

### Smart Error Messages

If the LLM still calls an unknown agent, the validation hook provides helpful context:

```
Unknown agent(s): "web-search". 
Available agents: "scout", "web-researcher", "deep-research", ...

Note: "web-search" appears to be a skill, not an agent. 
Use the corresponding tool directly (e.g., `web_search` tool) 
or use the `web-researcher` or `scout` agent to leverage these skills.
```

### Project-Local Agents

The extension also discovers agents from `.pi/agents/` in your project, allowing project-specific agent definitions.

## Configuration

No configuration needed. The extension automatically:

- Discovers agents from `~/.pi/agent/agents/` (user scope)
- Discovers agents from `.pi/agents/` (project scope)
- Merges them with project agents taking precedence

## Adding New Agents

Just add a new `.md` file to `~/.pi/agent/agents/`:

```markdown
---
name: my-agent
description: Does something useful
tools: read, bash, web_search
---

You are an agent that does something useful...
```

The extension will automatically pick it up on the next turn - no reload needed!

## Technical Details

### Hooks Used

1. **`before_agent_start`** - Injects agent list into system prompt
2. **`tool_call`** - Validates subagent calls before execution

### Agent Discovery

Agents are discovered fresh on every turn by:

1. Scanning `~/.pi/agent/agents/*.md` for user agents
2. Walking up from CWD to find `.pi/agents/` for project agents
3. Parsing frontmatter for `name`, `description`, `tools`, `model`
4. Merging with project agents overriding user agents
