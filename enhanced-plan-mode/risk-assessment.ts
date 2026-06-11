/**
 * Risk Assessment Module
 * 
 * Implements the 5-dimension risk matrix from kimi-planning
 */

import type { RiskAssessment, RiskLevel, EffortLevel, PlanSchema } from "./types.js";

/**
 * Calculate overall risk level from assessment dimensions
 */
export function calculateRiskLevel(assessment: RiskAssessment): RiskLevel {
  // Default to low risk if assessment is missing
  if (!assessment) {
    return "low";
  }
  
  let score = 0;
  
  // Files modified (0-3 points)
  const filesModified = assessment.files_modified || 0;
  if (filesModified <= 2) score += 0;
  else if (filesModified <= 5) score += 1;
  else if (filesModified <= 10) score += 2;
  else score += 3;
  
  // Code complexity (0-3 points) - default to simple if undefined
  const complexityScores = { simple: 0, moderate: 1, complex: 2, architectural: 3 };
  const codeComplexity = assessment.code_complexity || "simple";
  score += complexityScores[codeComplexity] ?? 0;
  
  // Test coverage (0-3 points) - default to partial if undefined
  const coverageScores = { full: 0, partial: 1, minimal: 2, none: 3 };
  const testCoverage = assessment.test_coverage || "partial";
  score += coverageScores[testCoverage] ?? 1;
  
  // Dependencies (0-3 points) - default to none if undefined
  const dependencyScores = { none: 0, few: 1, many: 2, circular: 3 };
  const dependencies = assessment.dependencies || "none";
  score += dependencyScores[dependencies] ?? 0;
  
  // Blast radius (0-3 points) - default to isolated if undefined
  const blastScores = { isolated: 0, component: 1, system_wide: 2, core_infrastructure: 3 };
  const blastRadius = assessment.blast_radius || "isolated";
  score += blastScores[blastRadius] ?? 0;
  
  // Data impact (0-3 points) - default to cached if undefined
  const dataScores = { none: 0, cached: 1, persistent: 2, user_critical: 3 };
  const dataImpact = assessment.data_impact || "cached";
  score += dataScores[dataImpact] ?? 1;
  
  // Map score to risk level (0-18 scale)
  if (score <= 3) return "low";
  if (score <= 7) return "medium";
  if (score <= 12) return "high";
  return "critical";
}

/**
 * Calculate effort level from assessment
 */
export function calculateEffortLevel(assessment: RiskAssessment): EffortLevel {
  // Default to small effort if assessment is missing
  if (!assessment) {
    return "small";
  }
  
  const fileCount = assessment.files_modified || 0;
  const complexity = assessment.code_complexity || "simple";
  
  if (fileCount <= 2 && complexity === "simple") return "small";
  if (fileCount <= 5 && complexity !== "architectural") return "medium";
  if (fileCount <= 10 || complexity === "complex") return "large";
  return "epic";
}

/**
 * Auto-assess risk from plan content
 */
export function autoAssessRisk(plan: PlanSchema): RiskAssessment {
  // Ensure plan has analysis section with defaults
  const analysis = plan.analysis || {
    files_to_read: [],
    files_to_modify: [],
    dependencies: [],
    risks: []
  };
  
  const filesModified = analysis.files_to_modify?.length || 0;
  
  // Infer complexity from step descriptions
  let codeComplexity: RiskAssessment["code_complexity"] = "simple";
  const allText = JSON.stringify(plan).toLowerCase();
  
  if (allText.includes("architectural") || allText.includes("refactor")) {
    codeComplexity = "architectural";
  } else if (allText.includes("complex") || allText.includes("complicated")) {
    codeComplexity = "complex";
  } else if (allText.includes("moderate")) {
    codeComplexity = "moderate";
  }
  
  // Infer dependencies
  let dependencies: RiskAssessment["dependencies"] = "none";
  const depCount = analysis.dependencies?.length || 0;
  if (depCount > 10) dependencies = "many";
  else if (depCount > 3) dependencies = "few";
  
  // Infer blast radius from files modified
  let blast_radius: RiskAssessment["blast_radius"] = "isolated";
  if (filesModified > 10) blast_radius = "core_infrastructure";
  else if (filesModified > 6) blast_radius = "system_wide";
  else if (filesModified > 3) blast_radius = "component";
  
  // Default values for things we can't infer
  return {
    files_modified: filesModified,
    code_complexity: codeComplexity,
    test_coverage: "partial", // Default assumption
    dependencies: dependencies,
    blast_radius: blast_radius,
    data_impact: "cached" // Default assumption
  };
}

/**
 * Generate risk matrix markdown table
 */
export function generateRiskMatrix(): string {
  return `
| Factor | Low Risk | Medium Risk | High Risk | Critical |
|--------|----------|-------------|-----------|----------|
| Files Modified | 1-2 | 3-5 | 6-10 | 10+ |
| Code Complexity | Simple | Moderate | Complex | Architectural |
| Test Coverage | Full | Partial | Minimal | None |
| Dependencies | None | Few | Many | Circular |
| Blast Radius | Isolated | Component | System-wide | Core Infrastructure |
| Data Impact | None | Cached | Persistent | User/Critical |
`;
}

/**
 * Format risk level with emoji indicator
 */
export function formatRiskLevel(level: RiskLevel): string {
  const indicators = {
    low: "🟢 Low",
    medium: "🟡 Medium", 
    high: "🟠 High",
    critical: "🔴 Critical"
  };
  return indicators[level];
}

/**
 * Format effort level with indicator
 */
export function formatEffortLevel(level: EffortLevel): string {
  const indicators = {
    small: "🟢 Small",
    medium: "🟡 Medium",
    large: "🟠 Large",
    epic: "🔴 Epic"
  };
  return indicators[level];
}

/**
 * Generate risk mitigation recommendations
 */
export function generateMitigationRecommendations(assessment: RiskAssessment): string[] {
  const recommendations: string[] = [];
  
  if (assessment.files_modified > 5) {
    recommendations.push("Consider breaking into smaller PRs");
    recommendations.push("Implement changes incrementally");
  }
  
  if (assessment.code_complexity === "architectural") {
    recommendations.push("Create architecture decision record (ADR)");
    recommendations.push("Schedule architecture review");
  }
  
  if (assessment.test_coverage === "minimal" || assessment.test_coverage === "none") {
    recommendations.push("Add tests before modifying code");
    recommendations.push("Consider characterization tests for existing behavior");
  }
  
  if (assessment.blast_radius === "system_wide" || assessment.blast_radius === "core_infrastructure") {
    recommendations.push("Notify team before deployment");
    recommendations.push("Plan for rollback strategy");
    recommendations.push("Test in staging environment");
  }
  
  if (assessment.data_impact === "user_critical") {
    recommendations.push("Backup user data before migration");
    recommendations.push("Plan data migration with zero downtime");
  }
  
  return recommendations;
}

/**
 * Create a risk item for the plan
 */
export function createRiskItem(
  description: string,
  likelihood: "low" | "medium" | "high",
  impact: "low" | "medium" | "high",
  mitigation: string
) {
  return { description, likelihood, impact, mitigation };
}
