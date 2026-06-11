/**
 * Type definitions for Enhanced Plan Mode Extension
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

// Plan status lifecycle
export type PlanStatus = 
  | "pending" 
  | "under_review" 
  | "approved" 
  | "in_progress" 
  | "paused_for_verification" 
  | "completed" 
  | "cancelled";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type EffortLevel = "small" | "medium" | "large" | "epic";
export type ExecutionMode = "direct" | "orchestrator_testing" | "pure_orchestrator" | "pause";

// Plan file schema (YAML frontmatter + markdown body)
export interface PlanSchema {
  // YAML frontmatter
  task: string;
  created: string; // ISO timestamp
  status: PlanStatus;
  risk_level: RiskLevel;
  estimated_effort: EffortLevel;
  preferred_execution_mode?: ExecutionMode; // User-selected execution strategy
  validation_strategy?: string; // User-selected validation/quality approach
  
  // Execution guidance (not part of the plan content, but guides execution)
  execution_notes?: string; // User preferences for execution (git workflow, agent assignments, etc.)
  
  // Body sections
  summary: string;
  analysis: AnalysisSection;
  implementation_plan: ImplementationStep[];
  test_plan?: TestPlanSection; // Optional but recommended test plan
  alternative_approaches: AlternativeApproach[];
  verification_plan: string[];
}

export interface AnalysisSection {
  files_to_read: FileReference[];
  files_to_modify: FileReference[];
  dependencies: string[];
  risks: RiskItem[];
  test_strategy?: TestStrategy; // Optional test planning section
}

export interface FileReference {
  path: string;
  purpose: string;
}

export interface RiskItem {
  description: string;
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  mitigation: string;
}

export interface ImplementationStep {
  step_number: number;
  title: string;
  files: string[];
  description: string;
  expected_outcome: string;
  rollback: string;
  completed: boolean;
}

export interface AlternativeApproach {
  name: string;
  pros: string[];
  cons: string[];
  why_not_selected: string;
}

// Test planning types
export interface TestStrategy {
  approach: "unit" | "integration" | "e2e" | "mixed";
  coverage_target: number; // percentage (e.g., 80 for 80%)
  test_files: TestFile[];
  testing_notes: string;
}

export interface TestFile {
  path: string;
  type: "unit" | "integration" | "e2e";
  description: string;
  test_cases: string[];
}

export interface TestPlanSection {
  unit_tests: TestStep[];
  integration_tests: TestStep[];
  e2e_tests: TestStep[];
  test_data_requirements: string[];
  mocking_strategy: string;
}

export interface TestStep {
  description: string;
  target: string; // file/function being tested
  assertions: string[];
  edge_cases: string[];
}

// Wave-based analysis types
export interface WaveConfig {
  wave_number: number;
  description: string;
  tasks: AnalysisTask[];
  parallel: boolean;
}

export interface AnalysisTask {
  agent: string;
  task: string;
  target?: string; // directory or file to analyze
}

export interface AnalysisResult {
  agent: string;
  task: string;
  findings: Finding[];
  recommendations?: string[];
  needs_deeper_analysis?: boolean;
}

export interface Finding {
  type: "file" | "pattern" | "dependency" | "risk" | "opportunity";
  location?: string;
  description: string;
  severity?: "info" | "warning" | "critical";
}

// Extension state
export interface PlanModeState {
  enabled: boolean;
  execution_mode: boolean;
  current_plan?: PlanSchema;
  plan_file_path?: string;
  analysis_results?: AnalysisResult[];
  current_wave?: number;
}

// Risk assessment matrix
export interface RiskAssessment {
  files_modified: number;
  code_complexity: "simple" | "moderate" | "complex" | "architectural";
  test_coverage: "full" | "partial" | "minimal" | "none";
  dependencies: "none" | "few" | "many" | "circular";
  blast_radius: "isolated" | "component" | "system_wide" | "core_infrastructure";
  data_impact: "none" | "cached" | "persistent" | "user_critical";
}

// Type guards
export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

export function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
