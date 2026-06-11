# Enhanced Plan Mode for Pi

A comprehensive planning mode extension for the Pi coding agent that combines structured planning with subagent orchestration.

## Features

### 🌊 Wave-Based Planning
Modular plan structure optimized for parallel execution:
- **Wave 1**: Foundation modules (dependencies for everything else)
- **Wave 2**: Independent modules (can be done in parallel)
- **Wave 3+**: Integration modules (depend on earlier waves)

### 🎯 Execution Mode Selection
Asked **before** planning begins:

| Mode | Best For | Description |
|------|----------|-------------|
| **Direct** | Simple projects, learning | Main session executes all steps |
| **Orchestrator** | Complex projects, context rot | Use subagents for parallel work |
| **Mixed** | Uncertain complexity | Decide per module during execution |

### 📊 Project Complexity (Orchestrator Mode)
When Orchestrator selected, guides plan structure:

| Complexity | Structure | Parallelization |
|------------|-----------|-----------------|
| **Simple** | 2-4 sequential phases | Minimal |
| **Moderate** | 4-6 modules, 2-3 waves | Some parallel opportunities |
| **Complex** | 6-10+ modules | Maximize (aim for 40%+ parallel) |

### ✅ Validation Strategy
Generic validation approach (works for ANY project type):

| Level | Software | Content/Docs | Data/Infra |
|-------|----------|--------------|------------|
| **Light** | Smoke tests | Check links/format | Verify core functionality |
| **Moderate** | Critical + business logic | Links + formatting + cross-refs | Data integrity + key integrations |
| **Comprehensive** | Full pyramid (80%+) | All links, formatting, refs, completeness | Full validation + error handling + performance |

### 📝 Execution Notes
Add preferences for **HOW** to execute (not what to do):

```markdown
## Execution Notes
- Use git: commit after each module, push to origin/main
- GLM agent skips frontend work (use kimi separately)
- Always add JSDoc comments
- Run tests after each wave
```

**Add via:**
- `/modify` → "Execution notes"
- At approval time (prompt asks before execution)

### 📋 Guided Modification Flow
`/modify` offers structured options:

| Option | Use For | Returns to Approval? |
|--------|---------|---------------------|
| 📝 Major changes | Content, scope, architecture | Yes |
| 🔧 Small tweaks | Wording, order, minor details | Yes |
| ⚙️ Execution notes | HOW to execute preferences | Yes |
| ❌ Cancel | Go back to review | N/A |

### 📁 Plan Persistence
- Plans saved to `~/.pi/plans/`
- Timestamp-based filenames
- Status tracking through lifecycle
- Resume anytime with `/continue`
- Sign off with `/done` (deletes plan file)

---

## Installation

### Prerequisites

```bash
# Pi must be installed
npm install -g @mariozechner/pi-coding-agent

# Subagent extension required
mkdir -p ~/.pi/agent/extensions/subagent
cp /path/to/pi/examples/extensions/subagent/* ~/.pi/agent/extensions/subagent/
cp /path/to/pi/examples/extensions/subagent/agents/*.md ~/.pi/agent/agents/
```

### Install Enhanced Plan Mode

```bash
# Copy to Pi extensions
mkdir -p ~/.pi/agent/extensions/enhanced-plan-mode
cp *.ts ~/.pi/agent/extensions/enhanced-plan-mode/

# Reload Pi
pi /reload
```

### Development Setup (Symlink)

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
ln -s /path/to/enhanced-plan-mode enhanced-plan-mode
pi /reload
```

---

## Usage

### Start Planning

```bash
# With task description
/plan Build a time tracking SaaS

# Or toggle plan mode first
/plan
```

**You'll be asked:**
1. Execution mode (Direct/Orchestrator/Mixed)
2. Project complexity (if Orchestrator)
3. Validation strategy (Light/Moderate/Comprehensive/None)

### During Planning

The agent will:
1. Ask clarifying questions about scope/requirements
2. Use subagent tool for wave-based analysis (if needed)
3. Create structured plan following the schema
4. Save plan to `~/.pi/plans/`

**Plan auto-saves** as agent refines it.

### Review and Modify

```bash
# Check status
/status

# View all saved plans
/plans

# Request modifications
/modify
```

### Approve and Execute

```bash
# Approve plan
/approve

# You'll be asked:
# 1. Any execution notes to add?
# 2. Select execution approach
# 3. Execution begins
```

### Resume or Complete

```bash
# Resume a saved plan
/continue

# Mark as complete (deletes plan file)
/done
```

---

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/plan [task]` | Ctrl+Shift+P | Start planning (asks mode/complexity/validation) |
| `/approve` | `a` or Ctrl+Shift+A | Approve plan, add execution notes, proceed |
| `/modify` | `m` or Ctrl+Shift+M | Guided modification (major/small/execution notes) |
| `/continue` | - | Resume a saved plan from `~/.pi/plans/` |
| `/done` | - | Sign off and delete plan file |
| `/reject` | `r` | Cancel planning mode |
| `/execute` | - | Execute approved plan (after /approve) |
| `/cancel` | - | Cancel planning (alias for /reject) |
| `/status` | - | Show current plan status |
| `/plans` | - | List all saved plans |

---

## Plan File Format

Plans are saved as markdown files in `~/.pi/plans/`:

```markdown
---
task: "Build time tracking SaaS"
created: "2026-03-09T10:30:00Z"
status: "approved"
risk_level: "medium"
estimated_effort: "large"
preferred_execution_mode: "orchestrator"
validation_strategy: "Comprehensive - Thorough validation..."
---

## Summary
Build a time tracking SaaS with Next.js and Supabase.

## Analysis

### Files to Read
- `src/config/` - Current configuration

### Files to Modify
- `src/app/api/` - API routes

### Dependencies
- Next.js 14
- Supabase

### Risks
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Auth complexity | medium | high | Use Supabase Auth |

## Implementation Plan

### Wave 1: Foundation

#### Module 1: Project Setup
**Dependencies**: None (foundation)
**Parallelizable**: No
**Effort**: 30 min
- Initialize Next.js
- Install dependencies
- Configure Tailwind

#### Module 2: Database Schema
**Dependencies**: Module 1
**Parallelizable**: No
**Effort**: 30 min
- Create schema.sql
- Set up Supabase

### Wave 2: Core Features (Parallel)

#### Module 3A: Auth Pages
**Dependencies**: Module 1, Module 2
**Parallelizable**: Yes
**Effort**: 1 hour
- Login page
- Signup page

#### Module 3B: Timer Component
**Dependencies**: Module 1
**Parallelizable**: Yes
**Effort**: 1 hour
- Timer display
- Timer controls

## Verification Plan

- [ ] Unit tests pass (>80% coverage)
- [ ] Integration tests pass
- [ ] E2E tests pass
- [ ] All acceptance criteria met

## Execution Notes
- Commit after each module
- GLM skips frontend (use kimi)
- Always add JSDoc
```

---

## Architecture

### Files

| File | Purpose |
|------|---------|
| `index.ts` | Main extension - commands, event handlers, UI |
| `types.ts` | TypeScript type definitions |
| `plan-schema.ts` | Plan file parsing, serialization, I/O |
| `analysis-orchestrator.ts` | Wave-based analysis using subagent tool |
| `risk-assessment.ts` | Risk matrix calculation (5 dimensions) |

### State Management

State is persisted via Pi's `appendEntry()` API:
- Plan mode enabled/disabled
- Current plan data
- Execution progress
- User preferences (mode, complexity, validation)

State survives session reloads.

### Tool Blocking

In plan mode:
- ✅ `read`, `bash` (safe), `grep`, `find`, `ls`, `subagent`
- ✅ `write`/`edit` - **ONLY** to `~/.pi/plans/`
- ❌ `write`/`edit` - Other locations blocked
- ❌ Destructive bash commands blocked

---

## Workflow Examples

### Simple Project (Direct Mode)

```bash
/plan Add email validation to signup form
# → Select: Direct
# → Select: Light validation
# Agent creates plan
/approve
# → Execution notes: "None"
# → Select: Direct Execution
# Agent implements directly
```

### Complex Project (Orchestrator Mode)

```bash
/plan Build habit tracker SaaS
# → Select: Orchestrator
# → Select: Complex
# → Select: Comprehensive validation
# Agent creates modular wave plan
/approve
# → Add execution notes: "Commit after each wave"
# → Select: Orchestrator + Testing
# Agent spawns parallel subagents for each wave
```

### Iterative Refinement

```bash
/plan Create documentation site
# Agent creates plan
/modify
# → Select: Major changes
# → "Add API reference section"
# Agent updates plan
/approve
# Proceed to execution
```

---

## Troubleshooting

### Plan mode not activating
```bash
pi /reload
# Check extension loaded
ls ~/.pi/agent/extensions/enhanced-plan-mode/
```

### Subagent not available
```bash
ls ~/.pi/agent/extensions/subagent/
# Should show: index.ts, agents.ts

ls ~/.pi/agent/agents/
# Should show: scout.md, planner.md, etc.
```

### Plans not saving
```bash
mkdir -p ~/.pi/plans
ls -la ~/.pi/plans/
```

### Execution mode questions not appearing
Ensure extension is reloaded after update:
```bash
cp *.ts ~/.pi/agent/extensions/enhanced-plan-mode/
pi /reload
```

---

## Testing

See [TESTING.md](TESTING.md) for detailed testing procedures.

---

## Differences from Official plan-mode

| Feature | Official | Enhanced |
|---------|----------|----------|
| Wave analysis | ❌ | ✅ Via subagent |
| Plan file schema | Simple | YAML + structured |
| Risk assessment | ❌ | ✅ 5-dimension matrix |
| Execution selection | Before execution | **Before planning** |
| Execution modes | 3 options | 3 + complexity selector |
| Validation | Software tests only | **Generic (any project)** |
| Execution notes | ❌ | ✅ |
| Guided modify | ❌ | ✅ Major/Small/Notes |
| Plan resume | ❌ | ✅ `/continue` |
| Sign off | ❌ | ✅ `/done` |
| Commands | /plan, /todos | /plan, /approve, /modify, /continue, /done, etc. |

---

## License

MIT
