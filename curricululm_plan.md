# MCP Learning Guide — From Zero to Workday
*A reference guide tailored to your MERN/Postgres + Workday background*

---

## Context

You are a developer with MERN/Postgres stack experience and deep Workday domain expertise who wants to understand MCP (Model Context Protocol) from the ground up — not just run example code, but truly understand it. You already have `workday-mcp-proxy` set up locally. This guide is both the implementation plan and a permanent reference document.

**Goal (phased):**
1. Understand MCP conceptually
2. Run Pokemon MCP server locally
3. Deploy to Vercel
4. Build a frontend chat UI that calls Claude as an AI agent (the "agentic" layer)
5. Build a Workday MCP with real tenant interactions
6. Build an Extend PMD screen builder (TBD when ready)

---

## Part 1: What is MCP? (The Mental Model)

### The One-Sentence Definition

> **MCP is a standard protocol for AI models to call external functions — the same idea as an Express route, but instead of a browser calling it, an AI model calls it.**

### Why Does MCP Exist?

Before MCP, every AI app invented its own tool-calling format. Messy. MCP standardizes it so any MCP-compatible AI (Claude, GPT, Gemini) can talk to any MCP server using the same JSON-RPC protocol.

### Your MERN Brain → MCP Concepts

| What you know (MERN/Postgres) | MCP Equivalent | Notes |
|---|---|---|
| Express app | MCP **Server** | Registers handlers, runs, listens |
| `app.post('/api/pokemon/:id')` | MCP **Tool** | A named unit of work |
| Route handler function | Tool **handler** | The `async function` that does the work |
| Request body / params schema | Tool `inputSchema` (JSON Schema) | What args are expected |
| `res.json({ data })` | Tool **result** (`content[].text`) | What gets returned |
| Server URL (`localhost:3000`) | MCP server URL | Where the server lives |
| `.env` file | Server credentials / env vars | Auth config, not exposed to Claude |
| API consumer (React frontend, Postman) | AI host (Claude) | The thing that calls your routes |
| Middleware (auth, validation) | Tool description + inputSchema | Controls what can be called and how |

**The key difference:** In MERN, a browser calls your Express routes. In MCP, an AI model calls them. The route/tool itself is almost identical — just a function that receives inputs and returns outputs.

---

## Part 2: How MCP Works — The Full Flow

### The 4 Actors

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   YOU (the user)                                                │
│   "Compare Charizard vs Blastoise"                              │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  (chat message)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   CLAUDE (the AI host)                                          │
│   • At startup: reads all available tool definitions            │
│   • On each message: decides WHICH tool to call                 │
│   • Sends tool call → reads result → responds in natural lang   │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  MCP protocol (JSON-RPC 2.0 over stdio or HTTP)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   YOUR MCP SERVER (what you build — like an Express app)        │
│   • Advertises tool definitions (GET /tools equivalent)         │
│   • Handles tool calls (POST /tools/call equivalent)            │
│   • Calls the real API and returns results                      │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  HTTP / fetch()  (normal REST call)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   EXTERNAL API (PokéAPI, Workday, your Postgres DB, anything)   │
│   • Has zero knowledge of MCP                                   │
│   • Just responds to regular HTTP requests                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### The Exact Message Sequence

When you ask "Compare Charizard vs Blastoise":

```
1. STARTUP — Claude connects to MCP server, discovers tools
   Claude  →  server: { method: "tools/list" }
   server  →  Claude: { tools: [ get_pokemon, compare_pokemon, ... ] }

2. REASONING — Claude reads your message + tool descriptions
   Thinks: "User wants comparison → compare_pokemon is the right tool"
   Thinks: "It needs pokemon_a and pokemon_b — I can extract those from the message"

3. TOOL CALL — Claude sends the structured call
   Claude  →  server: {
     method: "tools/call",
     params: {
       name: "compare_pokemon",
       arguments: { pokemon_a: "charizard", pokemon_b: "blastoise" }
     }
   }

4. EXECUTION — Your handler runs (like an Express route handler)
   server: await fetch("https://pokeapi.co/api/v2/pokemon/charizard")
   server: await fetch("https://pokeapi.co/api/v2/pokemon/blastoise")
   server: formats comparison text

5. RESULT — Server returns to Claude
   server  →  Claude: {
     content: [{ type: "text", text: "CHARIZARD vs BLASTOISE\nTotal: 534 vs 530\nWinner: CHARIZARD" }]
   }

6. RESPONSE — Claude turns raw result into a natural language reply
   "Charizard wins overall with 534 total base stats vs Blastoise's 530..."
```

**Key insight:** Claude never calls PokéAPI directly. It calls YOUR server, your server calls the API. You own the middleman — which means you control what Claude can do, how it authenticates, what it can access.

---

## Part 3: The Anatomy of One MCP Tool

Core building block. Think of it exactly like an Express route definition + handler.

```javascript
// High-level API (McpServer + registerTool) — what we actually use:
server.registerTool(
  "compare_pokemon",
  {
    description:
      "Compare the base stats of two Pokémon side by side. " +
      "Returns a comparison showing which wins each stat category. " +
      "Use this when the user wants to compare two Pokémon or asks which is stronger.",
    //  ↑ MOST IMPORTANT FIELD. Claude decides WHEN to use this tool
    //    purely from reading this description.
    inputSchema: {
      pokemon_a: z.string().describe("Name or ID of the first Pokémon"),
      pokemon_b: z.string().describe("Name or ID of the second Pokémon"),
    },
  },
  async ({ pokemon_a, pokemon_b }) => {
    try {
      return { content: [{ type: "text", text: await comparePokemon(pokemon_a, pokemon_b) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);
```

**The golden rule:** Spend more time on the `description` than on the code. Claude picks tools based solely on reading it.

---

## Part 4: The Two Transports — How Claude Connects

### What is a "transport"?

A transport is the communication channel between Claude and your MCP server. There are two options:

```
OPTION 1: stdio (Standard Input/Output)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What it is: Claude Desktop launches your Node.js script as a subprocess
and communicates by writing to stdin / reading from stdout — the same
way bash pipes work: cat file.txt | grep "word"

When to use: Local development. Your laptop only. No hosting required.

Register with Claude Code:
  claude mcp add pokemon --command node --args /path/to/server.js
  (or edit ~/.claude.json directly)

OPTION 2: HTTP (Streamable HTTP transport)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What it is: Your server runs at a URL (like any Express app). Claude
connects to it over HTTP using StreamableHTTPServerTransport.

NOTE: SSEServerTransport is DEPRECATED as of SDK ^1.10.0.
      Use StreamableHTTPServerTransport instead.

When to use: Cloud deployment. Vercel. Accessible to anyone.

Register with Claude Code:
  claude mcp add pokemon-vercel --transport http https://your-app.vercel.app/api/mcp
```

**Rule of thumb:**
- `stdio` = dev/local only, simpler, no deployment
- `HTTP` = production, hosted, shareable URL

### Claude Code MCP Registration (VSCode Extension)

The VSCode extension stores MCP config in `~/.claude.json` under the project path key.

**To add a new MCP server:**
```bash
# stdio server:
claude mcp add <name> --command node --args /path/to/server.js

# HTTP server:
claude mcp add <name> --transport http https://your-url/api/mcp
```

**CRITICAL:** Always run `claude mcp add` from a terminal opened in the same project path that VSCode uses (lowercase drive letter, forward slashes). Path casing mismatch = duplicate entry = server won't load. Verify with `claude mcp list` after adding.

---

## Part 5: Your Existing Code — Explained

### File Structure

```
pokemon-mcp/
├── src/
│   └── server.js      ← stdio transport (local, Claude Code VSCode extension)
├── api/
│   └── mcp.js         ← HTTP transport (Vercel serverless function, cloud)
├── package.json       ← "type": "module" (ES modules, required for import syntax)
├── vercel.json        ← sets maxDuration: 30 for the serverless function
└── .gitignore         ← node_modules excluded
```

### server.js — The "Express App" Equivalent

Uses `McpServer` (high-level API) + `registerTool`:

```
Structure of server.js:
─────────────────────────────────────────────────────
1. import McpServer, StdioServerTransport, z
2. Define handler functions (getPokemon, getPokemonByType, comparePokemon)
3. const server = new McpServer({ name, version })
4. server.registerTool(name, { description, inputSchema }, handler) × 3
5. const transport = new StdioServerTransport()
6. await server.connect(transport)
7. console.error("...running on stdio")   ← stderr, not stdout!
─────────────────────────────────────────────────────
```

**Key:** `stdout` is reserved for the MCP JSON-RPC pipe. All logs go to `stderr`.

### api/mcp.js — The Vercel Version

Same tools and handlers. Different transport:

```javascript
// Uses StreamableHTTPServerTransport (not SSEServerTransport — that's deprecated)
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export default async function handler(req, res) {
  const server = new McpServer({ name: "pokemon-mcp", version: "1.0.0" });
  // ... same registerTool calls ...
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
```

The tool logic is 100% the same. Only how Claude connects changes.

---

## Part 6: Step-by-Step — Run Locally with Claude Code

### Step 1: Set up the project

```bash
cd C:/Users/mikes/Desktop/Claude
mkdir pokemon-mcp && cd pokemon-mcp
npm init -y
# Edit package.json: add "type": "module"
npm install @modelcontextprotocol/sdk
mkdir src api
```

> Note: `@anthropic-ai/sdk` is NOT needed in the MCP server — only in a frontend/backend (Phase 3)

### Step 2: Create `src/server.js`

All 3 tools: `get_pokemon`, `get_pokemon_by_type`, `compare_pokemon`

### Step 3: Test it starts

```bash
node src/server.js
# Output to stderr: "Pokemon MCP server running on stdio"
# Ctrl+C to stop
```

### Step 4: Register with Claude Code (VSCode extension)

```bash
claude mcp add pokemon --command "C:/Program Files/nodejs/node.exe" --args "C:/Users/mikes/Desktop/Claude/pokemon-mcp/src/server.js"
```

Reload VSCode window after registering. Verify with `claude mcp list`.

### Step 5: Checkpoint Prompts

```
"Who is Pikachu?"           → get_pokemon
"List fire type Pokémon"    → get_pokemon_by_type
"Compare Charizard and Blastoise" → compare_pokemon
```

---

## Part 7: Deploy to Vercel (Cloud Transport) ✓ COMPLETE

### What was built

- `api/mcp.js` — Vercel serverless handler with `StreamableHTTPServerTransport`
- `vercel.json` — sets `maxDuration: 30`
- Deployed at: **https://pokemon-mcp-beta.vercel.app**
- GitHub repo: **https://github.com/mikesz88/pokemon-mcp**

### How it was deployed (actual steps used)

```bash
# 1. Init git + add .gitignore (node_modules excluded)
git init
# create .gitignore with: node_modules/, .vercel/, .env
git add .
git commit -m "Pokemon MCP - stdio + Vercel Streamable HTTP transport"

# 2. Create GitHub repo manually at github.com/new (gh CLI not installed)
git remote add origin https://github.com/mikesz88/pokemon-mcp.git
git push -u origin master

# 3. Deploy via Vercel dashboard (vercel login token issue with npx vercel --prod)
#    → vercel.com → Add New Project → import from GitHub
#    → Root Directory: set to "./" (cannot leave blank in Vercel UI)
#    → Deploy with all defaults
```

### Register the Vercel server with Claude Code

```bash
claude mcp add pokemon-vercel --transport http https://pokemon-mcp-beta.vercel.app/api/mcp
```

Then reload VSCode. Verify both servers show connected:
```bash
claude mcp list
```

---

## Part 8: Build a Frontend Chat UI with Claude as Agent

This is the step between "deploy to Vercel" and "connect to Workday" — building a real product that wraps Claude + your MCP tools.

### The Architecture

```
React Frontend (chat UI)
        │
        │ POST /api/chat  { message: "Compare Charizard and Blastoise" }
        ▼
Express Backend (your Node server)
        │
        │ Calls Anthropic SDK with:
        │   - your message
        │   - MCP tool definitions (TOOLS array)
        ▼
Claude API (claude-sonnet-4-6)
        │  ← Claude decides to call compare_pokemon
        ▼
Your MCP tool handler (runs inside your backend)
        │
        ▼
PokéAPI / Workday (the real data source)
        │
        ▼  result flows back up the chain
React Frontend receives: "Charizard wins with 534 total stats..."
```

### What "AI Agent" Means Here

An agent is Claude running in a loop:
1. Read user message
2. Decide if a tool is needed
3. If yes: call tool, get result, loop back to step 2
4. If no: write final response

```javascript
// Backend: Express route that runs Claude as agent
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  const messages = [{ role: "user", content: message }];

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      return res.json({ reply: response.content[0].text });
    }

    if (response.stop_reason === "tool_use") {
      const toolUse = response.content.find(b => b.type === "tool_use");
      const toolResult = await callTool(toolUse.name, toolUse.input);
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolResult }]
      });
    }
  }
});
```

### Stack for the Frontend

- React + Vite (same as HireFlow)
- Simple chat UI: message input, scrollable message history
- No state management needed — just `useState` for messages array
- One Express route: `POST /api/chat`

---

## Part 9: The Path to Workday

### The Pattern — Same Handler, Different API

```javascript
// Pokemon handler (what you learn with)
async function getPokemon(identifier) {
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${identifier}`);
  const data = await res.json();
  return `${data.name}: ${data.types[0].type.name}`;
}

// Workday handler (same pattern, one extra step: OAuth)
async function getWorker(workerId) {
  const token = await getWorkdayToken();          // ← only new thing
  const res = await fetch(
    `${process.env.WORKDAY_TENANT_URL}/api/v1/workers/${workerId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return `Worker: ${data.name}, Dept: ${data.department}`;
}
```

### Workday OAuth Helper (write once, use everywhere)

```javascript
let tokenCache = { token: null, expiresAt: 0 };

async function getWorkdayToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 300_000) {
    return tokenCache.token;
  }
  const res = await fetch(`${process.env.WORKDAY_AUTH_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.WORKDAY_CLIENT_ID,
      client_secret: process.env.WORKDAY_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}
```

### Workday Tool Definitions (ready to implement)

```javascript
{ name: "get_worker", description: "Fetch a Workday worker's details — name, department, job profile, manager. Use when the user asks about a specific person in the system.", inputSchema: { identifier: z.string() } }
{ name: "trigger_business_process", description: "Initiate a Workday business process for a worker. Use for HR actions: name changes, transfers, terminations.", inputSchema: { worker_id: z.string(), business_process: z.string(), effective_date: z.string() } }
{ name: "change_legal_name", description: "Change a worker's legal name in Workday.", inputSchema: { worker_id: z.string(), first_name: z.string(), last_name: z.string(), effective_date: z.string() } }
```

---

## Part 10: Workday Extend PMD Screen Builder

**Deferred — to be designed when you're ready.** Your SME knowledge is the critical input here.

---

## Implementation Phases

### Phase 1: Pokemon MCP — Local ✓ COMPLETE
- [x] Create `pokemon-mcp/` with all files
- [x] `npm install`
- [x] Register with Claude Code VSCode extension
- [x] Verified all 3 tools work: get_pokemon, get_pokemon_by_type, compare_pokemon

### Phase 2: Pokemon MCP — Vercel ✓ COMPLETE
- [x] Create `api/mcp.js` with StreamableHTTPServerTransport
- [x] Push to GitHub: https://github.com/mikesz88/pokemon-mcp
- [x] Deploy via Vercel dashboard: https://pokemon-mcp-beta.vercel.app
- [x] Register: `claude mcp add pokemon-vercel --transport http https://pokemon-mcp-beta.vercel.app/api/mcp`
- [x] Both servers verified working side by side

### Phase 3: Frontend Chat UI
- [ ] React + Vite frontend (simple chat interface)
- [ ] Express backend with `POST /api/chat`
- [ ] Anthropic SDK agent loop
- [ ] Wire Pokemon tools into backend
- [ ] Working demo: chat with Pokemon agent in browser

### Phase 4: Workday MCP
- [ ] Add `getWorkdayToken()` OAuth helper
- [ ] Add Workday env vars
- [ ] Add `get_worker`, `trigger_business_process`, `change_legal_name` tools
- [ ] Deploy to Vercel with env vars
- [ ] Wire into chat UI frontend

### Phase 5: Extend PMD Builder
- [ ] TBD — design together when ready

---

## Quick Reference Cheatsheet

```
WHAT IS MCP:
  A standard protocol for AI to call external functions.
  Like Express routes, but the caller is Claude instead of a browser.

KEY CONCEPTS:
  Tool definition  = route definition + docs (name, description, inputSchema)
  Tool handler     = route handler function (async, calls real API)
  MCP Server       = Express app (registers tools, handles calls)
  Transport        = how Claude connects (stdio = local, HTTP = cloud)

TRANSPORTS:
  stdio     = Claude spawns your Node script, communicates via stdin/stdout
  HTTP      = Claude connects to your server URL (StreamableHTTPServerTransport)
              SSEServerTransport is DEPRECATED — don't use it

REGISTERING WITH CLAUDE CODE (VSCode extension):
  stdio:  claude mcp add <name> --command node --args /path/to/server.js
  HTTP:   claude mcp add <name> --transport http https://your-url/api/mcp
  Check:  claude mcp list
  WARN:   Path casing must match exactly — run from project root

ADDING A NEW TOOL:
  server.registerTool(name, { description, inputSchema: { key: z.string() } }, async (args) => {
    return { content: [{ type: "text", text: result }] };
  });

STDOUT vs STDERR:
  stdout = MCP JSON-RPC pipe (DO NOT log here)
  stderr = your logs (console.error)

CONNECTING TO WORKDAY:
  Same pattern as PokéAPI. Add getWorkdayToken(), add env vars,
  replace fetch(pokeapi...) with fetch(workday..., { auth header }).
```
