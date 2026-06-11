# Pi Extensions

A curated public extension pack for the Pi Coding Agent.

This repository is a fresh public extraction from a larger private working environment. It focuses on the Pi-side extensions that are broadly useful, reasonably portable, and safe to publish.

## Why this exists

I wanted Pi to behave less like a minimal coding harness and more like a configurable agent workspace with:
- better planning flows
- safer subagent delegation
- persistent memory
- autonomous goal execution
- lightweight web tools
- orchestration helpers
- simple task tracking

These extensions were built for that purpose.

They also pair naturally with **Pi Web UI**, but they are intended to be useful on their own as Pi extensions.

## Included extensions

### Included
- `agent-discovery/` — inject available subagent names into the prompt to reduce invalid agent calls
- `enhanced-plan-mode/` — structured planning workflow with approval / continuation commands
- `goal-engine/` — autonomous multi-turn goal execution for Pi
- `memory/` — persistent multi-layer memory for projects and sessions
- `parallel-orchestrator/` — git worktree-based orchestration helpers
- `subagent/` — safer delegated-agent execution wrapper
- `subagent-evaluator/` — mandatory quality evaluation loop for subagent outputs
- `web-tools/` — native TypeScript web search/fetch tools
- `todo.ts` — simple in-session task tracking

## Relationship to Pi Web UI

These extensions complement Pi Web UI especially well:
- some status and widget flows are richer when these extensions are installed
- Pi Web UI can still function without them, but the workflow feels more minimal

## Installation model

Pi discovers extensions from `~/.pi/agent/extensions/`.

A common pattern is:

```bash
mkdir -p ~/.pi/agent/extensions/<extension-name>
cp -r <extension-folder>/* ~/.pi/agent/extensions/<extension-name>/
```

For the standalone todo extension:

```bash
cp todo.ts ~/.pi/agent/extensions/
```

Then reload Pi.

## Notes on documentation

Some extension docs still mention concrete Pi filesystem locations such as `~/.pi/agent/extensions/` or `~/.pi/plans/`. Those are normal for Pi-oriented tooling and are part of the intended installation shape.

Where older docs referenced private source paths, they have been cleaned or should be treated as historical implementation detail rather than a required path.

## Public-release note

This repository does **not** include the broader private experimentation material from which these runtime extensions were selected. It is intentionally narrower so it can be published safely and understood by outside users.

Some internal-only or more environment-specific extension work was intentionally left out of this public extraction.

## License

MIT
