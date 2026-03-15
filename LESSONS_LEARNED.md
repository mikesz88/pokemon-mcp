# Lessons Learned — Pokemon MCP Sessions

---

## Phase 1: Local stdio Server

### SDK API: Use McpServer + registerTool, not Server + setRequestHandler

The low-level `Server` class and `setRequestHandler` pattern is deprecated. Use the high-level API:

```javascript
// ✅ DO THIS (McpServer high-level API)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const server = new McpServer({ name: "pokemon-mcp", version: "1.0.0" });
server.registerTool("get_pokemon", { description: "...", inputSchema: { identifier: z.string() } }, async ({ identifier }) => {
  return { content: [{ type: "text", text: result }] };
});

// ❌ NOT THIS (deprecated low-level API)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => { switch(req.params.name) {...} });
```

### stdout is sacred

The MCP JSON-RPC protocol pipe runs over stdout. Any `console.log()` in your server breaks the protocol. Use `console.error()` for all logs.

```javascript
console.error("Server running");  // ✅ goes to stderr — safe
console.log("Server running");    // ❌ corrupts the MCP pipe
```

### Tool descriptions drive routing — not code

Claude picks which tool to call by reading the `description` field. If your description is vague, Claude will pick the wrong tool or skip it entirely. Write descriptions like you're writing a Postman collection — tell the AI exactly when to use it.

### package.json must have "type": "module"

The server uses ES module `import` syntax. Without `"type": "module"` in package.json, Node throws a syntax error.

### @anthropic-ai/sdk is NOT needed in the MCP server

The MCP server only needs `@modelcontextprotocol/sdk`. The Anthropic SDK is only needed in the frontend/backend agent layer (Phase 3).

---

## Phase 2: Vercel Deployment

### SSEServerTransport is deprecated — use StreamableHTTPServerTransport

```javascript
// ❌ DEPRECATED
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// ✅ CURRENT
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export default async function handler(req, res) {
  const server = new McpServer({ name: "pokemon-mcp", version: "1.0.0" });
  // ... registerTool calls ...
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
```

### gh CLI was not installed — deploy via Vercel dashboard instead

`gh` CLI is not installed on this machine. For GitHub repo creation:
```bash
# Create repo at github.com/new manually, then:
git remote add origin https://github.com/mikesz88/pokemon-mcp.git
git push -u origin master
```

For Vercel deployment, use the dashboard (vercel.com → Add New Project → import from GitHub) when `npx vercel --prod` has token issues.

### Vercel root directory must be "./" not blank

In the Vercel dashboard project setup, the root directory field cannot be left blank — it requires a value. Use `./` to point to the repo root.

### Registering an HTTP MCP server with Claude Code

```bash
claude mcp add pokemon-vercel --transport http https://pokemon-mcp-beta.vercel.app/api/mcp
# Output: Added HTTP MCP server pokemon-vercel with URL: ... to local config
# File modified: C:\Users\mikes\.claude.json [project: c:\Users\mikes\Desktop\Claude]
```

After running, reload VSCode window for the new server to connect.

### Path casing matters for claude mcp add

The VSCode extension stores config in `~/.claude.json` under the project path key. If you run `claude mcp add` from a terminal that resolves the path differently (e.g., uppercase drive letter `C:` vs lowercase `c:`), it creates a duplicate entry under a different key and the server won't appear in VSCode.

Always run from the project root inside VSCode's integrated terminal, or verify the entry was added to the correct key with:
```bash
claude mcp list
```

### git restore doesn't bring back node_modules

When files are deleted and you restore them with `git checkout HEAD -- <files>`, `node_modules` is not restored (it's in `.gitignore` — never committed). Run `npm install` after restoring.

### Always commit .gitignore before git add .

Running `git add .` before `.gitignore` exists will stage `node_modules/` (thousands of files). Create `.gitignore` first, then `git add .`

```gitignore
node_modules/
.vercel/
.env
```

### Both servers can run side by side

`pokemon` (stdio) and `pokemon-vercel` (HTTP) are registered as separate named servers. Both show up in `claude mcp list` and both tool sets are available in the same Claude session. They're isolated by name prefix in tool calls (`mcp__pokemon__*` vs `mcp__pokemon-vercel__*`).

---

## General MCP Lessons

### Tool routing is purely description-based

Claude reads tool descriptions at session start and routes based on them. There is no code-level routing. Two tools with similar descriptions = ambiguity = unpredictable routing. Keep descriptions specific and non-overlapping.

### Reload VSCode to reconnect stdio servers

stdio servers are spawned as subprocesses when VSCode loads. If the server crashes or files change, the server won't auto-restart. Reload VSCode window (`Ctrl+Shift+P` → Developer: Reload Window) to force reconnect.

### MCP server vs MCP proxy — different things

- `workday-mcp-proxy/` — proxies to Workday's *native* MCP endpoint (not your tools)
- A custom Workday MCP tool server (Phase 4) — your own tools that call Workday's REST API

These are different architectures. Phase 4 will be the custom tool server pattern (like pokemon-mcp but for Workday), not a proxy.
