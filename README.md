# Atlas MCP

Local-first MCP server for providing and managing DAYONE company knowledge.

The current development path is intentionally local:

- markdown files on local disk are canonical knowledge files
- qmd provides the local retrieval index
- Atlas parses minimal frontmatter (id, title, updated_at, sources, relations) for provenance and relation hints
- Atlas MCP exposes operational tools only; knowledge model guidance lives in the separate Atlas skill package
- no Cloudflare Workers or R2 are required for behavior testing

The old Worker/R2 implementation is still present as a read-only fallback in
`src/index.ts` for later deployment work, but `npm run dev` now starts the local
Node server.

## Requirements

- Node.js 22 or newer
- npm
- local markdown workspace

`@tobilu/qmd` stores its SQLite index locally and can optionally download local GGUF models when embeddings, query expansion, or reranking are used. Atlas search uses qmd's best-quality local query path.

## Run Locally

From `atlas-mcp`:

```bash
npm install
npm run dev
```

By default, local scripts use the repo-level canonical workspace:

```text
/Users/Bean.Duong/Desktop/dev/atlas/atlas-data
```

Override it when needed:

```bash
ATLAS_WORKSPACE=/path/to/atlas-workspace npm run dev
```

The server starts at:

```text
http://localhost:8787/mcp
```

If `ATLAS_WORKSPACE` is omitted when using the npm scripts, `../atlas-data` is used.
If you run `src/local/server.ts` directly without `--workspace` or `ATLAS_WORKSPACE`,
the current working directory is used.

Generated local state is stored under:

```text
$ATLAS_WORKSPACE/.atlas/qmd.sqlite
```

You can override it:

```bash
ATLAS_QMD_DB=/tmp/atlas-qmd.sqlite npm run dev
```

## Scripts

```bash
npm run dev            # local HTTP MCP server on localhost:8787
npm run local:http     # same as dev
npm run local:stdio    # stdio MCP server for local clients
npm run local:index    # index local markdown into qmd and exit
npm run local:index:embed # index markdown and generate local vector embeddings
npm run smoke:local    # end-to-end local MCP smoke test
```

Worker scripts are explicit:

```bash
npm run worker:dev
npm run worker:dev:local
npm run deploy
```

The Worker fallback is intentionally read-only and only exposes
`atlas_status` and `atlas_context`.

## Local MCP Tools

Atlas exposes a slim v0 tool surface. It does not expose raw workspace
write, append, delete, patch, source, event, index, client CRUD, or project
CRUD tools.

- Discovery: `atlas_status`, `atlas_embed`, `atlas_search`, `atlas_context`, `atlas_trace`, `atlas_health_check`
- Core files: `atlas_core_create`, `atlas_core_update`
- Knowledge: `atlas_knowledge_read`, `atlas_knowledge_create`, `atlas_knowledge_update`, `atlas_knowledge_delete`

Agents should compose these tools for real workflows. Core files cover
`_atlas.md`, `_client.md`, `_project.md`, `_state.md`, and `_index.md`.
Knowledge writes update `_index.md` automatically.

## Query Flow

```text
ChatGPT / Claude / Codex
  -> Atlas MCP
  -> qmd local retrieval
  -> Atlas frontmatter parsing
  -> relation hint packaging
```

Use `atlas_embed` after bulk changes when vector coverage should be refreshed.
Embedding also refreshes qmd path context from Atlas files. Use `atlas_search`
for candidate knowledge pages, `atlas_context` for exact reads and project context, and
`atlas_trace` for relation hints. Use `atlas_core_create/update` for
underscore files and `atlas_knowledge_*` for project knowledge pages.

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

Generate embeddings before querying:

```bash
npm run local:index:embed
```

That may download local qmd GGUF models into `~/.cache/qmd/models/`. Atlas
search uses qmd's local query expansion, BM25/vector retrieval, and reranking
path.

## Claude Desktop

For stdio:

```json
{
	"mcpServers": {
		"atlas": {
			"command": "npm",
			"args": ["run", "local:stdio"],
			"cwd": "/Users/Bean.Duong/Desktop/dev/atlas/atlas-mcp",
			"env": {
				"ATLAS_WORKSPACE": "/Users/Bean.Duong/Desktop/dev/atlas/atlas-data"
			}
		}
	}
}
```

For Streamable HTTP clients, point them at:

```text
http://localhost:8787/mcp
```
