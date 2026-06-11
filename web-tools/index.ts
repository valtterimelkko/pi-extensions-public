/**
 * Web Tools Extension for Pi
 *
 * Native TypeScript implementation of web search and fetch tools.
 *
 * Tools:
 * - web_search: Search the web via Python ddgs (Bing backend with browser fingerprint spoofing)
 * - web_fetch: Fetch and convert web pages to markdown
 *
 * Note on web_search backend: DuckDuckGo HTML endpoint broke May 2026; Bing also blocks plain
 * fetch(). Both require TLS browser-fingerprint spoofing. The ddgs Python package (already
 * installed) handles this via primp/curl-impersonate. We shell out to it rather than reinvent
 * the spoofing layer in TypeScript. web_fetch is still native fetch (pages don't require it).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Simple truncation function
function truncateText(text: string, maxBytes: number = 50000, maxLines: number = 2000): string {
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n") + "\n\n... (truncated)";
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length > maxBytes) {
    return text.slice(0, Math.floor(maxBytes / 4)) + "\n\n... (truncated)";
  }
  return text;
}

// Cache implementation
interface CacheEntry {
  content: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.content;
  }
  cache.delete(key);
  return null;
}

function setCache(key: string, content: string): void {
  cache.set(key, { content, timestamp: Date.now() });
}

// URL validation
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (hostname === "localhost" || hostname.startsWith("127.") ||
        hostname.startsWith("10.") || hostname.startsWith("192.168.") ||
        hostname.startsWith("172.16.") || hostname.startsWith("169.254.")) {
      return false;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Python ddgs script — query and limit passed as argv[1]/argv[2] to avoid shell escaping issues
const DDGS_SCRIPT = `
import json, sys, warnings
warnings.filterwarnings('ignore')
query = sys.argv[1]
limit = int(sys.argv[2])
try:
    from ddgs import DDGS
except ImportError:
    from duckduckgo_search import DDGS
with DDGS() as d:
    results = list(d.text(query, max_results=limit))
    print(json.dumps(results))
`.trim();

interface DdgsResult {
  title?: string;
  href?: string;
  body?: string;
}

async function searchViaDdgs(query: string, limit: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const { stdout } = await execFileAsync("python3", ["-c", DDGS_SCRIPT, query, String(limit)], {
    timeout: 20000,
    encoding: "utf8",
  });
  const parsed: DdgsResult[] = JSON.parse(stdout.trim());
  return parsed.map((r) => ({
    title: r.title || "",
    url: r.href || "",
    snippet: r.body || "",
  }));
}

// HTML to Markdown conversion
function htmlToMarkdown(html: string): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n");
  text = text.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n\n");
  text = text.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n\n");

  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  text = text.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  text = text.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gi, "```\n$1\n```\n\n");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\n\s*\n\s*\n/g, "\n\n");

  return text.trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return match ? match[1].trim() : "Untitled";
}

export default function webToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    description: "Search the web to find current information, documentation, and sources. Returns search results with titles, URLs, and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results (1-20, default 10)", default: 10 })),
      region: Type.Optional(Type.String({ description: "Region code (e.g., 'us-en', 'wt-wt' for worldwide)", default: "wt-wt" })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number; region?: string }, _signal: AbortSignal, _onUpdate: unknown, _context: ExtensionContext) {
      const query = params.query || "";
      const limit = Math.min(params.limit ?? 10, 20);
      const cacheKey = `search:${query}:${limit}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return { content: [{ type: "text", text: cached }] };
      }

      try {
        const results = await searchViaDdgs(query, limit);

        const output = results.length > 0
          ? `Web search results for: "${query}"\n\n` +
            results.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`).join("\n\n")
          : `No results found for: "${query}"`;

        setCache(cacheKey, output);

        return {
          content: [{ type: "text", text: truncateText(output, 50000, 2000) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Search error: ${error instanceof Error ? error.message : String(error)}` }],
          error: true
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    description: "Fetch a web page and convert it to markdown. Returns the page content as clean markdown text.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      maxLength: Type.Optional(Type.Number({ description: "Maximum content length (default 50000)", default: 50000 })),
    }),
    async execute(_toolCallId: string, params: { url: string; maxLength?: number }, _signal: AbortSignal, _onUpdate: unknown, _context: ExtensionContext) {
      const url = params.url || "";
      const maxLength = params.maxLength ?? 50000;
      if (!isValidUrl(url)) {
        return {
          content: [{ type: "text", text: `Invalid or unsafe URL: ${url}` }],
          error: true
        };
      }

      const cacheKey = `fetch:${url}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return { content: [{ type: "text", text: truncateText(cached, maxLength, 2000) }] };
      }

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          },
          redirect: "follow",
        });

        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("text/html")) {
          const html = await response.text();
          const title = extractTitle(html);
          const markdown = htmlToMarkdown(html);
          const output = `---\ntitle: ${title}\nurl: ${url}\n---\n\n${markdown}`;
          setCache(cacheKey, output);
          return { content: [{ type: "text", text: truncateText(output, maxLength, 2000) }] };
        } else if (contentType.includes("text/plain")) {
          const text = await response.text();
          const output = `---\nurl: ${url}\ncontent-type: text/plain\n---\n\n${text}`;
          setCache(cacheKey, output);
          return { content: [{ type: "text", text: truncateText(output, maxLength, 2000) }] };
        } else {
          return {
            content: [{ type: "text", text: `---\nurl: ${url}\ncontent-type: ${contentType}\n---\n\nBinary or non-text content. Cannot display.` }]
          };
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          error: true
        };
      }
    },
  });

  pi.registerCommand("webtools-clear-cache", {
    description: "Clear web tools cache",
    handler: async (_args, context) => {
      cache.clear();
      context.ui.notify("Web tools cache cleared", "info");
    },
  });
}
