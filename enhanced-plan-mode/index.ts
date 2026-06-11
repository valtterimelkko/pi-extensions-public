/**
 * Enhanced Plan Mode Extension for Pi
 * 
 * A comprehensive planning mode combining Pi's official subagent extension
 * with kimi-planning's workflow patterns.
 * 
 * Features:
 * - Wave-based analysis using subagent tool
 * - YAML frontmatter plan schema
 * - Risk assessment matrix
 * - 4-option execution selection
 * - Plan lifecycle management
 * 
 * Commands:
 * - /plan [description] - Enter planning mode
 * - /approve or a - Approve current plan
 * - /modify or m - Request plan modifications
 * - /reject or r - Cancel planning mode
 * - /status - Show current plan status
 * - /execute - Start execution (after approval)
 * - /cancel - Abort planning
 * 
 * Keyboard shortcuts:
 * - Ctrl+Shift+P - Toggle plan mode
 * - Ctrl+Shift+A - Approve plan
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

import type { PlanModeState, PlanSchema, ExecutionMode, PlanStatus, TestPlanSection, TestStep } from "./types.js";
import { isAssistantMessage, getTextContent } from "./types.js";
import {
  savePlan,
  loadPlan,
  listPlans,
  updatePlanStatus,
  updatePlanExecutionNotes,
  parsePlan,
  serializePlan,
  generatePlanFilename,
  ensurePlansDirectory
} from "./plan-schema.js";
import {
  generateAnalysisWaves,
  synthesizeWaveResults,
  createSubagentCall,
  parseSubagentResults,
  generateSubagentInstructions
} from "./analysis-orchestrator.js";
import {
  calculateRiskLevel,
  calculateEffortLevel,
  autoAssessRisk,
  formatRiskLevel,
  formatEffortLevel,
  generateMitigationRecommendations,
  generateRiskMatrix
} from "./risk-assessment.js";

// Tools available in plan mode
// Note: write/edit are allowed ONLY for ~/.pi/plans/ directory (enforced by tool_call handler)
const PLAN_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", "subagent"];

// Extension state
interface State extends PlanModeState {
  planFileName?: string;
  execution_mode_selection?: ExecutionMode;
  preferred_execution_mode?: string; // Set during planning setup
  validation_strategy?: string; // Set during planning setup
  project_complexity?: string; // simple/moderate/complex
}

const state: State = {
  enabled: false,
  execution_mode: false,
  current_plan: undefined,
  plan_file_path: undefined,
  analysis_results: undefined,
  current_wave: undefined,
  execution_mode_selection: undefined,
  preferred_execution_mode: undefined,
  validation_strategy: undefined,
  project_complexity: undefined
};

export default function enhancedPlanModeExtension(pi: ExtensionAPI): void {
  // Store reference for helper functions
  piRef = pi;

  // Register CLI flag
  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration with wave-based analysis)",
    type: "boolean",
    default: false
  });

  // Register commands
  registerCommands(pi);

  // Register keyboard shortcuts
  registerShortcuts(pi);

  // Register event handlers
  registerEventHandlers(pi);
}

function registerCommands(pi: ExtensionAPI): void {
  // /plan - Toggle or enter plan mode
  pi.registerCommand("plan", {
    description: "Toggle plan mode or start planning for a task",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (task) {
        // Start new plan with task description
        await enterPlanMode(ctx, task);
      } else {
        // Toggle plan mode
        togglePlanMode(ctx);
      }
    }
  });

  // /approve or a - Approve current plan
  pi.registerCommand("approve", {
    description: "Approve the current plan and proceed to execution selection",
    handler: async (_args, ctx) => {
      // Try to restore plan from file if not in memory
      if (!await ensurePlanLoaded(ctx)) {
        return;
      }
      await approvePlan(ctx);
    }
  });

  // Short alias
  pi.registerCommand("a", {
    description: "Alias for /approve",
    handler: async (_args, ctx) => {
      // Try to restore plan from file if not in memory
      if (!await ensurePlanLoaded(ctx)) {
        return;
      }
      await approvePlan(ctx);
    }
  });

  // /modify or m - Request plan modifications
  pi.registerCommand("modify", {
    description: "Request modifications to the current plan",
    handler: async (_args, ctx) => {
      // Try to restore plan from file if not in memory
      if (!await ensurePlanLoaded(ctx)) {
        return;
      }
      await modifyPlan(ctx);
    }
  });

  pi.registerCommand("m", {
    description: "Alias for /modify",
    handler: async (_args, ctx) => {
      // Try to restore plan from file if not in memory
      if (!await ensurePlanLoaded(ctx)) {
        return;
      }
      await modifyPlan(ctx);
    }
  });

  // /reject or r - Cancel planning mode
  pi.registerCommand("reject", {
    description: "Cancel planning mode and discard the current plan",
    handler: async (_args, ctx) => {
      await rejectPlan(ctx);
    }
  });

  pi.registerCommand("r", {
    description: "Alias for /reject",
    handler: async (_args, ctx) => {
      await rejectPlan(ctx);
    }
  });

  // /execute - Start execution (after approval)
  pi.registerCommand("execute", {
    description: "Start executing the approved plan",
    handler: async (_args, ctx) => {
      // Try to restore plan from file if not in memory
      if (!await ensurePlanLoaded(ctx)) {
        return;
      }
      if (state.current_plan?.status !== "approved") {
        ctx.ui.notify("Plan must be approved before execution. Use /approve first.", "warning");
        return;
      }
      await startExecution(ctx);
    }
  });

  // /cancel - Abort planning
  pi.registerCommand("cancel", {
    description: "Cancel planning mode (alias for /reject)",
    handler: async (_args, ctx) => {
      await rejectPlan(ctx);
    }
  });

  // /done - Mark plan as complete and delete the plan file
  pi.registerCommand("done", {
    description: "Mark plan as complete and delete the plan file (sign-off)",
    handler: async (_args, ctx) => {
      if (!state.current_plan) {
        ctx.ui.notify("No active plan to complete. Use /plan first.", "warning");
        return;
      }

      // Ask for confirmation
      const confirmed = await ctx.ui.confirm(
        "✓ Sign Off & Complete Plan",
        `Are you sure you want to mark "${state.current_plan.task}" as complete?\n\nThis will:\n1. Mark the plan as completed\n2. Delete the plan file: ${state.planFileName}\n\nOnly confirm when you have verified the implementation is fully working.`
      );

      if (!confirmed) {
        ctx.ui.notify("Sign-off cancelled. Plan remains active.", "info");
        return;
      }

      // Delete the plan file
      if (state.plan_file_path && fs.existsSync(state.plan_file_path)) {
        try {
          fs.unlinkSync(state.plan_file_path);
          ctx.ui.notify(`✓ Plan completed and file deleted: ${state.planFileName}`, "info");
        } catch (err) {
          ctx.ui.notify(`Failed to delete plan file: ${err}`, "error");
          return;
        }
      }

      // Clear state
      state.enabled = false;
      state.execution_mode = false;
      state.current_plan = undefined;
      state.plan_file_path = undefined;
      state.planFileName = undefined;
      state.execution_mode_selection = undefined;
      state.preferred_execution_mode = undefined;
      state.validation_strategy = undefined;
      state.project_complexity = undefined;

      piRef.setActiveTools(NORMAL_MODE_TOOLS);
      updateStatus(ctx);
      persistState();

      ctx.ui.notify("🎉 Plan signed off and completed! The plan file has been cleaned up.", "info");
    }
  });

  // /status - Show current plan status
  pi.registerCommand("status", {
    description: "Show current plan mode status",
    handler: async (_args, ctx) => {
      await showStatus(ctx);
    }
  });

  // /plans - List all saved plans
  pi.registerCommand("plans", {
    description: "List all saved plans",
    handler: async (_args, ctx) => {
      const plans = listPlans();
      if (plans.length === 0) {
        ctx.ui.notify("No saved plans found.", "info");
        return;
      }

      const planList = plans.slice(0, 10).map(p => 
        `${p.filename}\n  Task: ${p.task}\n  Status: ${p.status}\n  Created: ${new Date(p.created).toLocaleString()}`
      ).join("\n\n");

      ctx.ui.notify(`Saved Plans:\n\n${planList}`, "info");
    }
  });

  // /continue - Resume a saved plan (named 'continue' to avoid conflict with built-in /resume)
  pi.registerCommand("continue", {
    description: "Continue a saved plan from ~/.pi/plans/",
    handler: async (args, ctx) => {
      const filenameFilter = args.trim();
      const plans = listPlans();
      if (plans.length === 0) {
        ctx.ui.notify("No saved plans found. Use /plan to create a new plan.", "warning");
        return;
      }

      let selectedPlan: typeof plans[0] | undefined;

      if (filenameFilter) {
        // Find plan by filename (partial match supported)
        selectedPlan = plans.find(p => 
          p.filename.toLowerCase().includes(filenameFilter.toLowerCase())
        );
        if (!selectedPlan) {
          ctx.ui.notify(`No plan found matching "${filenameFilter}"`, "warning");
          return;
        }
      } else {
        // Show picker with all plans (completed/cancelled shown but marked)
        const choices = plans.map(p => {
          const dateStr = p.created ? new Date(p.created).toLocaleDateString() : "unknown date";
          const statusMarker = p.status === "completed" ? "✓" : 
                               p.status === "cancelled" ? "✗" : 
                               p.status === "in_progress" ? "▶" : "○";
          // Use task name or fall back to filename if task is empty
          const taskName = p.task?.trim() || p.filename.replace(/\.md$/, "");
          return `${statusMarker} ${taskName} (${p.status}) - ${dateStr}`;
        });

        const choice = await ctx.ui.select("Select a plan to continue:", choices);
        if (!choice) return;

        selectedPlan = plans[choices.indexOf(choice)];
      }

      if (!selectedPlan) return;

      // Load the plan
      const loadedPlan = loadPlan(selectedPlan.filename);
      if (!loadedPlan) {
        ctx.ui.notify("Failed to load plan file.", "error");
        return;
      }

      // Read raw content to check for implementation plan section (parser may not extract all formats)
      const rawContent = fs.readFileSync(
        path.join(os.homedir(), ".pi", "plans", selectedPlan.filename), 
        "utf-8"
      );
      const hasImplementationSection = rawContent.includes("## Implementation Plan") || 
                                       rawContent.includes("## Implementation");
      const hasContent = rawContent.length > 1000; // Rough heuristic for substantial content

      // Check if plan is essentially empty (no implementation steps in parsed data AND no section in raw)
      const hasNoParsedSteps = !loadedPlan.implementation_plan || loadedPlan.implementation_plan.length === 0;
      const hasNoFiles = !loadedPlan.analysis?.files_to_modify || loadedPlan.analysis.files_to_modify.length === 0;
      
      if (hasNoParsedSteps && hasNoFiles && !hasImplementationSection && !hasContent) {
        const proceed = await ctx.ui.confirm(
          "⚠️ Empty Plan Warning",
          `The plan "${loadedPlan.task}" appears to be empty (no implementation steps defined).\n\nThis plan may have been created accidentally or the planning was not completed.\n\nWould you like to:\n- YES: Continue with this empty plan and define steps now\n- NO: Cancel and use /plans to see other available plans`
        );
        
        if (!proceed) {
          ctx.ui.notify("Cancelled. Use /plans to see all saved plans.", "info");
          return;
        }
      }

      // Update state
      state.enabled = true;
      state.execution_mode = false;
      state.current_plan = loadedPlan;
      state.planFileName = selectedPlan.filename;
      state.plan_file_path = path.join(os.homedir(), ".pi", "plans", selectedPlan.filename);

      // Set tools
      piRef.setActiveTools(PLAN_MODE_TOOLS);

      // Update UI
      updateStatus(ctx);
      persistState();

      // Show plan summary
      const summaryLines: string[] = [];
      summaryLines.push(`📋 Continued Plan: ${loadedPlan.task}`);
      summaryLines.push("");
      summaryLines.push(`Status: ${loadedPlan.status}`);
      summaryLines.push(`Risk: ${formatRiskLevel(loadedPlan.risk_level || "low")}`);
      summaryLines.push(`Effort: ${formatEffortLevel(loadedPlan.estimated_effort || "small")}`);
      
      if (loadedPlan.summary) {
        summaryLines.push("");
        summaryLines.push("Summary:");
        summaryLines.push(loadedPlan.summary.slice(0, 300) + (loadedPlan.summary.length > 300 ? "..." : ""));
      }
      
      const steps = loadedPlan.implementation_plan || [];
      if (steps.length > 0) {
        summaryLines.push("");
        summaryLines.push(`Implementation Steps (${steps.length} total):`);
        steps.slice(0, 5).forEach(s => {
          summaryLines.push(`  ${s.step_number}. ${s.title}`);
        });
        if (steps.length > 5) {
          summaryLines.push(`  ... and ${steps.length - 5} more`);
        }
      } else {
        summaryLines.push("");
        summaryLines.push("⚠️ No implementation steps defined yet.");
      }
      
      summaryLines.push("");
      summaryLines.push("Use /approve to approve, /modify to edit, or /status for full details.");

      ctx.ui.notify(summaryLines.join("\n"), hasNoParsedSteps ? "warning" : "info");
    }
  });
}

function registerShortcuts(pi: ExtensionAPI): void {
  // Ctrl+Shift+P - Toggle plan mode
  pi.registerShortcut(Key.ctrlShift("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx)
  });

  // Ctrl+Shift+A - Approve plan
  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Approve current plan",
    handler: async (ctx) => {
      if (state.enabled && state.current_plan) {
        await approvePlan(ctx);
      } else {
        ctx.ui.notify("No active plan to approve", "warning");
      }
    }
  });

  // Ctrl+Shift+M - Modify plan
  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Modify current plan",
    handler: async (ctx) => {
      if (state.enabled && state.current_plan) {
        await modifyPlan(ctx);
      } else {
        ctx.ui.notify("No active plan to modify", "warning");
      }
    }
  });
}

function registerEventHandlers(pi: ExtensionAPI): void {
  // Block destructive commands in plan mode
  pi.on("tool_call", async (event) => {
    if (!state.enabled || state.execution_mode) return;

    // Allow writes to plans directory, block other writes
    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      
      // Allow writes to the plans directory
      if (filePath.includes(".pi/plans/") || filePath.includes("/.pi/plans/")) {
        return; // Don't block - allow plan file creation
      }
      
      // Block all other writes
      return {
        block: true,
        reason: `Plan mode: ${event.toolName} is blocked for this location.\nPath: ${filePath}\nOnly writes to ~/.pi/plans/ are allowed for saving plan files.\nUse /approve to start execution for codebase changes, or /cancel to exit plan mode.`
      };
    }

    // Block destructive bash commands
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (isDestructiveCommand(command)) {
        return {
          block: true,
          reason: `Plan mode: Command blocked for safety.\nCommand: ${command}\nUse /approve to start execution, or /cancel to exit plan mode.`
        };
      }
    }
  });

  // Inject planning context before agent starts
  pi.on("before_agent_start", async () => {
    // Signal that extension is managing plan mode (prevents skill activation)
    const extensionSignal = `[ENHANCED-PLAN-MODE-EXTENSION-ACTIVE]

The enhanced-plan-mode extension is currently managing this session.
This extension provides:
- Hard tool blocking (write/edit/bash restrictions)
- Custom commands (/plan, /approve, /modify, etc.)
- Plan file persistence to ~/.pi/plans/
- Risk assessment and execution selection UI

DO NOT activate the kimi-planning skill - this extension provides
superior hard-enforcement of plan mode. Use the extension's features.
`;

    if (state.enabled && state.current_plan) {
      // Plan mode with active plan
      return {
        message: {
          customType: "enhanced-plan-mode-context",
          content: extensionSignal + "\n\n" + generatePlanModePrompt(state.current_plan),
          display: false
        }
      };
    } else if (state.enabled) {
      // Plan mode without plan yet
      return {
        message: {
          customType: "enhanced-plan-mode-init",
          content: extensionSignal + "\n\n" + generateInitialPlanModePrompt(),
          display: false
        }
      };
    } else if (state.execution_mode && state.current_plan) {
      // Execution mode - use stored execution mode selection
      // Read full plan content if available
      let fullPlanContent = "";
      if (state.plan_file_path && fs.existsSync(state.plan_file_path)) {
        try {
          fullPlanContent = fs.readFileSync(state.plan_file_path, "utf-8");
        } catch {
          // Ignore read errors
        }
      }
      
      return {
        message: {
          customType: "enhanced-plan-execution-context",
          content: extensionSignal + "\n\n" + generateExecutionPrompt(state.current_plan, state.execution_mode_selection, state.plan_file_path, fullPlanContent),
          display: false
        }
      };
    }
  });

  // Update status on session start
  pi.on("session_start", async (_event, ctx) => {
    // Check for --plan flag
    if (pi.getFlag("plan") === true) {
      state.enabled = true;
    }

    // Restore state from session entries
    restoreState(ctx);

    // Update UI
    updateStatus(ctx);

    // Set active tools based on mode
    if (state.enabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }
  });
}

// State management
function restoreState(ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();
  
  // Find latest plan mode state entry
  const stateEntry = entries
    .filter((e: { type: string; customType?: string }) => 
      e.type === "custom" && e.customType === "enhanced-plan-mode-state"
    )
    .pop() as { data?: State } | undefined;

  if (stateEntry?.data) {
    Object.assign(state, stateEntry.data);
  }
}

// Store pi reference for use in helper functions
let piRef: ExtensionAPI;

function persistState(): void {
  piRef.appendEntry("enhanced-plan-mode-state", { ...state });
}

// Mode management
async function enterPlanMode(ctx: ExtensionContext, task: string): Promise<void> {
  state.enabled = true;
  state.execution_mode = false;
  state.current_wave = 0;
  
  // If preferences not set yet (user used /plan [task] directly), ask now
  if (!state.preferred_execution_mode || !state.validation_strategy) {
    const preferencesSet = await askPlanningPreferences(ctx);
    if (!preferencesSet) return;
    // askPlanningPreferences already sets state.enabled, etc.
  }
  
  const selectedMode = state.preferred_execution_mode || "direct";
  const validationStrategy = state.validation_strategy || "Moderate - Validation of key components + spot-checks";
  const validationContext = validationStrategy.split(" - ")[0];
  
  // Create initial plan structure with user preferences
  state.current_plan = {
    task,
    created: new Date().toISOString(),
    status: "pending",
    risk_level: "low",
    estimated_effort: "small",
    summary: "",
    preferred_execution_mode: selectedMode as ExecutionMode,
    validation_strategy: validationStrategy,
    analysis: {
      files_to_read: [],
      files_to_modify: [],
      dependencies: [],
      risks: []
    },
    implementation_plan: [],
    alternative_approaches: [],
    verification_plan: []
  };

  // Save plan to file
  ensurePlansDirectory();
  state.planFileName = generatePlanFilename(task);
  state.plan_file_path = savePlan(state.current_plan, state.planFileName);

  // Set tools
  piRef.setActiveTools(PLAN_MODE_TOOLS);

  // Update UI
  updateStatus(ctx);
  persistState();

  // Notify user
  const complexityMsg = state.project_complexity ? ` | Complexity: ${state.project_complexity}` : "";
  ctx.ui.notify(`📝 Planning mode activated for: ${task}\nExecution: ${selectedMode}${complexityMsg} | Validation: ${validationContext}`, "info");

  // Send initial message to agent with preferences
  piRef.sendMessage({
    customType: "plan-init",
    content: generatePlanningPrompt(task, selectedMode, validationStrategy, state.project_complexity),
    display: true
  }, { triggerTurn: true });
}

async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
  if (state.enabled) {
    // Exit plan mode
    state.enabled = false;
    state.execution_mode = false;
    piRef.setActiveTools(NORMAL_MODE_TOOLS);
    ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
    updateStatus(ctx);
    persistState();
  } else {
    // Enter plan mode - ask for preferences first
    await askPlanningPreferences(ctx);
  }
}

// Ask for execution mode and validation strategy
async function askPlanningPreferences(ctx: ExtensionContext): Promise<boolean> {
  // Ask for execution mode preference
  const executionMode = await ctx.ui.select(
    "🚀 Select Execution Strategy",
    [
      "1️⃣ Direct - Main session executes all steps (simple projects, learning mode)",
      "2️⃣ Orchestrator - Use subagents for parallel work (complex projects, combat context rot)",
      "3️⃣ Mixed - Decide per module during execution"
    ]
  );
  
  if (!executionMode) {
    ctx.ui.notify("Planning cancelled.", "info");
    return false;
  }
  
  // Parse execution mode choice
  const modeMap: Record<string, string> = {
    "1️⃣ Direct - Main session executes all steps (simple projects, learning mode)": "direct",
    "2️⃣ Orchestrator - Use subagents for parallel work (complex projects, combat context rot)": "orchestrator",
    "3️⃣ Mixed - Decide per module during execution": "mixed"
  };
  state.preferred_execution_mode = modeMap[executionMode] || "direct";
  
  // If orchestrator selected, ask for complexity level to guide planning structure
  if (state.preferred_execution_mode === "orchestrator") {
    const complexity = await ctx.ui.select(
      "📊 Project Complexity",
      [
        "Simple - Few sequential phases, minimal dependencies",
        "Moderate - Some parallelizable modules, clear dependency chains", 
        "Complex - Many interdependent modules, requires careful wave planning"
      ]
    );
    
    if (!complexity) {
      ctx.ui.notify("Planning cancelled.", "info");
      return false;
    }
    
    state.project_complexity = complexity.split(" - ")[0].toLowerCase();
  }
  
  // Ask for validation strategy
  const validationStrategy = await ctx.ui.select(
    "✓ Select Validation Strategy",
    [
      "Light - Basic validation of critical outputs only",
      "Moderate - Validation of key components + spot-checks",
      "Comprehensive - Thorough validation of all outputs with detailed verification",
      "None - Skip validation (not recommended)"
    ]
  );
  
  if (!validationStrategy) {
    ctx.ui.notify("Planning cancelled.", "info");
    return false;
  }
  
  state.validation_strategy = validationStrategy;
  
  // Enable plan mode
  state.enabled = true;
  state.execution_mode = false;
  ensurePlansDirectory();
  piRef.setActiveTools(PLAN_MODE_TOOLS);
  const complexityMsg = state.project_complexity ? ` | Complexity: ${state.project_complexity}` : "";
  ctx.ui.notify(`📝 Plan mode enabled.\nExecution: ${state.preferred_execution_mode}${complexityMsg} | Validation: ${validationStrategy.split(" - ")[0]}\n\nDescribe what you want to plan.`, "info");
  updateStatus(ctx);
  persistState();
  return true;
}

async function approvePlan(ctx: ExtensionContext): Promise<void> {
  if (!state.current_plan) {
    ctx.ui.notify("No active plan to approve. Use /plan first.", "warning");
    return;
  }
  
  // Ensure plan has required structure with defaults
  if (!state.current_plan.analysis) {
    state.current_plan.analysis = {
      files_to_read: [],
      files_to_modify: [],
      dependencies: [],
      risks: []
    };
  }

  // Update status
  state.current_plan.status = "under_review";
  
  // Perform risk assessment
  const assessment = autoAssessRisk(state.current_plan);
  state.current_plan.risk_level = calculateRiskLevel(assessment);
  state.current_plan.estimated_effort = calculateEffortLevel(assessment);

  // Check validation plan coverage (skip warning if user explicitly chose "None" for validation)
  const testCoverage = validateTestPlan(state.current_plan);
  const validationStrategy = state.current_plan.validation_strategy || "";
  const explicitlySkippedValidation = validationStrategy.includes("None") || validationStrategy.includes("Skip");
  
  // Note: We intentionally do NOT call savePlan here to avoid overwriting
  // the original plan file content. The status is updated via updatePlanStatus.

  // Warn if validation plan is insufficient (but not if user explicitly chose "None")
  if (!testCoverage.hasAdequateTests && !explicitlySkippedValidation) {
    const validationWarning = await ctx.ui.confirm(
      "⚠️ Validation Plan Warning",
      `This plan appears to lack validation/verification steps matching your selected strategy (${validationStrategy}):\n${testCoverage.issues.join("\n")}\n\nYou selected "${validationStrategy}" during planning. Would you like to modify the plan to add appropriate validation steps before approving?`
    );
    
    if (validationWarning) {
      await modifyPlan(ctx);
      return;
    }
    // User chose to proceed anyway
  }

  // Show plan review UI
  const choice = await ctx.ui.select("📋 Plan Review - What would you like to do?", [
    "✓ Approve and proceed to execution",
    "✏️ Modify the plan",
    "❌ Reject and exit plan mode",
    "⏸️ Pause for further review"
  ]);

  switch (choice) {
    case "✓ Approve and proceed to execution":
      await showExecutionSelection(ctx);
      break;
    case "✏️ Modify the plan":
      await modifyPlan(ctx);
      break;
    case "❌ Reject and exit plan mode":
      await rejectPlan(ctx);
      break;
    case "⏸️ Pause for further review":
      state.current_plan.status = "paused_for_verification";
      if (state.planFileName) {
        updatePlanStatus(state.planFileName, "paused_for_verification");
      }
      ctx.ui.notify("⏸️ Plan paused for verification. Use /execute to resume when ready.", "info");
      persistState();
      break;
  }
}

async function showExecutionSelection(ctx: ExtensionContext): Promise<void> {
  if (!state.current_plan) return;

  const riskDisplay = formatRiskLevel(state.current_plan.risk_level || "low");
  const effortDisplay = formatEffortLevel(state.current_plan.estimated_effort || "small");
  const filesCount = state.current_plan.analysis?.files_to_modify?.length || 0;

  const choice = await ctx.ui.select(
    `🚀 Select Execution Approach\n\nTask: ${state.current_plan.task}\nRisk: ${riskDisplay}\nEffort: ${effortDisplay}\nFiles: ${filesCount}`,
    [
      "1️⃣ Direct Execution - Main session executes the plan directly",
      "2️⃣ Orchestrator + Testing (Recommended) - Coordinate with verification",
      "3️⃣ Pure Orchestrator - Maximum parallelization with subagents",
      "4️⃣ Pause for Verification - Take time to review before executing"
    ]
  );

  if (!choice) return;

  const modeMap: Record<string, ExecutionMode> = {
    "1️⃣ Direct Execution - Main session executes the plan directly": "direct",
    "2️⃣ Orchestrator + Testing (Recommended) - Coordinate with verification": "orchestrator_testing",
    "3️⃣ Pure Orchestrator - Maximum parallelization with subagents": "pure_orchestrator",
    "4️⃣ Pause for Verification - Take time to review before executing": "pause"
  };

  const executionMode = modeMap[choice];

  if (executionMode === "pause") {
    state.current_plan.status = "paused_for_verification";
    if (state.planFileName) {
      updatePlanStatus(state.planFileName, "paused_for_verification");
    }
    ctx.ui.notify("⏸️ Execution paused. Review the plan and use /execute when ready.", "info");
    persistState();
    return;
  }

  // Ask for any last-minute execution notes/preferences
  const hasExistingNotes = state.current_plan.execution_notes && state.current_plan.execution_notes.trim().length > 0;
  const notesChoice = await ctx.ui.select(
    "📝 Execution Notes (Optional)",
    hasExistingNotes ? [
      "✓ Use existing execution notes",
      "✏️ Edit execution notes",
      "➕ Add new execution notes",
      "⏭️ Skip - No additional notes"
    ] : [
      "➕ Add execution notes (git workflow, agent assignments, etc.)",
      "⏭️ Skip - No additional notes"
    ]
  );
  
  if (notesChoice?.includes("Edit") || notesChoice?.includes("Add")) {
    const notes = await ctx.ui.editor(
      "Add execution notes/preferences:\n\nExamples:\n- Use git: commit after each module, push to origin/main\n- GLM agent skips frontend work (will use kimi separately)\n- Always add JSDoc comments\n- Run tests after each wave",
      state.current_plan.execution_notes || ""
    );
    if (notes !== undefined && notes.trim()) {
      state.current_plan.execution_notes = notes.trim();
      if (state.planFileName) {
        updatePlanExecutionNotes(state.planFileName, notes.trim());
      }
      ctx.ui.notify("✓ Execution notes saved.", "info");
    }
  }

  // Mark as approved
  state.current_plan.status = "approved";
  if (state.planFileName) {
    updatePlanStatus(state.planFileName, "approved");
  }

  // Show execution confirmation with plan name
  const planName = state.current_plan.task || "Untitled Plan";
  ctx.ui.notify(`✓ Plan Approved: ${planName}\nExecution mode: ${choice.split("-")[0].trim()}\nStarting execution...`, "info");

  await startExecution(ctx, executionMode);
}

async function startExecution(ctx: ExtensionContext, mode?: ExecutionMode): Promise<void> {
  if (!state.current_plan) return;

  state.enabled = false;
  state.execution_mode = true;
  state.execution_mode_selection = mode || "direct";
  state.current_plan.status = "in_progress";

  // Restore full tools
  piRef.setActiveTools(NORMAL_MODE_TOOLS);

  // Save state
  if (state.planFileName) {
    updatePlanStatus(state.planFileName, "in_progress");
  }
  persistState();
  updateStatus(ctx);

  // Read full plan content for the prompt
  let fullPlanContent = "";
  const planPath = state.plan_file_path;
  
  if (planPath) {
    if (fs.existsSync(planPath)) {
      try {
        fullPlanContent = fs.readFileSync(planPath, "utf-8");
        // Debug: show first 200 chars
        ctx.ui.notify(`Debug: Read ${fullPlanContent.length} chars from plan file`, "info");
      } catch (err) {
        ctx.ui.notify(`Debug: Failed to read plan file: ${err}`, "warning");
      }
    } else {
      ctx.ui.notify(`Debug: Plan file not found at ${planPath}`, "warning");
    }
  } else {
    ctx.ui.notify(`Debug: No plan_file_path in state`, "warning");
  }

  // Generate execution prompt based on mode
  const executionPrompt = generateExecutionPrompt(state.current_plan, mode, planPath, fullPlanContent);

  // Send execution message
  piRef.sendMessage({
    customType: "plan-execution-start",
    content: executionPrompt,
    display: true
  }, { triggerTurn: true });
}

async function modifyPlan(ctx: ExtensionContext): Promise<void> {
  const choice = await ctx.ui.select(
    "✏️ Modify Plan - What would you like to change?",
    [
      "📝 Major changes - Content, scope, architecture, or timeline",
      "🔧 Small tweaks - Wording, order, or minor details", 
      "⚙️ Execution notes - Preferences for how to execute (git workflow, agent assignments, etc.)",
      "❌ Cancel - Go back to plan review"
    ]
  );
  
  if (!choice || choice.includes("Cancel")) {
    return;
  }
  
  if (choice.includes("Major changes")) {
    const refinement = await ctx.ui.editor("Describe the major changes you want to make:", "");
    if (refinement?.trim()) {
      piRef.sendUserMessage(`Major plan modification requested:\n${refinement.trim()}\n\nPlease update the plan accordingly.`);
      
      // Ask if user wants to return to approval flow
      const returnToReview = await ctx.ui.confirm(
        "Return to Plan Review?",
        "Your modification request has been sent. After the LLM updates the plan, would you like to return to the plan review to approve it?"
      );
      
      if (returnToReview) {
        // Wait a moment for the LLM to process, then trigger approval flow
        setTimeout(() => approvePlan(ctx), 100);
      }
    }
  } else if (choice.includes("Small tweaks")) {
    const refinement = await ctx.ui.editor("Describe the small tweaks needed:", "");
    if (refinement?.trim()) {
      piRef.sendUserMessage(`Small plan tweaks:\n${refinement.trim()}\n\nPlease update the plan with these adjustments.`);
      
      // Ask if user wants to return to approval flow
      const returnToReview = await ctx.ui.confirm(
        "Return to Plan Review?",
        "Your tweak request has been sent. After the LLM updates the plan, would you like to return to the plan review to approve it?"
      );
      
      if (returnToReview) {
        setTimeout(() => approvePlan(ctx), 100);
      }
    }
  } else if (choice.includes("Execution notes")) {
    const notes = await ctx.ui.editor(
      "Add execution notes/preferences (these will be included in execution but won't modify the plan itself):\n\nExamples:\n- Use git: commit after each module, push to origin/main\n- GLM agent skips frontend work\n- Always add JSDoc comments\n- Run tests after each wave", 
      state.current_plan?.execution_notes || ""
    );
    if (notes !== undefined) {
      // Store execution notes in state and plan
      if (state.current_plan) {
        state.current_plan.execution_notes = notes.trim();
        // Update the plan file with execution notes
        if (state.planFileName) {
          updatePlanExecutionNotes(state.planFileName, notes.trim());
        }
      }
      ctx.ui.notify(notes.trim() ? "✓ Execution notes saved." : "Execution notes cleared.", "info");
      
      // Return to approval flow
      const returnToReview = await ctx.ui.confirm(
        "Return to Plan Review",
        "Execution notes saved. Would you like to return to the plan review to approve?"
      );
      
      if (returnToReview) {
        await approvePlan(ctx);
      }
    }
  }
}

async function rejectPlan(ctx: ExtensionContext): Promise<void> {
  if (state.current_plan && state.planFileName) {
    state.current_plan.status = "cancelled";
    updatePlanStatus(state.planFileName, "cancelled");
  }

  state.enabled = false;
  state.execution_mode = false;
  state.current_plan = undefined;
  state.plan_file_path = undefined;
  state.planFileName = undefined;
  state.execution_mode_selection = undefined;
  state.preferred_execution_mode = undefined;
  state.validation_strategy = undefined;
  state.project_complexity = undefined;

  piRef.setActiveTools(NORMAL_MODE_TOOLS);
  updateStatus(ctx);
  persistState();

  ctx.ui.notify("❌ Plan cancelled and plan mode exited.", "info");
}

async function showStatus(ctx: ExtensionContext): Promise<void> {
  if (!state.enabled && !state.execution_mode) {
    ctx.ui.notify("Not in plan mode. Use /plan to start planning.", "info");
    return;
  }

  const lines: string[] = [];
  lines.push("📊 Plan Mode Status");
  lines.push("");
  lines.push(`Mode: ${state.execution_mode ? "🔧 Execution" : "📝 Planning"}`);
  
  if (state.current_plan) {
    lines.push(`Task: ${state.current_plan.task}`);
    lines.push(`Status: ${state.current_plan.status}`);
    lines.push(`Risk: ${formatRiskLevel(state.current_plan.risk_level)}`);
    lines.push(`Effort: ${formatEffortLevel(state.current_plan.estimated_effort)}`);
    
    if (state.current_plan.implementation_plan.length > 0) {
      const completed = state.current_plan.implementation_plan.filter(s => s.completed).length;
      const total = state.current_plan.implementation_plan.length;
      lines.push(`Progress: ${completed}/${total} steps`);
    }
    
    if (state.plan_file_path) {
      lines.push(`Plan file: ${state.plan_file_path}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

// UI updates
function updateStatus(ctx: ExtensionContext): void {
  if (state.execution_mode && state.current_plan) {
    const completed = state.current_plan.implementation_plan.filter(s => s.completed).length;
    const total = state.current_plan.implementation_plan.length;
    ctx.ui.setStatus("enhanced-plan-mode", 
      ctx.ui.theme.fg("accent", `🔧 Executing ${completed}/${total}`));
  } else if (state.enabled && state.current_plan) {
    ctx.ui.setStatus("enhanced-plan-mode", 
      ctx.ui.theme.fg("warning", `📝 ${state.current_plan.status}`));
  } else if (state.enabled) {
    ctx.ui.setStatus("enhanced-plan-mode", 
      ctx.ui.theme.fg("warning", "📝 plan mode"));
  } else {
    ctx.ui.setStatus("enhanced-plan-mode", undefined);
  }
}

// Ensure plan is loaded from file if not in memory
async function ensurePlanLoaded(ctx: ExtensionContext): Promise<boolean> {
  // If we already have a plan in memory and plan mode is enabled, we're good
  if (state.enabled && state.current_plan && state.planFileName) {
    return true;
  }
  
  // Try to restore state from session first
  restoreState(ctx);
  
  // Check again after restore
  if (state.enabled && state.current_plan && state.planFileName) {
    return true;
  }
  
  // If still no plan, look for recent plan files
  const plans = listPlans();
  if (plans.length === 0) {
    ctx.ui.notify("No active plan to approve. Use /plan first.", "warning");
    return false;
  }
  
  // Get the most recent non-completed plan
  const recentPlan = plans.find(p => p.status !== "completed" && p.status !== "cancelled");
  if (!recentPlan) {
    ctx.ui.notify("No active plan to approve. Use /plan first.", "warning");
    return false;
  }
  
  // Load the plan from file
  const loadedPlan = loadPlan(recentPlan.filename);
  if (!loadedPlan) {
    ctx.ui.notify("Failed to load plan file. Use /plan first.", "warning");
    return false;
  }
  
  // Update state with loaded plan
  state.enabled = true;
  state.execution_mode = false;
  state.current_plan = loadedPlan;
  state.planFileName = recentPlan.filename;
  state.plan_file_path = path.join(os.homedir(), ".pi", "plans", recentPlan.filename);
  
  ctx.ui.notify(`Loaded plan: ${loadedPlan.task}`, "info");
  persistState();
  return true;
}

// Prompt generation
function generateInitialPlanModePrompt(): string {
  return `[PLAN MODE ACTIVE]

You are in ENHANCED PLAN MODE - a structured planning workflow with wave-based analysis.

Available Tools:
- read, bash (safe commands only), grep, find, ls
- subagent - for parallel wave-based analysis (scout, web-researcher, planner, worker, architect, deep-research)
- write/edit - ONLY for saving plan files to ~/.pi/plans/

⚠️ IMPORTANT: You CAN write files to ~/.pi/plans/ directory to save the plan.
All other file modifications are blocked until the plan is approved.

Your task:
1. Understand what the user wants to accomplish
2. Ask clarifying questions DIRECTLY in the chat (do NOT use a subagent for questions)
3. Use the subagent tool for wave-based analysis:
   - Wave 1: Parallel scouts gather initial context (use scout, web-researcher for quick research)
   - Wave 2: Architecture/design if needed (use architect)
   - Wave 3: Deep dive into identified areas (use planner)
   
4. For HIGH-RISK architectural decisions (e.g., database choice, auth strategy):
   - Use deep-research agent at the END of planning
   - Only for critical, hard-to-reverse decisions
   - Provides exhaustive analysis (10-20+ sources)
5. Create a detailed plan following the schema
6. Save the plan to ~/.pi/plans/ using write()

⚠️ TEST PLANNING REQUIREMENT:
Unless the task explicitly excludes testing or is purely documentation/minor config changes, 
ALWAYS include a comprehensive Test Plan section with:
- Unit tests for new/modified functions
- Integration tests for component interactions
- E2E tests for user-facing features
- Test data requirements
- Mocking strategy for external dependencies

Target: Aim for >80% code coverage unless there's a specific reason not to.

DO NOT modify any code files. Only analyze, plan, and save the plan file.

When ready, save the plan and the user will approve it before execution.`;
}

// Generate planning prompt with user preferences
function generatePlanningPrompt(task: string, executionMode: string, validationStrategy: string, complexity?: string): string {
  const complexityGuidance = complexity ? `

📊 PROJECT COMPLEXITY: ${complexity.toUpperCase()}

${complexity === "complex" ? `This is a COMPLEX project. You MUST use detailed modular waves:
- Break into 6-10+ small, focused modules
- Maximize parallelization (aim for 40%+ parallel modules)
- Explicit dependency mapping for each module
- Clear wave groupings (Wave 1, Wave 2, etc.)
- Each module should be delegatable to a single subagent` : 
complexity === "moderate" ? `This is a MODERATE complexity project. Use modular waves:
- Break into 4-6 modules
- Identify parallel opportunities where dependencies allow
- Group into 2-3 waves
- Mix of sequential and parallel execution` :
`This is a SIMPLE project. Focus on clarity over modularity:
- 2-4 sequential phases is fine
- Can use "Phase" format if clearer than modules
- Parallelization optional`}` : "";

  const orchestratorInstructions = executionMode === "orchestrator" ? `

⚡ ORCHESTRATOR MODE SELECTED:
The user wants this plan designed for SUBAGENT execution. Structure the plan as MODULAR WAVES:${complexityGuidance}

Wave Structure:
- Wave 1: Foundation modules (dependencies for everything else)
  Example: Project setup, database schema, core types
  
- Wave 2: Independent modules (can be done in parallel)
  Example: Auth module + API routes module + UI components module
  
- Wave 3: Integration modules (depend on Wave 2)
  Example: Feature pages that use auth + API + components
  
- Wave N: Final integration and testing

For each module, specify:
1. Module name and purpose
2. Dependencies (what must be done first)
3. Files to create/modify
4. Can it be parallelized? (yes/no)
5. Estimated effort

Example Module Format:
### Module 1: Project Setup
**Dependencies**: None (foundation)
**Parallelizable**: No (blocks all other modules)
**Files**: 
- Initialize Next.js project
- Install dependencies
- Configure tooling
**Effort**: 30 min

### Module 2: Database Schema  
**Dependencies**: Module 1
**Parallelizable**: No (needed for API)
**Files**:
- Create schema.sql
- Set up Supabase connection
**Effort**: 30 min

### Module 3A: Auth Pages (Parallel with 3B)
**Dependencies**: Module 1, Module 2
**Parallelizable**: Yes
**Files**:
- Login page
- Signup page
**Effort**: 1 hour

### Module 3B: Timer Component (Parallel with 3A)
**Dependencies**: Module 1
**Parallelizable**: Yes  
**Files**:
- TimerDisplay component
- TimerControls component
**Effort**: 1 hour
` : "";

  const validationLevel = validationStrategy.split(" - ")[0];
  const validationInstructions = validationStrategy.includes("None") ? "" : `

✓ VALIDATION STRATEGY: ${validationStrategy}

The user wants ${validationLevel.toLowerCase()} validation. Interpret this for the specific project type:

FOR SOFTWARE PROJECTS:
${validationLevel === "Light" ? "- Basic smoke tests for critical paths" : 
  validationLevel === "Moderate" ? "- Test critical functionality + key business logic" :
  "- Full test coverage (unit, integration, E2E) with detailed test cases"}

FOR CONTENT/DOCUMENTATION PROJECTS:
${validationLevel === "Light" ? "- Check links work and format is consistent" : 
  validationLevel === "Moderate" ? "- Verify internal links, consistent formatting, and key cross-references" :
  "- Comprehensive validation: all links, formatting consistency, cross-references, completeness checks"}

FOR DATA/INFRASTRUCTURE PROJECTS:
${validationLevel === "Light" ? "- Verify core functionality works" : 
  validationLevel === "Moderate" ? "- Validate data integrity and key integrations" :
  "- Full validation: data integrity, all integrations, error handling, performance checks"}

Include a specific Verification Plan section with concrete validation steps, not just "validate outputs".`;

  return `Let's create a plan for: ${task}

Execution Strategy: ${executionMode}${orchestratorInstructions}${validationInstructions}

${generateSubagentInstructions(task)}`;
}

function generatePlanModePrompt(plan: PlanSchema): string {
  const hasTestPlan = plan.test_plan && (
    plan.test_plan.unit_tests.length > 0 ||
    plan.test_plan.integration_tests.length > 0 ||
    plan.test_plan.e2e_tests.length > 0
  );
  
  const testStatus = hasTestPlan 
    ? "✓ Test Plan included" 
    : "⚠️ TEST PLAN REQUIRED: Add unit, integration, and E2E tests to the plan";

  return `[PLAN MODE ACTIVE - Plan: ${plan.task}]

Current Plan Status: ${plan.status}
Risk Level: ${plan.risk_level}
Estimated Effort: ${plan.estimated_effort}
Test Coverage: ${testStatus}

Continue refining the plan. You can:
- Use subagent tool for additional analysis waves (scout, web-researcher, planner, worker, architect)
- Use deep-research agent ONLY for critical high-risk architectural decisions at the end
- Ask clarifying questions DIRECTLY in chat (not via subagent)
- Update the plan file in ~/.pi/plans/ with write()

⚠️ WRITE PERMISSIONS: You CAN write to ~/.pi/plans/ to update the plan file.
All other file modifications remain blocked until approval.

REMEMBER: A plan is NOT complete without adequate test coverage!
- Unit tests for individual functions
- Integration tests for component interactions  
- E2E tests for critical user paths
- Target: >80% code coverage

DO NOT modify code files. Only analyze, plan, and save plan files.

Available commands for the user:
- /approve or a - Approve the plan and proceed to execution
- /modify or m - Request modifications
- /reject or r - Cancel planning
- /status - Show current status

Plan file: ${state.plan_file_path || "Not saved yet"}`;
}

function generateExecutionPrompt(plan: PlanSchema, mode?: ExecutionMode, planFilePath?: string, fullPlanContent?: string): string {
  const modeInstructions: Record<ExecutionMode, string> = {
    direct: "Execute the plan directly in this session. Work through each step systematically. Focus ONLY on implementing what is described in each step.",
    orchestrator_testing: "Act as orchestrator - verify each step and test as you go. Spawn subagents for independent work units. Focus ONLY on implementing what is described in each step.",
    pure_orchestrator: "Fully decompose the plan and spawn subagents for parallel execution where possible. Focus ONLY on implementing what is described in each step.",
    pause: "Execution paused for verification."
  };

  // Build detailed steps list with full descriptions
  const stepsList = plan.implementation_plan
    .map(s => {
      const files = s.files?.length > 0 ? `\n   Files: ${s.files.join(", ")}` : "";
      const desc = s.description ? `\n   Description: ${s.description}` : "";
      const outcome = s.expected_outcome ? `\n   Expected: ${s.expected_outcome}` : "";
      return `${s.step_number}. ${s.title}${s.completed ? " [DONE]" : ""}${files}${desc}${outcome}`;
    })
    .join("\n\n");

  // Build files to modify section
  const filesToModify = plan.analysis?.files_to_modify?.length > 0
    ? "\n\nFiles to Create/Modify:\n" + plan.analysis.files_to_modify
        .map(f => `- ${f.path}: ${f.purpose}`)
        .join("\n")
    : "";

  // Include full plan content if available
  const fullPlanSection = fullPlanContent 
    ? `\n\n📄 FULL PLAN DOCUMENT:\n${fullPlanContent}`
    : planFilePath
      ? `\n\n📄 FULL PLAN DOCUMENT:\nLocation: ${planFilePath}\n\nRead this file for complete plan details including database schema, API endpoints, and project structure.`
      : "";

  // Orchestrator-specific modular wave instructions
  const orchestratorWaveInstructions = (mode === "orchestrator_testing" || mode === "pure_orchestrator") ? `

🌊 ORCHESTRATOR WAVE EXECUTION:

If the plan is structured as modular waves (Wave 1, Wave 2, etc.):

SEQUENTIAL WAVES (Dependencies):
- Wave 1: Execute sequentially in main session (foundation modules)
- Spawn ONE subagent per module in Wave 1, wait for completion
- Verify each module before proceeding to next wave

PARALLEL MODULES (Independent):
- Within a wave, spawn MULTIPLE subagents simultaneously
- Each subagent handles ONE module independently
- Wait for all to complete before next wave

SUBAGENT INSTRUCTIONS:
When spawning subagents, provide:
1. Module name and specific files to create/modify
2. Full context from the plan document
3. Clear success criteria
4. Instruction to report [DONE:module_name] when complete

Example subagent task:
"Implement Module 3A: Auth Pages
Files to create:
- src/app/(auth)/login/page.tsx
- src/app/(auth)/signup/page.tsx
Dependencies: Module 1 (project setup) and Module 2 (database) are complete
Acceptance criteria: [list criteria]
Report [DONE:auth_pages] when complete."

COMBAT CONTEXT ROT:
- Keep main session lean - delegate implementation to subagents
- Main session focuses on orchestration, verification, and integration
- Test each module before marking complete
` : "";

  // Include execution notes if present
  const executionNotesSection = plan.execution_notes ? `

📝 EXECUTION NOTES (User Preferences):
${plan.execution_notes}

These preferences should guide HOW you execute, but not change WHAT needs to be done.` : "";

  return `[PLAN EXECUTION MODE - ${mode || "direct"}]

🎯 TASK: ${plan.task}
📊 Risk Level: ${plan.risk_level}
⚡ Mode: ${mode || "direct"}${executionNotesSection}

INSTRUCTIONS:
${modeInstructions[mode || "direct"]}${orchestratorWaveInstructions}

⚠️ IMPORTANT: Execute ONLY the implementation steps below. Do NOT read or execute from any research/analysis files that may exist in the codebase. Focus on implementing the code changes described in each step.

📋 IMPLEMENTATION PLAN:
${stepsList || "(No implementation steps defined - ask user for clarification)"}${filesToModify}${fullPlanSection}

After completing each step, mark it with [DONE:n] in your response.
Include [DONE:all] when the entire plan is complete.

When the user confirms all functionality is working correctly, remind them to use /done to sign off and complete the plan (this will delete the plan file).`;
}

// Test plan validation
function validateTestPlan(plan: PlanSchema): { hasAdequateTests: boolean; issues: string[] } {
  const issues: string[] = [];
  
  // Check if test plan exists
  if (!plan.test_plan) {
    issues.push("No Test Plan section found");
  } else {
    const tp = plan.test_plan;
    
    // Check unit tests
    if (tp.unit_tests.length === 0) {
      issues.push("No unit tests defined");
    }
    
    // Check integration tests
    if (tp.integration_tests.length === 0) {
      issues.push("No integration tests defined");
    }
    
    // Check if unit tests have assertions
    const unitTestsWithAssertions = tp.unit_tests.filter(t => t.assertions.length > 0).length;
    if (tp.unit_tests.length > 0 && unitTestsWithAssertions < tp.unit_tests.length) {
      issues.push("Some unit tests lack specific assertions");
    }
    
    // Check for edge cases
    const testsWithEdgeCases = [...tp.unit_tests, ...tp.integration_tests].filter(
      t => t.edge_cases && t.edge_cases.length > 0
    ).length;
    const totalTests = tp.unit_tests.length + tp.integration_tests.length;
    if (totalTests > 0 && testsWithEdgeCases < totalTests / 2) {
      issues.push("Many tests don't specify edge cases to test");
    }
    
    // Check mocking strategy for integration tests
    if (tp.integration_tests.length > 0 && !tp.mocking_strategy) {
      issues.push("Integration tests present but no mocking strategy defined");
    }
    
    // Check test data requirements
    if (tp.integration_tests.length > 0 && tp.test_data_requirements.length === 0) {
      issues.push("Integration tests present but no test data requirements defined");
    }
  }
  
  // Check if verification plan includes testing
  const hasTestVerification = plan.verification_plan.some(
    v => v.toLowerCase().includes("test") || v.toLowerCase().includes("coverage")
  );
  if (!hasTestVerification) {
    issues.push("Verification plan doesn't mention testing or coverage");
  }
  
  // A plan has adequate tests if it has at least unit tests and some form of integration/E2E testing
  const hasUnitTests = plan.test_plan && plan.test_plan.unit_tests.length > 0;
  const hasIntegrationOrE2E = plan.test_plan && 
    (plan.test_plan.integration_tests.length > 0 || plan.test_plan.e2e_tests.length > 0);
  
  return {
    hasAdequateTests: hasUnitTests && hasIntegrationOrE2E && issues.length <= 2,
    issues
  };
}

// Utility functions
function isDestructiveCommand(command: string): boolean {
  const destructivePatterns = [
    /\brm\b/i,
    /\brmdir\b/i,
    /\bmv\b/i,
    /\bcp\b/i,
    /\bmkdir\b/i,
    /\btouch\b/i,
    /\bchmod\b/i,
    /\bchown\b/i,
    /\bln\b/i,
    /\btee\b/i,
    /\btruncate\b/i,
    /\bdd\b/i,
    /\bshred\b/i,
    /(^|[^<])>(?!>)/,
    />>/,
    /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
    /\byarn\s+(add|remove|install|publish)/i,
    /\bpnpm\s+(add|remove|install|publish)/i,
    /\bpip\s+(install|uninstall)/i,
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash)/i,
    /\bsudo\b/i,
    /\bsu\b/i,
    /\bkill\b/i,
    /\breboot\b/i,
    /\bshutdown\b/i,
    /\b(vim?|nano|emacs|code)\b/i
  ];

  return destructivePatterns.some(p => p.test(command));
}
