import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function createServer(env: Env) {
	const server = new McpServer({
		name: "Atlas MCP",
		version: "1.0.0",
	});

	server.registerTool(
		"add",
		{
			description: "Add two numbers",
			inputSchema: {
				a: z.number(),
				b: z.number(),
			},
		},
		async ({ a, b }) => {
			// read files in ATLAS_BUCKET
			const files = await env.ATLAS_BUCKET.list();
			console.log("Files in ATLAS_BUCKET", files);
			return {
				content: [{ type: "text", text: String(a + b) }],
			};
		},
	);

	return server;
}

function requireApiKey(request: Request, env: Env) {
	const auth = request.headers.get("Authorization");
	return auth === `Bearer ${env.MCP_API_KEY}`;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			if (!requireApiKey(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}
			const server = createServer(env);
			return createMcpHandler(server)(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
