# Parallel Orchestrator Extension

A Pi Coding Agent extension that brings Verdent-like parallel agent orchestration using git worktrees for isolated development.

## Overview

This extension enables running multiple subagents simultaneously in isolated git worktrees, observing their progress in separate session windows, and intelligently merging results back together.

### Key Features

- 🌳 **Git Worktree Isolation** - True filesystem isolation for parallel development
- 📋 **Plan Parsing** - Parse modular markdown plans and identify parallelizable tasks
- 🔄 **Multiple Merge Strategies** - merge, squash, or rebase
- 📊 **Worktree Status Tracking** - Track task status across worktrees
- ⌨️ **Slash Commands** - Quick commands for common operations

## Installation

```bash
# Copy to Pi extensions directory
mkdir -p ~/.pi/agent/extensions/parallel-orchestrator
cp index.ts ~/.pi/agent/extensions/parallel-orchestrator/

# Reload Pi
pi /reload
```

## Tools

### `worktree`

Manage git worktrees for isolated development.

**Actions:**
- `create` - Create a new worktree with a task-specific branch
- `list` - List all worktrees with status
- `delete` - Remove a worktree and its branch
- `status` - Get detailed status for a worktree

**Parameters:**
```typescript
{
  action: "create" | "list" | "delete" | "status",
  taskId?: string,           // For create
  taskDescription?: string,  // For create
  baseBranch?: string,      // For create (default: current branch)
  worktreeId?: string        // For delete/status
}
```

**Example:**
```typescript
// Create a worktree
worktree({
  action: "create",
  taskId: "auth-system",
  taskDescription: "Implement user authentication",
  baseBranch: "main"
})

// List all worktrees
worktree({ action: "list" })

// Delete a worktree
worktree({ action: "delete", worktreeId: "wt-abc123" })
```

### `orchestrate`

Start a parallel orchestration from a modular plan file.

**Parameters:**
```typescript
{
  planFile: string,       // Path to the plan file (markdown or JSON)
  mode: "auto" | "manual",
  maxParallel?: number,  // Maximum parallel tasks (default: 4)
  baseBranch?: string    // Base branch for worktrees
}
```

**Example:**
```typescript
orchestrate({
  planFile: "path/to/plan.md",
  mode: "auto",
  maxParallel: 4
})
```

The tool parses the plan file, extracts tasks from `## Task` headers, and prepares them for parallel execution.

### `merge_worktree`

Merge a worktree branch back into the base branch.

**Parameters:**
```typescript
{
  worktreeId: string,
  strategy: "merge" | "squash" | "rebase",
  message?: string  // Commit message for the merge
}
```

**Example:**
```typescript
merge_worktree({
  worktreeId: "wt-abc123",
  strategy: "squash",
  message: "feat: Add user authentication"
})
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/worktrees` | List all git worktrees with their status |
| `/orchestrate <plan-file>` | Start orchestration from a plan file |
| `/merge <worktree-id>` | Merge a worktree's changes |
| `/abort-worktree <id>` | Abort and cleanup a worktree |

## Usage Examples

### Creating a Worktree

```bash
# In Pi CLI
pi
> Use the worktree tool to create a worktree for task "auth-api" with description "Implement authentication API"
```

### Starting an Orchestration

```bash
# From a plan file
pi
> /orchestrate path/to/plan.md
```

### Merging Results

```bash
# After work is complete
pi
> Use merge_worktree to merge worktree "wt-abc123" with squash strategy
```

## Workflow

1. **Create Worktrees** - Each task gets its own isolated directory
2. **Spawn Subagents** - Run agents in parallel in worktrees
3. **Monitor Progress** - Check worktree status
4. **Merge Results** - Integrate changes back to main branch

## How It Works

### Git Worktree Isolation

Each worktree is a separate directory with its own branch:

```
/project/                    (main repo, main branch)
/project-wt-task1/          (worktree 1, task-1-auth branch)
/project-wt-task2/          (worktree 2, task-2-api branch)
```

This provides true filesystem isolation - agents can work in parallel without file conflicts.

### Merge Strategies

- **merge** - Standard merge commit
- **squash** - Squash all commits into one
- **rebase** - Rebase onto base branch, then fast-forward merge

## Server Components (pi-web-ui)

This extension includes server-side components in pi-web-ui:

- **Server:** `/server/src/pi/parallel/` - Worktree manager, plan parser, session orchestrator, merge coordinator
- **REST API:** `/api/worktrees` - Worktree CRUD operations
- **Client:** `/client/src/components/Orchestration/` - React UI components
- **Store:** `/client/src/store/orchestrationStore.ts` - Zustand state management

## Testing

All core tools have been tested via CLI:

```bash
# Test worktree list
pi -p "Use the worktree tool with action list"

# Test worktree create
pi -p "Create a worktree for task 'test' with description 'Test task'"

# Test merge_worktree
pi -p "Merge worktree wt-xxx with squash strategy"

# Test orchestrate
pi -p "Orchestrate plan.md"
```

## Technical Details

- **State Management**: In-memory worktree registry with unique IDs
- **Branch Naming**: `task-{taskId}-{sanitized-description}`
- **Worktree Path**: `{repo-dir}-{worktree-id}`
- **Error Handling**: Graceful handling of git errors with user-friendly messages

## License

MIT - Part of Pi Enhancement Project
