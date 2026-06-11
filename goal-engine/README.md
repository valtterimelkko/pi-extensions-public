# Goal Engine

Autonomous multi-turn goal execution for the Pi Coding Agent.

## What it does

Goal Engine lets Pi keep working toward a defined objective across multiple turns instead of treating each turn as isolated.

Typical capabilities:
- start a goal
- pause and resume
- restore persisted goals
- cap the number of autonomous runs
- inject progress-aware goal context into the prompt
- keep state session-scoped so goals do not leak across sessions

## Commands

- `/goal "objective"`
- `/goal pause`
- `/goal resume`
- `/goal resume-last`
- `/goal clear`
- `/goal status`
- `/goal report`
- `/goal limit <n>`

## Notes

This extension was designed to work well both in plain Pi sessions and in browser-driven Pi Web UI sessions where session-scoped persistence matters.
