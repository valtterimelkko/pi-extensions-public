# Web Tools Extension for Pi

Native TypeScript implementation of web search and fetch tools for the Pi coding agent. Provides fast, native HTTP operations without Python subprocess overhead.

## Features

- **Native Performance**: Uses native `fetch()` API - ~10x faster than Python subprocess
- **No Dependencies**: No Python packages required (ddgs, trafilatura)
- **Smart Caching**: 15-minute cache for repeated queries
- **Security**: Blocks private IP ranges and validates URLs
- **HTML to Markdown**: Converts web pages to clean markdown

## Tools

### web_search

Search the web using DuckDuckGo.

```typescript
web_search({
  query: "TypeScript best practices 2024",
  limit: 10,           // Optional: 1-20 results (default: 10)
  region: "wt-wt"      // Optional: region code (default: worldwide)
})
```

**Returns**: Search results with titles, URLs, and snippets.

### web_fetch

Fetch a web page and convert to markdown.

```typescript
web_fetch({
  url: "https://example.com/article",
  maxLength: 50000     // Optional: max content length (default: 50000)
})
```

**Returns**: Page content as markdown with frontmatter (title, url).

## Installation

```bash
# Copy to Pi extensions
mkdir -p ~/.pi/agent/extensions/web-tools
cp *.ts ~/.pi/agent/extensions/web-tools/
pi /reload
```

## Commands

- `/webtools-clear-cache` - Clear the web tools cache

## Comparison with Python Skills

| Feature | Web Tools Extension | Python Skills |
|---------|---------------------|---------------|
| **Speed** | ~50-200ms | ~500ms-2s |
| **Overhead** | None (native) | Python startup |
| **Dependencies** | None | ddgs, trafilatura |
| **Caching** | Built-in (15 min) | Manual |
| **HTML→Markdown** | Built-in | trafilatura |

## Architecture

```
┌─────────────────────────────────────┐
│           Pi Agent                  │
└─────────────┬───────────────────────┘
              │
┌─────────────▼───────────────────────┐
│      Web Tools Extension            │
│  ┌─────────────┐  ┌─────────────┐  │
│  │ web_search  │  │  web_fetch  │  │
│  │  (fetch)    │  │   (fetch)   │  │
│  └──────┬──────┘  └──────┬──────┘  │
│         │                │          │
│  ┌──────▼────────────────▼──────┐  │
│  │     HTML to Markdown         │  │
│  │     (built-in)               │  │
│  └─────────────────────────────┘  │
└─────────────────────────────────────┘
              │
┌─────────────▼───────────────────────┐
│      DuckDuckGo / Web Pages         │
└─────────────────────────────────────┘
```

## Security

- URL validation blocks private IPs (localhost, 10.x, 192.168.x, etc.)
- Content truncation (50KB limit)
- Script and style tag removal from HTML
- HTTPS enforcement for sensitive operations

## Cache

- **Duration**: 15 minutes
- **Scope**: Per-session (in-memory)
- **Clear**: Use `/webtools-clear-cache` command

## Best Practices

1. Use `web_search` to find relevant pages
2. Use `web_fetch` on the most promising 2-3 results
3. Cache is automatic - no need to manage it
4. For parallel research, call multiple tools concurrently
