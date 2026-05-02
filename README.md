# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a remote MCP server that doesn't require authentication on Cloudflare Workers.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/mcp`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/tools/) to the MCP server, register them in `createServer()` inside `src/index.ts`.

## Atlas workspace tools

This project binds the `atlas` R2 bucket as `ATLAS_BUCKET`. During local development, the binding is configured with `"remote": true`, so `npm run dev` reads from the real Cloudflare R2 bucket instead of local Miniflare storage.

Available MCP tools:

- `list`: list files and directories under a workspace-relative path.
- `read`: read a UTF-8 text file.
- `read_many`: read up to 50 UTF-8 text files in one call. Returns ordered
  per-file results, with missing, unsafe, or oversized files reported as
  item-level errors.
- `project_context`: hydrate an Atlas project in one call. Reads present core files
  (`_project.md`, `_state.md`, `_index.md`, `_log.md`) and returns shallow
  `knowledge/` and `sources/` catalogs.
- `mkdir`: create a logical directory marker in R2.
- `rmdir`: remove a logical directory; pass `recursive: true` to delete everything under it.
- `apply_patch`: add, update, or delete text files with a patch.

Paths are normalized as Atlas workspace paths: leading `/` is allowed, `..` is rejected, and R2 directory markers are hidden from `list`.

Use `read_many` when an agent already knows the exact files it needs:

```json
{ "paths": ["clients/acme/projects/website-refresh/_project.md", "clients/acme/projects/website-refresh/_state.md"] }
```

Use `project_context` as the first hydration call for a project:

```json
{ "path": "clients/acme/projects/website-refresh" }
```

Raw source artifacts are uploaded outside MCP with `PUT /files/<atlas-path>`. The request body is the file bytes, `Content-Length` is required, and uploads fail with `409` when the target exists unless `?overwrite=true` is passed. Optional metadata headers:

- `Content-Type`: stored as R2 HTTP metadata; defaults from the Atlas path when omitted.
- `X-Atlas-Sha256`: SHA-256 hex digest stored as custom metadata.
- `X-Atlas-Source-Filename`: original local filename stored as custom metadata.

The `/mcp` and `/files/<atlas-path>` routes require `Authorization: Bearer <MCP_API_KEY>`.

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/mcp`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote).

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
	"mcpServers": {
		"calculator": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/mcp" // or remote-mcp-server-authless.your-account.workers.dev/mcp
			]
		}
	}
}
```

Restart Claude and you should see the tools become available.
