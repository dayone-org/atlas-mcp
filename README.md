# Atlas MCP

Local-first MCP server for testing Atlas company-brain orchestration.

The current development path is intentionally local:

- markdown files on local disk are canonical memory
- qmd provides the local retrieval index
- Atlas parses minimal frontmatter (id, title, updated_at, owners, relations) for graph edges
- Atlas MCP serves the canonical Atlas workflow docs as MCP resources and prompts
- no Cloudflare Workers or R2 are required for behavior testing

The old Worker/R2 implementation is still present in `src/index.ts` for later deployment work, but `npm run dev` now starts the local Node server.

## Requirements

- Node.js 22 or newer
- npm
- local markdown workspace

`@tobilu/qmd` stores its SQLite index locally and can optionally download local GGUF models when vector embeddings or hybrid query expansion are used. The default Atlas search mode is lexical BM25, so the first local path does not require model downloads.

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

Atlas MCP discovers the canonical skill docs from `../atlas-skill/skills/atlas`
when running from this repo. Override that path when needed:

```bash
ATLAS_SKILL_DIR=/path/to/atlas/skills/atlas npm run dev
```

## Scripts

```bash
npm run dev            # local HTTP MCP server on localhost:8787
npm run local:http     # same as dev
npm run local:stdio    # stdio MCP server for local clients
npm run local:index    # index local markdown into qmd and exit
npm run smoke:local    # end-to-end local MCP smoke test
```

Worker scripts are explicit:

```bash
npm run worker:dev
npm run worker:dev:local
npm run deploy
```

## Local MCP Tools

Atlas intentionally exposes a small semantic tool surface:

- `atlas_status`: show workspace, qmd, graph, skill, and health status. Set `refreshIndex: true` after out-of-band file changes.
- `atlas_search`: refresh and query markdown through qmd. Defaults to fast lexical BM25.
- `atlas_context`: hydrate a project scope, read exact files with `paths`, or list a directory with `listPath`.
- `atlas_trace`: trace frontmatter relations (supersedes, supports, contradicts, depends_on, related_to) and owners.
- `atlas_health_check`: lint local memory for broken relationships, frontmatter parse errors, and missing required fields (id, title, updated_at).
- `atlas_upload_file`: copy an absolute local filesystem path directly into the Atlas workspace. Use for original binary artifacts; never base64-encode files into prompts or patches.
- `atlas_apply_patch`: apply a text patch. The server stages and validates the patch before writing; successful writes re-index by default.

There is no separate public source-markdown write tool. Text source records
should be written in the same patch as the related `knowledge/`, `_index.md`,
`_state.md`, or `_log.md` updates so clients do not stop after storing raw
material. For binary originals, use `atlas_upload_file` first, then create the
source markdown record and knowledge updates in one `atlas_apply_patch` patch.

## Skill Resources And Prompts

Atlas MCP serves the canonical Atlas skill docs directly, so clients that support MCP resources/prompts can discover the workflow without a separate installed skill package.

Resources:

```text
atlas://skill/SKILL.md
atlas://skill/actions/ingest.md
atlas://skill/actions/query.md
atlas://skill/actions/lint.md
atlas://skill/references/frontmatter.md
atlas://skill/references/object-types.md
```

Prompts:

```text
atlas_ingest_workflow
atlas_query_workflow
atlas_lint_workflow
atlas_memory_health_review
atlas_decision_review
```

The separate installed skill directory should be treated as a generated compatibility artifact for clients that do not yet use MCP-served workflow docs well.

## Query Flow

```text
ChatGPT / Claude / Codex
  -> Atlas MCP
  -> MCP-served Atlas workflow prompt/resource
  -> qmd local retrieval
  -> Atlas frontmatter graph parsing
  -> relation-based context packaging
```

Use `atlas_search` for candidate memory, `atlas_context` for exact reads and
project hydration, `atlas_trace` for graph context, `atlas_upload_file` for
original binary artifacts, and `atlas_apply_patch` for client-orchestrated
markdown writes.

Example MCP `atlas_search` arguments:

```json
{
  "query": "pricing packaging",
  "mode": "lex",
  "limit": 10
}
```

Hybrid qmd search is available when you want it:

```json
{
  "mode": "hybrid",
  "searches": [
    { "type": "lex", "query": "\"pricing packaging\"" },
    { "type": "vec", "query": "why did pricing packaging matter?" }
  ],
  "rerank": false,
  "limit": 10
}
```

For vector/hybrid quality, run the local server with `--index --embed` from the
CLI before querying. That may download local qmd models.

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
        "ATLAS_WORKSPACE": "/Users/Bean.Duong/Desktop/dev/atlas/atlas-data",
        "ATLAS_SKILL_DIR": "/Users/Bean.Duong/Desktop/dev/atlas/atlas-skill/skills/atlas"
      }
    }
  }
}
```

For Streamable HTTP clients, point them at:

```text
http://localhost:8787/mcp
```
