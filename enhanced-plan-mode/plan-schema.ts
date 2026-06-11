/**
 * Plan Schema Module
 * 
 * Handles YAML frontmatter parsing/generation and plan file I/O
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { 
  PlanSchema, 
  PlanStatus, 
  RiskLevel, 
  EffortLevel,
  ImplementationStep,
  RiskItem,
  FileReference,
  AlternativeApproach,
  TestPlanSection,
  TestStep
} from "./types.js";

// Directory for plan files
const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");

/**
 * Ensure the plans directory exists
 */
export function ensurePlansDirectory(): void {
  if (!fs.existsSync(PLANS_DIR)) {
    fs.mkdirSync(PLANS_DIR, { recursive: true });
  }
}

/**
 * Generate a plan filename based on timestamp and task description
 */
export function generatePlanFilename(task: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[:.]/g, "")
    .slice(0, 15); // YYYYMMDDTHHMMSS
  const sanitized = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 50);
  return `${timestamp}_${sanitized}.md`;
}

/**
 * Parse YAML frontmatter from markdown content
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const yamlContent = match[1];
  const body = match[2];
  
  // Simple YAML parser for our specific needs
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlContent.split("\n");
  
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = parseYamlValue(value);
    }
  }
  
  return { frontmatter, body };
}

function parseYamlValue(value: string): unknown {
  // Remove quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) || 
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;
  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

/**
 * Serialize frontmatter to YAML string
 */
export function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && (value.includes(":") || value.includes("#"))) {
      lines.push(`${key}: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Parse a plan file from markdown content
 * Handles both YAML frontmatter format and plain markdown format
 */
export function parsePlan(content: string): Partial<PlanSchema> {
  const { frontmatter, body } = parseFrontmatter(content);
  
  // Extract task from frontmatter, or fall back to title
  let task = frontmatter.task as string || "";
  if (!task) {
    // Try to extract from H1 title
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      task = titleMatch[1].trim();
    }
  }
  
  // Extract status from frontmatter, or try to find it in body
  let status: PlanStatus = (frontmatter.status as PlanStatus) || "pending";
  if (!frontmatter.status) {
    const statusMatch = content.match(/\*\*Status\*\*[:\s]+([^\n]+)/i);
    if (statusMatch) {
      const statusText = statusMatch[1].toLowerCase();
      if (statusText.includes("draft") || statusText.includes("awaiting")) {
        status = "pending";
      } else if (statusText.includes("approved")) {
        status = "approved";
      } else if (statusText.includes("progress") || statusText.includes("in progress")) {
        status = "in_progress";
      } else if (statusText.includes("completed") || statusText.includes("done")) {
        status = "completed";
      } else if (statusText.includes("cancelled") || statusText.includes("rejected")) {
        status = "cancelled";
      }
    }
  }
  
  // Extract created date from frontmatter, or try to find it in body
  let created = frontmatter.created as string || new Date().toISOString();
  if (!frontmatter.created) {
    const createdMatch = content.match(/\*\*Created\*\*[:\s]+([^\n]+)/i);
    if (createdMatch) {
      const date = new Date(createdMatch[1]);
      if (!isNaN(date.getTime())) {
        created = date.toISOString();
      }
    }
  }
  
  const plan: Partial<PlanSchema> = {
    task,
    created,
    status,
    risk_level: (frontmatter.risk_level as RiskLevel) || "low",
    estimated_effort: (frontmatter.estimated_effort as EffortLevel) || "small",
  };
  
  // Parse body sections
  const sections = parseBodySections(body);
  plan.summary = sections.summary || "";
  plan.analysis = sections.analysis || { files_to_read: [], files_to_modify: [], dependencies: [], risks: [] };
  plan.implementation_plan = sections.implementation_plan || [];
  plan.alternative_approaches = sections.alternative_approaches || [];
  plan.verification_plan = sections.verification_plan || [];
  
  return plan;
}

function parseBodySections(body: string): Partial<PlanSchema> {
  const sections: Partial<PlanSchema> = {};
  
  // Extract summary (first paragraph)
  const summaryMatch = body.match(/^\n*([^#\n][^\n]*(?:\n[^#\n][^\n]*)*)/);
  if (summaryMatch) {
    sections.summary = summaryMatch[1].trim();
  }
  
  // Extract Analysis section
  const analysisMatch = body.match(/## Analysis\s*\n([\s\S]*?)(?=\n## |$)/);
  if (analysisMatch) {
    sections.analysis = parseAnalysisSection(analysisMatch[1]);
  }
  
  // Extract Implementation Plan section
  const planMatch = body.match(/## Implementation Plan\s*\n([\s\S]*?)(?=\n## |$)/);
  if (planMatch) {
    sections.implementation_plan = parseImplementationPlan(planMatch[1]);
  }
  
  // Extract Alternative Approaches section
  const altMatch = body.match(/## Alternative Approaches(?: Considered)?\s*\n([\s\S]*?)(?=\n## |$)/);
  if (altMatch) {
    sections.alternative_approaches = parseAlternativeApproaches(altMatch[1]);
  }
  
  // Extract Test Plan section
  const testMatch = body.match(/## Test Plan\s*\n([\s\S]*?)(?=\n## |$)/);
  if (testMatch) {
    sections.test_plan = parseTestPlan(testMatch[1]);
  }
  
  // Extract Verification Plan section
  const verifyMatch = body.match(/## Verification Plan\s*\n([\s\S]*?)(?=\n## |$)/);
  if (verifyMatch) {
    sections.verification_plan = parseVerificationPlan(verifyMatch[1]);
  }
  
  return sections;
}

function parseAnalysisSection(content: string): PlanSchema["analysis"] {
  const analysis: PlanSchema["analysis"] = {
    files_to_read: [],
    files_to_modify: [],
    dependencies: [],
    risks: []
  };
  
  // Files to Read
  const readMatch = content.match(/### Files to Read\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (readMatch) {
    analysis.files_to_read = parseFileList(readMatch[1]);
  }
  
  // Files to Modify
  const modifyMatch = content.match(/### Files to Modify\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (modifyMatch) {
    analysis.files_to_modify = parseFileList(modifyMatch[1]);
  }
  
  // Dependencies
  const depsMatch = content.match(/### Dependencies\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (depsMatch) {
    analysis.dependencies = parseList(depsMatch[1]);
  }
  
  // Risks
  const risksMatch = content.match(/### Risks\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (risksMatch) {
    analysis.risks = parseRisks(risksMatch[1]);
  }
  
  return analysis;
}

function parseFileList(content: string): FileReference[] {
  const files: FileReference[] = [];
  const lines = content.split("\n");
  
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+`([^`]+)`\s*[-–]\s*(.+)$/);
    if (match) {
      files.push({ path: match[1], purpose: match[2] });
    }
  }
  
  return files;
}

function parseList(content: string): string[] {
  const items: string[] = [];
  const lines = content.split("\n");
  
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  
  return items;
}

function parseRisks(content: string): RiskItem[] {
  const risks: RiskItem[] = [];
  const lines = content.split("\n");
  
  for (const line of lines) {
    // Match table rows or list items
    const match = line.match(/^\s*[-*]\s+(.+?)\s*\|\s*(low|medium|high)\s*\|\s*(low|medium|high)\s*\|\s*(.+)$/i);
    if (match) {
      risks.push({
        description: match[1].trim(),
        likelihood: match[2].toLowerCase() as RiskItem["likelihood"],
        impact: match[3].toLowerCase() as RiskItem["impact"],
        mitigation: match[4].trim()
      });
    }
  }
  
  return risks;
}

function parseImplementationPlan(content: string): ImplementationStep[] {
  const steps: ImplementationStep[] = [];
  const stepBlocks = content.split(/\n### Step \d+:/);
  
  let stepNumber = 1;
  for (const block of stepBlocks.slice(1)) {
    const titleMatch = block.match(/^\s*(.+?)\s*\n/);
    const filesMatch = block.match(/\*\*Files\*\*:\s*(`[^`]+`(?:,\s*`[^`]+`)*)/);
    const descMatch = block.match(/\*\*Description\*\*:\s*\n?([\s\S]*?)(?=\*\*|$)/);
    const outcomeMatch = block.match(/\*\*Expected Outcome\*\*:\s*\n?([\s\S]*?)(?=\*\*|$)/);
    const rollbackMatch = block.match(/\*\*Rollback\*\*:\s*\n?([\s\S]*?)(?=\n### |$)/);
    
    steps.push({
      step_number: stepNumber++,
      title: titleMatch?.[1].trim() || `Step ${stepNumber}`,
      files: filesMatch ? filesMatch[1].match(/`([^`]+)`/g)?.map(f => f.slice(1, -1)) || [] : [],
      description: descMatch?.[1].trim() || "",
      expected_outcome: outcomeMatch?.[1].trim() || "",
      rollback: rollbackMatch?.[1].trim() || "Revert the changes",
      completed: false
    });
  }
  
  return steps;
}

function parseAlternativeApproaches(content: string): AlternativeApproach[] {
  const approaches: AlternativeApproach[] = [];
  const altBlocks = content.split(/\n### (Option [A-Z]|Alternative \d+):/);
  
  for (let i = 1; i < altBlocks.length; i += 2) {
    const name = altBlocks[i].trim();
    const block = altBlocks[i + 1] || "";
    
    const prosMatch = block.match(/\*\*Pros\*\*:\s*\n?([\s\S]*?)(?=\*\*Cons|$)/);
    const consMatch = block.match(/\*\*Cons\*\*:\s*\n?([\s\S]*?)(?=\*\*Why|$)/);
    const whyMatch = block.match(/\*\*Why Not Selected\*\*:\s*\n?([\s\S]*?)(?=\n### |$)/);
    
    approaches.push({
      name,
      pros: prosMatch ? parseList(prosMatch[1]) : [],
      cons: consMatch ? parseList(consMatch[1]) : [],
      why_not_selected: whyMatch?.[1].trim() || ""
    });
  }
  
  return approaches;
}

function parseVerificationPlan(content: string): string[] {
  return parseList(content);
}

function parseTestPlan(content: string): TestPlanSection {
  const testPlan: TestPlanSection = {
    unit_tests: [],
    integration_tests: [],
    e2e_tests: [],
    test_data_requirements: [],
    mocking_strategy: ""
  };
  
  // Unit Tests
  const unitMatch = content.match(/### Unit Tests\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (unitMatch) {
    testPlan.unit_tests = parseTestSteps(unitMatch[1]);
  }
  
  // Integration Tests
  const integrationMatch = content.match(/### Integration Tests\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (integrationMatch) {
    testPlan.integration_tests = parseTestSteps(integrationMatch[1]);
  }
  
  // E2E Tests
  const e2eMatch = content.match(/### (E2E|End-to-End) Tests\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (e2eMatch) {
    testPlan.e2e_tests = parseTestSteps(e2eMatch[2] || e2eMatch[1]);
  }
  
  // Test Data Requirements
  const dataMatch = content.match(/### Test Data(?: Requirements)?\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (dataMatch) {
    testPlan.test_data_requirements = parseList(dataMatch[1]);
  }
  
  // Mocking Strategy
  const mockMatch = content.match(/### Mocking Strategy\s*\n([\s\S]*?)(?=\n### |\n## |$)/);
  if (mockMatch) {
    testPlan.mocking_strategy = mockMatch[1].trim();
  }
  
  return testPlan;
}

function parseTestSteps(content: string): TestStep[] {
  const steps: TestStep[] = [];
  const stepBlocks = content.split(/\n\d+\.\s+|\n- \*\*/);
  
  for (const block of stepBlocks.slice(1)) {
    const description = block.match(/^(.+?)\n/);
    const targetMatch = block.match(/\*\*Target\*\*:\s*(.+?)(?:\n|$)/);
    const assertionsMatch = block.match(/\*\*Assertions\*\*:\s*\n?([\s\S]*?)(?=\*\*|$)/);
    const edgeCasesMatch = block.match(/\*\*Edge Cases\*\*:\s*\n?([\s\S]*?)(?=\n\d+\.|\n- \*\*|\n###|$)/);
    
    if (description) {
      steps.push({
        description: description[1].trim().replace(/\*\*/g, ""),
        target: targetMatch?.[1].trim() || "",
        assertions: assertionsMatch ? parseList(assertionsMatch[1]) : [],
        edge_cases: edgeCasesMatch ? parseList(edgeCasesMatch[1]) : []
      });
    }
  }
  
  return steps;
}

/**
 * Serialize a plan to markdown content
 */
export function serializePlan(plan: PlanSchema): string {
  const frontmatter = {
    task: plan.task,
    created: plan.created,
    status: plan.status,
    risk_level: plan.risk_level,
    estimated_effort: plan.estimated_effort
  };
  
  const sections: string[] = [
    serializeFrontmatter(frontmatter),
    "",
    "## Summary",
    plan.summary,
    "",
    serializeAnalysisSection(plan.analysis),
    "",
    serializeImplementationPlan(plan.implementation_plan),
    ""
  ];
  
  // Add test plan if present
  if (plan.test_plan) {
    sections.push(serializeTestPlan(plan.test_plan));
    sections.push("");
  }
  
  sections.push(serializeAlternativeApproaches(plan.alternative_approaches));
  sections.push("");
  sections.push(serializeVerificationPlan(plan.verification_plan));
  
  return sections.join("\n");
}

function serializeAnalysisSection(analysis: PlanSchema["analysis"]): string {
  const lines = ["## Analysis"];
  
  lines.push("", "### Files to Read");
  for (const file of analysis.files_to_read) {
    lines.push(`- \`${file.path}\` - ${file.purpose}`);
  }
  
  lines.push("", "### Files to Modify");
  for (const file of analysis.files_to_modify) {
    lines.push(`- \`${file.path}\` - ${file.purpose}`);
  }
  
  lines.push("", "### Dependencies");
  for (const dep of analysis.dependencies) {
    lines.push(`- ${dep}`);
  }
  
  lines.push("", "### Risks");
  lines.push("| Risk | Likelihood | Impact | Mitigation |");
  lines.push("|------|------------|--------|------------|");
  for (const risk of analysis.risks) {
    lines.push(`| ${risk.description} | ${risk.likelihood} | ${risk.impact} | ${risk.mitigation} |`);
  }
  
  return lines.join("\n");
}

function serializeImplementationPlan(steps: ImplementationStep[]): string {
  const lines = ["## Implementation Plan"];
  
  for (const step of steps) {
    lines.push(
      "",
      `### Step ${step.step_number}: ${step.title}`,
      `**Files**: ${step.files.map(f => `\`${f}\``).join(", ")}`,
      `**Description**: ${step.description}`,
      `**Expected Outcome**: ${step.expected_outcome}`,
      `**Rollback**: ${step.rollback}`
    );
  }
  
  return lines.join("\n");
}

function serializeAlternativeApproaches(approaches: AlternativeApproach[]): string {
  const lines = ["## Alternative Approaches Considered"];
  
  const labels = ["A", "B", "C", "D", "E"];
  for (let i = 0; i < approaches.length; i++) {
    const alt = approaches[i];
    lines.push(
      "",
      `### Option ${labels[i] || i + 1}: ${alt.name}`,
      "**Pros**:",
      ...alt.pros.map(p => `- ${p}`),
      "",
      "**Cons**:",
      ...alt.cons.map(c => `- ${c}`),
      "",
      `**Why Not Selected**: ${alt.why_not_selected}`
    );
  }
  
  return lines.join("\n");
}

function serializeVerificationPlan(checklist: string[]): string {
  const lines = ["## Verification Plan", ""];
  for (const item of checklist) {
    lines.push(`- [ ] ${item}`);
  }
  return lines.join("\n");
}

function serializeTestPlan(testPlan: TestPlanSection): string {
  const lines = ["## Test Plan"];
  
  // Unit Tests
  if (testPlan.unit_tests.length > 0) {
    lines.push("", "### Unit Tests");
    for (let i = 0; i < testPlan.unit_tests.length; i++) {
      const test = testPlan.unit_tests[i];
      lines.push(
        `${i + 1}. **${test.description}**`,
        `   **Target**: ${test.target}`
      );
      if (test.assertions.length > 0) {
        lines.push("   **Assertions**:");
        for (const assertion of test.assertions) {
          lines.push(`   - ${assertion}`);
        }
      }
      if (test.edge_cases.length > 0) {
        lines.push("   **Edge Cases**:");
        for (const edge of test.edge_cases) {
          lines.push(`   - ${edge}`);
        }
      }
    }
  }
  
  // Integration Tests
  if (testPlan.integration_tests.length > 0) {
    lines.push("", "### Integration Tests");
    for (let i = 0; i < testPlan.integration_tests.length; i++) {
      const test = testPlan.integration_tests[i];
      lines.push(
        `${i + 1}. **${test.description}**`,
        `   **Target**: ${test.target}`
      );
      if (test.assertions.length > 0) {
        lines.push("   **Assertions**:");
        for (const assertion of test.assertions) {
          lines.push(`   - ${assertion}`);
        }
      }
    }
  }
  
  // E2E Tests
  if (testPlan.e2e_tests.length > 0) {
    lines.push("", "### E2E Tests");
    for (let i = 0; i < testPlan.e2e_tests.length; i++) {
      const test = testPlan.e2e_tests[i];
      lines.push(
        `${i + 1}. **${test.description}**`,
        `   **Target**: ${test.target}`
      );
      if (test.assertions.length > 0) {
        lines.push("   **Assertions**:");
        for (const assertion of test.assertions) {
          lines.push(`   - ${assertion}`);
        }
      }
    }
  }
  
  // Test Data Requirements
  if (testPlan.test_data_requirements.length > 0) {
    lines.push("", "### Test Data Requirements");
    for (const req of testPlan.test_data_requirements) {
      lines.push(`- ${req}`);
    }
  }
  
  // Mocking Strategy
  if (testPlan.mocking_strategy) {
    lines.push("", "### Mocking Strategy");
    lines.push(testPlan.mocking_strategy);
  }
  
  return lines.join("\n");
}

/**
 * Save a plan to file
 */
export function savePlan(plan: PlanSchema, filename?: string): string {
  ensurePlansDirectory();
  
  const name = filename || generatePlanFilename(plan.task);
  const filepath = path.join(PLANS_DIR, name);
  
  const content = serializePlan(plan);
  fs.writeFileSync(filepath, content, "utf-8");
  
  return filepath;
}

/**
 * Load a plan from file
 */
export function loadPlan(filename: string): PlanSchema | null {
  const filepath = path.join(PLANS_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return null;
  }
  
  const content = fs.readFileSync(filepath, "utf-8");
  return parsePlan(content) as PlanSchema;
}

/**
 * List all saved plans
 */
export function listPlans(): Array<{ filename: string; task: string; status: string; created: string }> {
  ensurePlansDirectory();
  
  const files = fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith(".md"))
    .sort()
    .reverse();
  
  return files.map(filename => {
    const plan = loadPlan(filename);
    // Use task name or fall back to formatted filename
    let task = plan?.task || "";
    if (!task.trim()) {
      // Format filename as task name (remove timestamp prefix, replace underscores/hyphens with spaces)
      task = filename
        .replace(/^\d{8}T\d{6}_/, "") // Remove timestamp prefix
        .replace(/\.md$/, "")          // Remove extension
        .replace(/[_-]+/g, " ")        // Replace underscores/hyphens with spaces
        .replace(/\b\w/g, c => c.toUpperCase()); // Capitalize words
    }
    return {
      filename,
      task,
      status: plan?.status || "unknown",
      created: plan?.created || ""
    };
  });
}

/**
 * Update plan status in frontmatter only (preserves original file content)
 */
export function updatePlanStatus(filename: string, status: PlanStatus): void {
  const filepath = path.join(PLANS_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return;
  }
  
  const content = fs.readFileSync(filepath, "utf-8");
  
  // Check if file has YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatterMatch) {
    // Update status in existing frontmatter
    const frontmatter = frontmatterMatch[1];
    const updatedFrontmatter = frontmatter.replace(
      /^status:.*$/m,
      `status: ${status}`
    );
    
    // If status wasn't in frontmatter, add it
    const finalFrontmatter = updatedFrontmatter.includes(`status: ${status}`)
      ? updatedFrontmatter
      : `status: ${status}\n${updatedFrontmatter}`;
    
    const updatedContent = content.replace(frontmatterMatch[0], `---\n${finalFrontmatter}\n---\n`);
    fs.writeFileSync(filepath, updatedContent, "utf-8");
  } else {
    // No frontmatter - prepend one with status
    const newContent = `---\nstatus: ${status}\n---\n\n${content}`;
    fs.writeFileSync(filepath, newContent, "utf-8");
  }
}

/**
 * Update execution notes in plan file (appends to end of file, preserves all content)
 */
export function updatePlanExecutionNotes(filename: string, notes: string): void {
  const filepath = path.join(PLANS_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return;
  }
  
  const content = fs.readFileSync(filepath, "utf-8");
  
  // Check if there's already an execution notes section
  const notesHeader = "\n\n---\n\n## Execution Notes\n\n";
  const existingNotesMatch = content.match(/\n\n---\n\n## Execution Notes\n\n([\s\S]*?)(?=\n\n---\n\n|$)/);
  
  if (existingNotesMatch) {
    // Replace existing notes
    const updatedContent = content.replace(
      /\n\n---\n\n## Execution Notes\n\n[\s\S]*?(?=\n\n---\n\n|$)/,
      notes.trim() ? `${notesHeader}${notes.trim()}` : ""
    );
    fs.writeFileSync(filepath, updatedContent, "utf-8");
  } else if (notes.trim()) {
    // Append new notes section
    const updatedContent = content + `${notesHeader}${notes.trim()}`;
    fs.writeFileSync(filepath, updatedContent, "utf-8");
  }
}
