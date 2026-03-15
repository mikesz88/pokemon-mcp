// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Imports
// McpServer      = the MCP app class (high-level API, like `express()`)
// StdioTransport = the local transport (stdin/stdout pipe)
// z              = Zod schema builder used by McpServer for input validation
// ─────────────────────────────────────────────────────────────────────────────
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Handler Functions
// Each function: receives args → calls PokéAPI → returns a string result
// ─────────────────────────────────────────────────────────────────────────────

async function getPokemon(identifier) {
  const res = await fetch(
    `https://pokeapi.co/api/v2/pokemon/${identifier.toLowerCase()}`
  );
  if (!res.ok) throw new Error(`Pokémon "${identifier}" not found`);
  const data = await res.json();

  const types = data.types.map((t) => t.type.name).join(", ");
  const abilities = data.abilities.map((a) => a.ability.name).join(", ");
  const stats = data.stats
    .map((s) => `  ${s.stat.name}: ${s.base_stat}`)
    .join("\n");

  return (
    `${data.name.toUpperCase()} (#${data.id})\n` +
    `Type: ${types}\n` +
    `Abilities: ${abilities}\n` +
    `Base Stats:\n${stats}\n` +
    `Height: ${data.height / 10}m | Weight: ${data.weight / 10}kg`
  );
}

async function getPokemonByType(type) {
  const res = await fetch(
    `https://pokeapi.co/api/v2/type/${type.toLowerCase()}`
  );
  if (!res.ok) throw new Error(`Type "${type}" not found`);
  const data = await res.json();

  const pokemon = data.pokemon
    .slice(0, 20)
    .map((p, i) => `${i + 1}. ${p.pokemon.name}`)
    .join("\n");

  return (
    `${type.toUpperCase()} type Pokémon (first 20):\n${pokemon}\n` +
    `Total in type: ${data.pokemon.length}`
  );
}

async function comparePokemon(nameA, nameB) {
  const [resA, resB] = await Promise.all([
    fetch(`https://pokeapi.co/api/v2/pokemon/${nameA.toLowerCase()}`),
    fetch(`https://pokeapi.co/api/v2/pokemon/${nameB.toLowerCase()}`),
  ]);

  if (!resA.ok) throw new Error(`Pokémon "${nameA}" not found`);
  if (!resB.ok) throw new Error(`Pokémon "${nameB}" not found`);

  const [a, b] = await Promise.all([resA.json(), resB.json()]);

  const statsA = Object.fromEntries(a.stats.map((s) => [s.stat.name, s.base_stat]));
  const statsB = Object.fromEntries(b.stats.map((s) => [s.stat.name, s.base_stat]));

  const statNames = ["hp", "attack", "defense", "special-attack", "special-defense", "speed"];
  let winsA = 0;
  let winsB = 0;

  const comparison = statNames
    .map((stat) => {
      const valA = statsA[stat] ?? 0;
      const valB = statsB[stat] ?? 0;
      const winner = valA > valB ? a.name : valA < valB ? b.name : "tie";
      if (valA > valB) winsA++;
      else if (valB > valA) winsB++;
      return `  ${stat.padEnd(18)} ${String(valA).padStart(3)} vs ${String(valB).padEnd(3)}  → ${winner}`;
    })
    .join("\n");

  const totalA = statNames.reduce((sum, s) => sum + (statsA[s] ?? 0), 0);
  const totalB = statNames.reduce((sum, s) => sum + (statsB[s] ?? 0), 0);
  const overallWinner =
    totalA > totalB ? a.name.toUpperCase() : totalB > totalA ? b.name.toUpperCase() : "TIE";

  return (
    `${a.name.toUpperCase()} vs ${b.name.toUpperCase()}\n` +
    `${"─".repeat(50)}\n` +
    `${"Stat".padEnd(20)} ${a.name.padStart(5)} vs ${b.name.padEnd(5)}  Winner\n` +
    `${comparison}\n` +
    `${"─".repeat(50)}\n` +
    `Total:               ${totalA} vs ${totalB}\n` +
    `Stat wins:           ${a.name} ${winsA} | ${b.name} ${winsB}\n` +
    `Overall winner:      ${overallWinner}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: MCP Server Setup
// McpServer registers tools directly — no separate ListTools/CallTool handlers.
// server.tool(name, description, zodSchema, handler) is the full registration.
// ─────────────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "pokemon-mcp", version: "1.0.0" });

server.registerTool(
  "get_pokemon",
  {
    description:
      "Get detailed information about a specific Pokémon by name or ID. " +
      "Returns type, abilities, and base stats. " +
      "Use this when the user asks about a single Pokémon or wants to know its details.",
    inputSchema: { identifier: z.string().describe("Pokémon name (e.g. 'pikachu') or Pokédex ID (e.g. '25')") },
  },
  async ({ identifier }) => {
    try {
      return { content: [{ type: "text", text: await getPokemon(identifier) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "get_pokemon_by_type",
  {
    description:
      "Get a list of Pokémon that belong to a specific type (e.g. fire, water, grass). " +
      "Returns the first 20 Pokémon of that type. " +
      "Use this when the user asks for Pokémon of a certain type or wants to see a list.",
    inputSchema: { type: z.string().describe("Pokémon type (e.g. 'fire', 'water', 'grass', 'electric', 'psychic')") },
  },
  async ({ type }) => {
    try {
      return { content: [{ type: "text", text: await getPokemonByType(type) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "compare_pokemon",
  {
    description:
      "Compare the base stats of two Pokémon side by side. " +
      "Returns a comparison showing which wins each stat category and the overall winner. " +
      "Use this when the user wants to compare two Pokémon or asks which one is stronger.",
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

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Start — stdio transport (Claude Code / Claude Desktop, local)
// Note: logs go to stderr, not stdout (stdout is the MCP protocol pipe)
// ─────────────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Pokemon MCP server running on stdio");
