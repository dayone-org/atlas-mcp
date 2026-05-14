# Atlas MCP

MCP server for providing and managing DAYONE company knowledge.

Atlas is an online-first Worker MCP backed by Cloudflare:

- markdown files in R2 are canonical
- Cloudflare AI Search provides retrieval
- Atlas parses minimal frontmatter (id, title, updated_at, sources, relations) for provenance and relation hints
- Atlas MCP exposes operational tools only; knowledge model guidance lives in the separate Atlas skill package

`npm run dev` starts the Worker dev server.

## Requirements

- Node.js 22 or newer
- npm
- Cloudflare Wrangler access to the configured R2 bucket and AI Search instance

## Run With Cloudflare AI Search

From `atlas-mcp`:

```bash
npm install
npm run dev
```

The Worker dev server exposes the MCP endpoint at:

```text
http://localhost:8787/mcp
```

The Worker uses R2 and Cloudflare AI Search bindings from `wrangler.jsonc`.
The current Cloudflare setup uses AI Search instance `small-paper-dfed`,
backed by `atlas-bucket`.

## Scripts

```bash
npm run dev            # Cloudflare Worker dev server on localhost:8787
npm run worker:dev     # same as dev
npm run start          # same as dev
npm run deploy
```
Create the MCP API key secret before deploying:

```bash
wrangler secret put MCP_API_KEY
npm run deploy
```

R2-backed AI Search syncs on Cloudflare's managed schedule. Use Cloudflare AI
Search controls when a manual sync is needed after writes.

## MCP Tools

Atlas exposes a slim tool surface. It does not expose raw workspace write,
append, delete, patch, source, event, index, client CRUD, or project CRUD tools.

- Discovery: `atlas_status`, `atlas_embed`, `atlas_search`, `atlas_context`, `atlas_trace`, `atlas_health_check`
- Core files: `atlas_core_create`, `atlas_core_update`
- Knowledge: `atlas_knowledge_read`, `atlas_knowledge_create`, `atlas_knowledge_update`, `atlas_knowledge_delete`

Agents should compose these tools for real workflows. Core files cover
`_atlas.md`, `_client.md`, `_project.md`, `_state.md`, and `_index.md`.
Knowledge writes update `_index.md` automatically.

## Query Flow

```text
ChatGPT / Claude / Codex
  -> Atlas MCP Worker
  -> R2 canonical markdown
  -> Cloudflare AI Search retrieval
  -> Atlas frontmatter parsing
  -> relation hint packaging
```

R2-backed AI Search syncs on Cloudflare's managed schedule. `atlas_embed`
reports Cloudflare AI Search indexing status. Use `atlas_search` for candidate
knowledge pages, `atlas_context` for exact reads and project context, and
`atlas_trace` for relation hints. Use `atlas_core_create/update` for underscore
files and `atlas_knowledge_*` for project knowledge pages.

Example MCP `atlas_search` arguments:

```json
{
	"query": "pricing packaging",
	"client": "acme",
	"project": "onboarding",
	"intent": "Find pricing decision context",
	"limit": 10
}
```

For Streamable HTTP clients, point them at:

```text
http://localhost:8787/mcp
```
