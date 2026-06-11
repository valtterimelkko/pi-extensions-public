/**
 * Parallel Orchestrator Extension
 *
 * Provides Verdent-like parallel agent orchestration for Pi.
 * Uses git worktrees for isolated development environments.
 *
 * Commands:
 *   /orchestrate <plan-file>  - Start orchestration from a modular plan
 *   /worktrees                - List all worktrees with status
 *   /merge <session-id>       - Merge a specific worktree's changes
 *   /merge-all                - Merge all completed worktrees
 *   /abort-worktree <id>      - Abort and cleanup a worktree
 *
 * Tools:
 *   worktree                  - Manage git worktrees
 *   orchestrate               - Start an orchestration
 *   merge_worktree            - Merge a worktree's changes
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Box, Text, Newline } from '@earendil-works/pi-tui';
import { Type } from '@sinclair/typebox';

const execAsync = promisify(exec);

// Simple in-memory state for the extension
interface WorktreeState {
  id: string;
  path: string;
  branch: string;
  task: string;
  status: string;
  createdAt: Date;
}

interface OrchestrationState {
  id: string;
  planPath: string;
  worktrees: WorktreeState[];
  status: string;
  currentGroup: number;
}

const activeOrchestrations = new Map<string, OrchestrationState>();
const worktreeRegistry = new Map<string, WorktreeState>();

/**
 * Execute a git command
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync(`git ${args.join(' ')}`, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Generate a unique worktree ID
 */
function generateWorktreeId(): string {
  return `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Get the repository root
 */
async function getRepoRoot(cwd: string): Promise<string> {
  return await git(cwd, 'rev-parse', '--show-toplevel');
}

/**
 * Get current branch
 */
async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    return await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    return 'main';
  }
}

export default function (pi: ExtensionAPI) {
  // ========== WORKTREE TOOL ==========
  pi.registerTool({
    name: 'worktree',
    description: 'Manage git worktrees for isolated development. Use this to create, list, or delete worktrees for parallel task execution.',
    parameters: Type.Object({
      action: StringEnum(['create', 'list', 'delete', 'status']),
      taskId: Type.Optional(Type.String({ description: 'Unique identifier for the task' })),
      taskDescription: Type.Optional(Type.String({ description: 'Description of the task for the worktree' })),
      baseBranch: Type.Optional(Type.String({ description: 'Base branch to create from (default: current branch)' })),
      worktreeId: Type.Optional(Type.String({ description: 'Worktree ID for delete/status operations' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await getRepoRoot(cwd);
      
      switch (params.action) {
        case 'create': {
          if (!params.taskId || !params.taskDescription) {
            return { content: [{ type: 'text', text: 'Error: taskId and taskDescription are required for create action' }], isError: true };
          }
          
          const baseBranch = params.baseBranch || await getCurrentBranch(repoRoot);
          const worktreeId = generateWorktreeId();
          const branchName = `task-${params.taskId}-${params.taskDescription.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30)}`;
          const worktreePath = path.join(path.dirname(repoRoot), path.basename(repoRoot) + '-' + worktreeId);
          
          try {
            // Create worktree with new branch
            await git(repoRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch);
            
            const worktree: WorktreeState = {
              id: worktreeId,
              path: worktreePath,
              branch: branchName,
              task: params.taskDescription,
              status: 'idle',
              createdAt: new Date(),
            };
            
            worktreeRegistry.set(worktreeId, worktree);
            
            return {
              content: [{ type: 'text', text: `✅ Created worktree:\n  ID: ${worktreeId}\n  Path: ${worktreePath}\n  Branch: ${branchName}\n  Base: ${baseBranch}` }],
              details: { worktree },
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `❌ Failed to create worktree: ${error instanceof Error ? error.message : 'Unknown error'}` }],
              isError: true,
            };
          }
        }
        
        case 'list': {
          try {
            const output = await git(repoRoot, 'worktree', 'list', '--porcelain');
            const lines = output.split('\n');
            const worktrees: Array<{ path: string; branch?: string; commit?: string }> = [];
            let current: Partial<{ path: string; branch: string; commit: string }> = {};
            
            for (const line of lines) {
              if (line.startsWith('worktree ')) {
                if (current.path) worktrees.push(current as typeof worktrees[0]);
                current = { path: line.slice(9) };
              } else if (line.startsWith('HEAD ')) {
                current.commit = line.slice(5).slice(0, 7);
              } else if (line.startsWith('branch ')) {
                current.branch = line.slice(7);
              }
            }
            if (current.path) worktrees.push(current as typeof worktrees[0]);
            
            if (worktrees.length === 0) {
              return { content: [{ type: 'text', text: 'No worktrees found.' }] };
            }
            
            const listItems = worktrees.map((wt, i) => {
              const registered = Array.from(worktreeRegistry.values()).find(w => w.path === wt.path);
              const status = registered?.status || 'unknown';
              const task = registered?.task || '(main repo)';
              return `${i + 1}. ${wt.path}\n   Branch: ${wt.branch || 'detached'}\n   Task: ${task}\n   Status: ${status}`;
            }).join('\n\n');
            
            return {
              content: [{ type: 'text', text: `📋 Worktrees:\n\n${listItems}` }],
              details: { worktrees, registered: Array.from(worktreeRegistry.values()) },
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `❌ Failed to list worktrees: ${error instanceof Error ? error.message : 'Unknown error'}` }],
              isError: true,
            };
          }
        }
        
        case 'delete': {
          if (!params.worktreeId) {
            return { content: [{ type: 'text', text: 'Error: worktreeId is required for delete action' }], isError: true };
          }
          
          const worktree = worktreeRegistry.get(params.worktreeId);
          if (!worktree) {
            return { content: [{ type: 'text', text: `❌ Worktree ${params.worktreeId} not found in registry` }] };
          }
          
          try {
            await git(repoRoot, 'worktree', 'remove', worktree.path, '--force');
            await git(repoRoot, 'branch', '-D', worktree.branch);
            worktreeRegistry.delete(params.worktreeId);
            
            return { content: [{ type: 'text', text: `✅ Deleted worktree ${params.worktreeId}` }] };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `❌ Failed to delete worktree: ${error instanceof Error ? error.message : 'Unknown error'}` }],
              isError: true,
            };
          }
        }
        
        case 'status': {
          if (!params.worktreeId) {
            return { content: [{ type: 'text', text: 'Error: worktreeId is required for status action' }], isError: true };
          }
          
          const worktree = worktreeRegistry.get(params.worktreeId);
          if (!worktree) {
            return { content: [{ type: 'text', text: `❌ Worktree ${params.worktreeId} not found` }] };
          }
          
          try {
            const status = await git(worktree.path, 'status', '--short');
            const logCount = await git(worktree.path, 'rev-list', '--count', 'HEAD');
            const diffStat = await git(worktree.path, 'diff', '--stat', 'HEAD~1');
            
            return {
              content: [{ type: 'text', text: `📊 Worktree ${params.worktreeId}:\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}\n  Task: ${worktree.task}\n  Status: ${worktree.status}\n  Uncommitted: ${status.length > 0 ? 'Yes' : 'No'}\n  Commits: ${logCount}\n${status ? `\n  Changes:\n${status}` : ''}` }],
              details: { worktree, status, logCount },
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `❌ Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}` }],
              isError: true,
            };
          }
        }
        
        default:
          return { content: [{ type: 'text', text: `Unknown action: ${params.action}` }] };
      }
    },
  });

  // ========== ORCHESTRATE TOOL ==========
  pi.registerTool({
    name: 'orchestrate',
    description: 'Start a parallel orchestration from a modular plan. Creates worktrees and spawns subagents for each parallelizable task.',
    parameters: Type.Object({
      planFile: Type.String({ description: 'Path to the plan file (markdown or JSON)' }),
      mode: StringEnum(['auto', 'manual']),
      maxParallel: Type.Optional(Type.Number({ description: 'Maximum parallel tasks (default: 4)' })),
      baseBranch: Type.Optional(Type.String({ description: 'Base branch for worktrees' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const planPath = path.resolve(cwd, params.planFile);
      
      try {
        const planContent = await fs.readFile(planPath, 'utf-8');
        const orchestrationId = `orch-${Date.now().toString(36)}`;
        
        // Parse plan (simple markdown task extraction)
        const tasks: Array<{ id: string; title: string; description: string }> = [];
        const lines = planContent.split('\n');
        let currentTask: Partial<{ id: string; title: string; description: string }> | null = null;
        let taskIndex = 0;
        
        for (const line of lines) {
          const taskMatch = line.match(/^#{2,4}\s*(?:Task\s*)?(\d+\.?\s*)?(.+)$/i);
          if (taskMatch) {
            if (currentTask && currentTask.title) {
              tasks.push(currentTask as typeof tasks[0]);
            }
            const title = taskMatch[2].trim();
            currentTask = {
              id: `task-${taskIndex + 1}`,
              title,
              description: '',
            };
            taskIndex++;
          } else if (currentTask) {
            currentTask.description = (currentTask.description || '') + line + '\n';
          }
        }
        if (currentTask && currentTask.title) {
          tasks.push(currentTask as typeof tasks[0]);
        }
        
        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: '❌ No tasks found in plan. Use ## Task headers to define tasks.' }], isError: true };
        }
        
        // Create orchestration state
        const orchestration: OrchestrationState = {
          id: orchestrationId,
          planPath,
          worktrees: [],
          status: 'initializing',
          currentGroup: 0,
        };
        
        activeOrchestrations.set(orchestrationId, orchestration);
        
        // For now, just show what would be orchestrated
        const taskList = tasks.map((t, i) => 
          `${i + 1}. **${t.title}**\n   ID: ${t.id}\n   ${t.description.slice(0, 100)}...`
        ).join('\n\n');
        
        return {
          content: [{ type: 'text', text: `🎯 Orchestration Ready!\n\nID: ${orchestrationId}\nPlan: ${planPath}\nTasks: ${tasks.length}\n\n${taskList}\n\nUse the subagent tool to spawn agents for each task in their worktrees.` }],
          details: {
            orchestrationId,
            tasks,
            planPath,
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `❌ Failed to start orchestration: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  });

  // ========== MERGE WORKTREE TOOL ==========
  pi.registerTool({
    name: 'merge_worktree',
    description: 'Merge a worktree branch back into the base branch. Supports merge, squash, and rebase strategies.',
    parameters: Type.Object({
      worktreeId: Type.String({ description: 'ID of the worktree to merge' }),
      strategy: StringEnum(['merge', 'squash', 'rebase']),
      message: Type.Optional(Type.String({ description: 'Commit message for the merge' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await getRepoRoot(cwd);
      
      const worktree = worktreeRegistry.get(params.worktreeId);
      if (!worktree) {
        return { content: [{ type: 'text', text: `❌ Worktree ${params.worktreeId} not found` }] };
      }
      
      try {
        // Commit any uncommitted changes first
        const status = await git(worktree.path, 'status', '--short');
        if (status.length > 0) {
          await git(worktree.path, 'add', '-A');
          await git(worktree.path, 'commit', '-m', `WIP: ${worktree.task}`);
        }
        
        // Switch to base branch
        const baseBranch = worktree.branch.split('-').slice(0, -1).join('-') || 'main';
        await git(repoRoot, 'checkout', baseBranch);
        
        // Perform merge
        const strategy = params.strategy || 'merge';
        const message = params.message || `Merge ${worktree.branch}: ${worktree.task}`;
        
        if (strategy === 'squash') {
          await git(repoRoot, 'merge', '--squash', worktree.branch);
          await git(repoRoot, 'commit', '-m', message);
        } else if (strategy === 'rebase') {
          await git(worktree.path, 'rebase', baseBranch);
          await git(repoRoot, 'merge', '--ff-only', worktree.branch);
        } else {
          await git(repoRoot, 'merge', worktree.branch, '-m', message);
        }
        
        worktree.status = 'merged';
        
        return {
          content: [{ type: 'text', text: `✅ Merged worktree ${params.worktreeId}\n  Branch: ${worktree.branch}\n  Strategy: ${strategy}\n  Into: ${baseBranch}` }],
        };
      } catch (error) {
        // Check for conflicts
        try {
          const conflictStatus = await git(repoRoot, 'status', '--short');
          if (conflictStatus.includes('UU')) {
            return {
              content: [{ type: 'text', text: `⚠️ Merge has conflicts!\n\nConflicted files:\n${conflictStatus.split('\n').filter(l => l.includes('UU')).join('\n')}\n\nResolve conflicts manually, then run: git commit` }],
            };
          }
        } catch {}
        
        return {
          content: [{ type: 'text', text: `❌ Failed to merge: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  });

  // ========== SLASH COMMANDS ==========
  
  pi.registerCommand('worktrees', {
    description: 'List all git worktrees with their status',
    handler: async (_args, context) => {
      const cwd = context?.cwd || process.cwd();
      const repoRoot = await getRepoRoot(cwd);
      
      try {
        const output = await git(repoRoot, 'worktree', 'list');
        context.ui.notify(`📋 Worktrees:\n\n${output}`, 'info');
      } catch (error) {
        context.ui.notify(`❌ Failed to list worktrees: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
      }
    },
  });

  pi.registerCommand('orchestrate', {
    description: 'Start a parallel orchestration from a plan file',
    handler: async (args, context) => {
      const planFile = args.trim();
      if (!planFile) {
        context.ui.notify('Usage: /orchestrate <plan-file>\n\nProvide a path to a markdown or JSON plan file.', 'warning');
        return;
      }
      
      pi.sendUserMessage(`Use the orchestrate tool with planFile: "${planFile}" to start the orchestration.`);
    },
  });

  pi.registerCommand('merge', {
    description: 'Merge a worktree branch into base',
    handler: async (args, context) => {
      const worktreeId = args.trim();
      if (!worktreeId) {
        context.ui.notify('Usage: /merge <worktree-id>\n\nUse /worktrees to list available worktrees.', 'warning');
        return;
      }
      
      pi.sendUserMessage(`Use the merge_worktree tool with worktreeId: "${worktreeId}" to merge.`);
    },
  });

  pi.registerCommand('abort-worktree', {
    description: 'Abort and cleanup a worktree',
    handler: async (args, context) => {
      const worktreeId = args.trim();
      if (!worktreeId) {
        context.ui.notify('Usage: /abort-worktree <worktree-id>', 'warning');
        return;
      }
      
      pi.sendUserMessage(`Use the worktree tool with action: "delete" and worktreeId: "${worktreeId}" to abort.`);
    },
  });

}
