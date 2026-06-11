/**
 * Analysis Orchestrator Module
 * 
 * Implements wave-based analysis using Pi's official subagent extension.
 * 
 * Wave Pattern:
 * - Wave 1: Parallel initial scan (scout agents across different areas)
 * - Main agent synthesizes findings
 * - Wave 2: Targeted deep dives based on Wave 1 findings (if needed)
 * - Main agent synthesizes findings
 * - Wave 3: Dependency analysis (if needed)
 */

import type { 
  AnalysisTask, 
  AnalysisResult, 
  Finding,
  WaveConfig 
} from "./types.js";

/**
 * Generate wave configurations for codebase analysis
 */
export function generateAnalysisWaves(task: string, codebaseRoot: string = "."): WaveConfig[] {
  const waves: WaveConfig[] = [
    // Wave 1: Initial reconnaissance
    {
      wave_number: 1,
      description: "Initial codebase reconnaissance - identify key areas",
      parallel: true,
      tasks: [
        {
          agent: "scout",
          task: `Analyze the project structure and identify main entry points, configuration files, and overall architecture. Focus on understanding what this codebase does and its high-level organization.`,
          target: codebaseRoot
        },
        {
          agent: "scout", 
          task: `Find all code related to: ${task}. Search for relevant files, functions, and patterns. Report what exists that might need to be modified.`,
          target: codebaseRoot
        }
      ]
    },
    
    // Wave 2: Deep dive (tasks will be generated dynamically based on Wave 1 findings)
    {
      wave_number: 2,
      description: "Deep dive into identified areas",
      parallel: true,
      tasks: [] // To be populated dynamically
    },
    
    // Wave 3: Dependency and integration analysis
    {
      wave_number: 3,
      description: "Dependency mapping and integration analysis",
      parallel: true,
      tasks: [] // To be populated dynamically
    }
  ];
  
  return waves;
}

/**
 * Synthesize findings from a wave of analysis results
 * Determines what needs deeper investigation
 */
export function synthesizeWaveResults(results: AnalysisResult[], waveNumber: number): {
  findings: Finding[];
  needsDeeperAnalysis: boolean;
  nextWaveTasks: AnalysisTask[];
  summary: string;
} {
  const allFindings: Finding[] = [];
  let needsDeeperAnalysis = false;
  
  // Collect all findings from results
  for (const result of results) {
    if (result.findings) {
      allFindings.push(...result.findings);
    }
    if (result.needs_deeper_analysis) {
      needsDeeperAnalysis = true;
    }
  }
  
  // Generate summary
  const summary = generateWaveSummary(results, waveNumber);
  
  // Generate tasks for next wave (if needed)
  const nextWaveTasks = generateNextWaveTasks(allFindings, waveNumber);
  
  return {
    findings: allFindings,
    needsDeeperAnalysis: nextWaveTasks.length > 0,
    nextWaveTasks,
    summary
  };
}

function generateWaveSummary(results: AnalysisResult[], waveNumber: number): string {
  const sections: string[] = [];
  
  sections.push(`## Wave ${waveNumber} Analysis Summary\n`);
  
  // Files discovered
  const filesFound = new Set<string>();
  for (const result of results) {
    for (const finding of result.findings || []) {
      if (finding.type === "file" && finding.location) {
        filesFound.add(finding.location);
      }
    }
  }
  
  if (filesFound.size > 0) {
    sections.push(`**Files Analyzed**: ${filesFound.size} key files identified`);
    sections.push("Key files:");
    for (const file of Array.from(filesFound).slice(0, 10)) {
      sections.push(`  - ${file}`);
    }
    if (filesFound.size > 10) {
      sections.push(`  ... and ${filesFound.size - 10} more`);
    }
    sections.push("");
  }
  
  // Risks identified
  const risks = results.flatMap(r => r.findings || []).filter(f => f.type === "risk");
  if (risks.length > 0) {
    sections.push(`**Risks Identified**: ${risks.length} potential issues`);
    for (const risk of risks.slice(0, 5)) {
      sections.push(`  - ${risk.severity?.toUpperCase() || "INFO"}: ${risk.description}`);
    }
    sections.push("");
  }
  
  // Dependencies
  const deps = results.flatMap(r => r.findings || []).filter(f => f.type === "dependency");
  if (deps.length > 0) {
    sections.push(`**Dependencies**: ${deps.length} external/internal dependencies found`);
    sections.push("");
  }
  
  // Recommendations
  const recommendations = results.flatMap(r => r.recommendations || []);
  if (recommendations.length > 0) {
    sections.push("**Recommendations**:");
    for (const rec of recommendations.slice(0, 5)) {
      sections.push(`  - ${rec}`);
    }
    sections.push("");
  }
  
  return sections.join("\n");
}

function generateNextWaveTasks(findings: Finding[], currentWave: number): AnalysisTask[] {
  const tasks: AnalysisTask[] = [];
  
  // Identify areas needing deeper analysis
  const criticalFindings = findings.filter(f => f.severity === "critical");
  const complexAreas = findings.filter(f => 
    f.type === "file" && 
    (f.description.includes("complex") || f.description.includes("architectural"))
  );
  
  if (currentWave === 1) {
    // Wave 2: Deep dive into critical and complex areas
    for (const finding of criticalFindings.slice(0, 3)) {
      tasks.push({
        agent: "planner",
        task: `Deep dive analysis of critical area: ${finding.description}. Examine implementation details, identify risks, and propose mitigation strategies.`,
        target: finding.location
      });
    }
    
    for (const area of complexAreas.slice(0, 2)) {
      tasks.push({
        agent: "scout",
        task: `Thorough analysis of complex area: ${area.description}. Trace all dependencies and map integration points.`,
        target: area.location
      });
    }
  } else if (currentWave === 2) {
    // Wave 3: Dependency and integration analysis
    const dependencies = findings.filter(f => f.type === "dependency");
    for (const dep of dependencies.slice(0, 3)) {
      tasks.push({
        agent: "scout",
        task: `Trace dependency: ${dep.description}. Identify all usage points and assess impact of changes.`,
        target: dep.location
      });
    }
  }
  
  return tasks;
}

/**
 * Create the subagent tool call specification for a wave
 */
export function createSubagentCall(wave: WaveConfig): {
  tool: "subagent";
  params: Record<string, unknown>;
} {
  if (wave.tasks.length === 0) {
    throw new Error(`Wave ${wave.wave_number} has no tasks`);
  }
  
  if (wave.parallel && wave.tasks.length > 1) {
    // Parallel execution
    return {
      tool: "subagent",
      params: {
        tasks: wave.tasks.map(t => ({
          agent: t.agent,
          task: t.target ? `${t.task}\n\nTarget: ${t.target}` : t.task
        }))
      }
    };
  } else if (wave.tasks.length === 1) {
    // Single task
    return {
      tool: "subagent",
      params: {
        agent: wave.tasks[0].agent,
        task: wave.tasks[0].target 
          ? `${wave.tasks[0].task}\n\nTarget: ${wave.tasks[0].target}` 
          : wave.tasks[0].task
      }
    };
  } else {
    // Sequential chain
    return {
      tool: "subagent",
      params: {
        chain: wave.tasks.map(t => ({
          agent: t.agent,
          task: t.target ? `${t.task}\n\nTarget: ${t.target}` : t.task
        }))
      }
    };
  }
}

/**
 * Parse subagent results into AnalysisResult format
 */
export function parseSubagentResults(subagentOutput: unknown): AnalysisResult[] {
  const results: AnalysisResult[] = [];
  
  if (!subagentOutput || typeof subagentOutput !== "object") {
    return results;
  }
  
  const output = subagentOutput as Record<string, unknown>;
  
  // Handle parallel results
  if (Array.isArray(output.results)) {
    for (const result of output.results) {
      results.push(parseSingleResult(result));
    }
  } 
  // Handle single/chain result
  else if (output.agent || output.chain) {
    results.push(parseSingleResult(output));
  }
  
  return results;
}

function parseSingleResult(result: unknown): AnalysisResult {
  const r = result as Record<string, unknown>;
  
  return {
    agent: String(r.agent || "unknown"),
    task: String(r.task || ""),
    findings: extractFindingsFromText(String(r.output || r.result || "")),
    recommendations: extractRecommendations(String(r.output || r.result || ""))
  };
}

function extractFindingsFromText(text: string): Finding[] {
  const findings: Finding[] = [];
  
  // Look for file references
  const fileMatches = text.matchAll(/`([^`]+\.(?:ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|md|json|yml|yaml))`/g);
  for (const match of fileMatches) {
    findings.push({
      type: "file",
      location: match[1],
      description: `File identified in analysis`
    });
  }
  
  // Look for risk mentions
  const riskPatterns = [
    { pattern: /risk|danger|warning|caution/i, severity: "warning" as const },
    { pattern: /critical|severe|breaking|destructive/i, severity: "critical" as const }
  ];
  
  for (const { pattern, severity } of riskPatterns) {
    if (pattern.test(text)) {
      // Extract the sentence containing the risk
      const sentences = text.split(/[.!?]+/);
      for (const sentence of sentences) {
        if (pattern.test(sentence) && sentence.length > 10) {
          findings.push({
            type: "risk",
            description: sentence.trim(),
            severity
          });
        }
      }
    }
  }
  
  // Look for dependency mentions
  const depMatches = text.matchAll(/depend(?:s|encies|ency|ent)|import|require|use\s+of/i);
  for (const match of depMatches) {
    const sentence = text.slice(Math.max(0, match.index! - 50), match.index! + 100);
    findings.push({
      type: "dependency",
      description: sentence.trim()
    });
  }
  
  return findings;
}

function extractRecommendations(text: string): string[] {
  const recommendations: string[] = [];
  
  // Look for recommendation patterns
  const recPatterns = [
    /recommend(?:ation)?[:\s]+([^\n]+)/gi,
    /should\s+([^\n]+)/gi,
    /consider\s+([^\n]+)/gi,
    /suggest(?:ion)?[:\s]+([^\n]+)/gi
  ];
  
  for (const pattern of recPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const rec = match[1].trim();
      if (rec.length > 10 && rec.length < 200) {
        recommendations.push(rec);
      }
    }
  }
  
  return [...new Set(recommendations)]; // Deduplicate
}

/**
 * Generate instructions for the planning agent to use subagent tool
 */
export function generateSubagentInstructions(task: string): string {
  return `
You are in PLANNING MODE with wave-based analysis enabled.

Your task: ${task}

Use the subagent tool to perform parallel analysis of the codebase:

## Wave 1: Initial Reconnaissance
Use the subagent tool with parallel tasks:
- Task 1: Scout the overall project structure
- Task 2: Scout for code related to: ${task}
- Task 3: Scout for existing test patterns and test infrastructure

Example:
<function_calls>
<invoke name="subagent">
<parameter name="tasks">
[
  { "agent": "scout", "task": "Analyze project structure and identify main entry points" },
  { "agent": "scout", "task": "Find all code related to: ${task}" },
  { "agent": "scout", "task": "Analyze existing test structure, patterns, and testing frameworks used" }
]
</parameter>
</invoke>
</function_calls>

## Wave 2: Deep Dives (if needed)
Based on Wave 1 findings, identify areas needing deeper analysis and spawn targeted scouts or planners.

## Wave 3: Integration Analysis
Trace dependencies and map integration points for the identified changes.

## TEST PLANNING REQUIREMENT ⚠️

A complete plan MUST include a comprehensive Test Plan section with:

### 1. Unit Tests
For each new function, class, or module:
- Test normal/happy path operation
- Test error conditions and exceptions
- Test edge cases (null, empty, boundary values, extremes)
- Test invalid inputs

### 2. Integration Tests
For component interactions:
- Test API endpoints with real dependencies
- Test database interactions
- Test service-to-service communication
- Test data flow between components

### 3. E2E Tests (if applicable)
For critical user paths:
- Test complete user workflows from start to finish
- Test from user input to expected output
- Test error handling in user workflows

### 4. Test Data Requirements
- What test data needs to be created?
- Are there data dependencies or fixtures needed?
- Do tests need to be isolated or can they share data?

### 5. Mocking Strategy
- What external dependencies should be mocked?
- How should they be mocked (stubs, spies, mocks)?
- What should NOT be mocked?

### Coverage Target
Aim for >80% code coverage unless there's a specific documented reason not to.

After each wave, synthesize the findings and determine if another wave is needed.
`;
}
