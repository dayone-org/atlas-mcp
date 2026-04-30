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
- `upload`: upload any file using base64 content.
- `mkdir`: create a logical directory marker in R2.
- `rmdir`: remove a logical directory; pass `recursive: true` to delete everything under it.
- `apply_patch`: add, update, or delete text files with a patch.

Paths are normalized as Atlas workspace paths: leading `/` is allowed, `..` is rejected, and R2 directory markers are hidden from `list`.

The `/mcp` route requires `Authorization: Bearer <MCP_API_KEY>`.

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
