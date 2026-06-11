# Memory

A multi-layer persistent memory extension for the Pi Coding Agent.

## Layers

1. **Session memory** — compact summaries of the current session that survive context compaction
2. **Project memory** — durable project knowledge stored in `MEMORY.md`
3. **Memory tooling** — explicit save/search/edit/clear actions for the model

## Why it exists

Long-running agent work benefits from preserving:
- decisions
- facts about the codebase or project
- reminders across compaction boundaries
- durable project-level knowledge that should reappear in future sessions

This extension exists to make that workflow practical inside Pi.
