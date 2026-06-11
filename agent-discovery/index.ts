/**
 * Agent Discovery Extension
 * 
 * Automatically injects available subagent names into the system prompt
 * so the LLM knows what agents are available BEFORE making tool calls.
 * 
 * This prevents the "guessing agent names" problem where the LLM tries
 * to call agents that don't exist (e.g., calling "web-search" instead of
 * the correct agent name).
 * 
 * Features:
 * - Discovers agents from ~/.pi/agent/agents/ and .pi/agents/ on every turn
 * - Injects agent list into system prompt via before_agent_start hook
 * - Validates subagent calls via tool_call hook with helpful error messages
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

// Re-implement agent discovery locally (can't import from other extensions)
interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

function parseFrontmatter<T extends Record<string, string>>(content: string): { frontmatter: T; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: {} as T, body: content };
  }
  
  const frontmatterLines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  
  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }
  
  return { frontmatter: frontmatter as T, body: match[2] };
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  
  if (!fs.existsSync(dir)) {
    return agents;
  }
  
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    
    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }
    
    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  
  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function discoverAgents(cwd: string): { agents: AgentConfig[]; projectAgentsDir: string | null } {
  // User agents from ~/.pi/agent/agents/
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/root";
  const userDir = path.join(homeDir, ".pi", "agent", "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  
  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];
  
  // Project agents override user agents with same name
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);
  
  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) {
    return "No subagents configured. Add .md files to ~/.pi/agent/agents/";
  }
  
  const lines = agents.map(a => {
    let line = `- **${a.name}**: ${a.description}`;
    if (a.source === "project") {
      line += " _(project)_";
    }
    return line;
  });
  
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Inject available agents into system prompt on every turn
  pi.on("before_agent_start", async (event, ctx) => {
    const discovery = discoverAgents(ctx.cwd);
    const agentList = formatAgentList(discovery.agents);
    
    const agentsSection = `

## Available Subagents

The following agents are available for the \`subagent\` tool:

${agentList}

Usage: \`subagent({ agent: "agent-name", task: "..." })\`
`;
    
    return {
      systemPrompt: event.systemPrompt + agentsSection,
    };
  });
  
  // Validate subagent calls with helpful error messages
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    
    const discovery = discoverAgents(ctx.cwd);
    const availableNames = discovery.agents.map(a => a.name);
    
    // Extract requested agent name(s) from params
    const params = event.input as Record<string, unknown>;
    const requestedAgents: string[] = [];
    
    if (params.agent && typeof params.agent === "string") {
      requestedAgents.push(params.agent);
    }
    if (params.tasks && Array.isArray(params.tasks)) {
      for (const task of params.tasks) {
        if (task && typeof task === "object" && "agent" in task && typeof task.agent === "string") {
          requestedAgents.push(task.agent);
        }
      }
    }
    if (params.chain && Array.isArray(params.chain)) {
      for (const step of params.chain) {
        if (step && typeof step === "object" && "agent" in step && typeof step.agent === "string") {
          requestedAgents.push(step.agent);
        }
      }
    }
    
    // Check for unknown agents
    const unknownAgents = requestedAgents.filter(name => !availableNames.includes(name));
    
    if (unknownAgents.length > 0) {
      const unknown = unknownAgents.map(n => `"${n}"`).join(", ");
      const available = availableNames.map(n => `"${n}"`).join(", ");
      
      // Check if user might have meant a skill instead
      const skillNames = ["web-search", "scraping-reddit", "scraping-twitter", "github-trending", 
                          "github-search-repos", "github-repo-info", "github-fetch-issue", 
                          "deep-research", "gpt-research", "web-crawling"];
      const maybeSkills = unknownAgents.filter(name => skillNames.includes(name));
      
      let hint = "";
      if (maybeSkills.length > 0) {
        hint = `\n\nNote: ${maybeSkills.map(s => `"${s}"`).join(", ")} appear to be skills, not agents. Use the corresponding tool directly (e.g., \`web_search\` tool) or use the \`web-researcher\` or \`scout\` agent to leverage these skills.`;
      }
      
      return {
        block: true,
        reason: `Unknown agent(s): ${unknown}. Available agents: ${available}.${hint}`,
      };
    }
    
    // All agents valid, proceed with execution
    return {};
  });
}
