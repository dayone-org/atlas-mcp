import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_READ_LIMIT_BYTES = 64 * 1024;
const MAX_READ_LIMIT_BYTES = 1024 * 1024;

function describeObject(object: R2Object) {
	return {
		key: object.key,
		size: object.size,
		etag: object.etag,
		uploaded: object.uploaded.toISOString(),
		httpMetadata: object.httpMetadata,
		customMetadata: object.customMetadata,
	};
}

function toBase64(bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 0x8000;

	for (let index = 0; index < bytes.length; index += chunkSize) {
		const chunk = bytes.subarray(index, index + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

function jsonContent(value: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(value, null, 2),
			},
		],
	};
}

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
			return {
				content: [{ type: "text", text: String(a + b) }],
			};
		},
	);

	server.registerTool(
		"list_r2_files",
		{
			description: "List files in the Atlas R2 bucket.",
			inputSchema: {
				prefix: z.string().optional(),
				cursor: z.string().optional(),
				limit: z.number().int().min(1).max(1000).default(25),
			},
		},
		async ({ prefix, cursor, limit }) => {
			const result = await env.ATLAS_BUCKET.list({
				prefix,
				cursor,
				limit,
				include: ["httpMetadata", "customMetadata"],
			});

			return jsonContent({
				objects: result.objects.map(describeObject),
				delimitedPrefixes: result.delimitedPrefixes,
				truncated: result.truncated,
				cursor: result.truncated ? result.cursor : null,
			});
		},
	);

	server.registerTool(
		"get_r2_file",
		{
			description: "Fetch a file from the Atlas R2 bucket for testing.",
			inputSchema: {
				key: z.string().min(1),
				encoding: z.enum(["text", "base64"]).default("text"),
				maxBytes: z
					.number()
					.int()
					.min(1)
					.max(MAX_READ_LIMIT_BYTES)
					.default(DEFAULT_READ_LIMIT_BYTES),
			},
		},
		async ({ key, encoding, maxBytes }) => {
			const metadata = await env.ATLAS_BUCKET.head(key);

			if (!metadata) {
				return jsonContent({
					found: false,
					key,
				});
			}

			const truncated = metadata.size > maxBytes;
			const object = await env.ATLAS_BUCKET.get(
				key,
				truncated
					? {
							range: {
								offset: 0,
								length: maxBytes,
							},
						}
					: undefined,
			);

			if (!object) {
				return jsonContent({
					found: false,
					key,
				});
			}

			const body = encoding === "text" ? await object.text() : toBase64(await object.bytes());

			return jsonContent({
				found: true,
				truncated,
				encoding,
				maxBytes,
				object: describeObject(metadata),
				body,
			});
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
