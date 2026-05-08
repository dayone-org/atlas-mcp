import { randomUUID } from "node:crypto";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
	addLineNumbers,
	createStore,
	extractSnippet,
	type HybridQueryResult,
	type QMDStore,
	type SearchResult,
} from "@tobilu/qmd";
import { z } from "zod";
import {
	atlasPathFromQmdDisplayPath,
	type AtlasCoreRole,
	LocalAtlasWorkspace,
	type AtlasGraph,
	type AtlasObject,
} from "./workspace.js";

const DEFAULT_PORT = 8787;
const DEFAULT_COLLECTION = "atlas";

type SearchInput = {
	query: string;
	client?: string;
	project?: string;
	intent?: string;
	limit?: number;
};

type RuntimeOptions = {
	workspaceRoot?: string;
	dbPath?: string;
	collectionName?: string;
};

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

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function toNumber(value: string | undefined, fallback: number) {
	if (!value) {
		return fallback;
	}

	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${value} is not a positive integer.`);
	}

	return parsed;
}

function parseArgs(args: string[]) {
	const result: {
		mode: "http" | "stdio" | "index";
		port: number;
		workspaceRoot?: string;
		dbPath?: string;
		quiet: boolean;
		embed: boolean;
	} = {
		mode: "http",
		port: DEFAULT_PORT,
		quiet: false,
		embed: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === "--http") {
			result.mode = "http";
			continue;
		}

		if (arg === "--stdio") {
			result.mode = "stdio";
			continue;
		}

		if (arg === "--index") {
			result.mode = "index";
			continue;
		}

		if (arg === "--quiet") {
			result.quiet = true;
			continue;
		}

		if (arg === "--embed") {
			result.embed = true;
			continue;
		}

		if (arg === "--port") {
			result.port = toNumber(args[++index], DEFAULT_PORT);
			continue;
		}

		if (arg === "--workspace") {
			result.workspaceRoot = args[++index];
			continue;
		}

		if (arg === "--db") {
			result.dbPath = args[++index];
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return result;
}

function formatInstructions(runtime: LocalAtlasRuntime) {
	return [
		"Atlas Local MCP provides and manages DAYONE company knowledge.",
		`Workspace: ${runtime.workspace.root}`,
		`QMD collection: ${runtime.collectionName}`,
		"",
		"Use the slim v0 Atlas tools: discovery, core file create/update, and knowledge read/create/update/delete.",
		"Markdown files remain canonical. qmd is used only as the local retrieval index.",
		"Frontmatter is intentionally minimal: id, title, updated_at, optional sources, and optional flat relation hints. Knowledge writes keep _index.md current.",
	].join("\n");
}

function objectSummary(object: AtlasObject | undefined) {
	if (!object) {
		return undefined;
	}

	return {
		id: object.id ?? null,
		type: object.type ?? null,
		title: object.title,
		sources: object.sources,
		updatedAt: object.updatedAt ?? null,
		relationCount: object.relations.length,
	};
}

function scopeFromPath(atlasPath: string) {
	const match = atlasPath.match(/^clients\/([^/]+)(?:\/projects\/([^/]+))?/);

	return {
		client: match?.[1] ?? null,
		project: match?.[2] ?? null,
	};
}

function contextPathForObject(object: AtlasObject) {
	if (/^clients\/[^/]+\/_client\.md$/.test(object.path)) {
		return `/${path.posix.dirname(object.path)}`;
	}

	if (/^clients\/[^/]+\/projects\/[^/]+\/_project\.md$/.test(object.path)) {
		return `/${path.posix.dirname(object.path)}`;
	}

	return `/${object.path}`;
}

function contextForObject(object: AtlasObject) {
	const scope = scopeFromPath(object.path);
	const parts = [
		object.title,
		object.type ? `Atlas ${object.type} page` : "Atlas markdown page",
		scope.client ? `client: ${scope.client}` : undefined,
		scope.project ? `project: ${scope.project}` : undefined,
		object.sources.length > 0 ? `sources: ${object.sources.join(", ")}` : undefined,
		object.relations.length > 0 ? `${object.relations.length} relation(s)` : undefined,
	].filter(Boolean);

	return parts.join(" | ");
}

function formatSearchResult(
	result: SearchResult | HybridQueryResult,
	graph: AtlasGraph,
	collectionName: string,
	query: string,
) {
	const displayPath = result.displayPath;
	const atlasPath = atlasPathFromQmdDisplayPath(displayPath, collectionName);
	const object = graph.byPath.get(atlasPath);
	const scope = scopeFromPath(atlasPath);
	const body = "bestChunk" in result ? result.bestChunk : ((result as SearchResult).body ?? "");
	const snippet = body ? extractSnippet(body, query, 450, undefined, undefined).snippet : "";

	return {
		docid: `#${result.docid}`,
		path: atlasPath,
		qmdPath: displayPath,
		title: result.title,
		score: Math.round(result.score * 1000) / 1000,
		client: scope.client,
		project: scope.project,
		kind: object?.type ?? null,
		context: result.context,
		snippet,
		metadata: objectSummary(object),
	};
}

export class LocalAtlasRuntime {
	readonly workspace: LocalAtlasWorkspace;
	readonly collectionName: string;
	readonly dbPath: string;
	private storePromise?: Promise<QMDStore>;

	constructor(options: RuntimeOptions = {}) {
		this.workspace = LocalAtlasWorkspace.fromEnv(options.workspaceRoot);
		this.collectionName =
			options.collectionName ?? process.env.ATLAS_QMD_COLLECTION ?? DEFAULT_COLLECTION;
		this.dbPath = this.workspace.dbPath(options.dbPath);
	}

	async getStore() {
		if (!this.storePromise) {
			await this.workspace.ensureReady();
			this.storePromise = createStore({
				dbPath: this.dbPath,
				config: {
					global_context:
						"Atlas local markdown knowledge workspace for DAYONE company knowledge. Frontmatter carries id, title, updated_at, optional sources, and optional flat relation hints.",
					collections: {
						[this.collectionName]: {
							path: this.workspace.root,
							pattern: "**/*.md",
							ignore: [
								".atlas/**",
								".git/**",
								".next/**",
								".wrangler/**",
								"node_modules/**",
								"dist/**",
								"build/**",
							],
							context: {
								"/": "Atlas markdown memory workspace.",
								"/clients": "Client and project-scoped Atlas knowledge.",
							},
						},
					},
				},
			});
		}

		return this.storePromise;
	}

	async close() {
		if (!this.storePromise) {
			return;
		}

		const store = await this.storePromise;
		await store.close();
		this.storePromise = undefined;
	}

	async syncQmdContexts(graph?: AtlasGraph) {
		const store = await this.getStore();
		const atlasGraph = graph ?? (await this.workspace.buildGraph());
		const existingContexts = await store.listContexts();

		await store.setGlobalContext(
			"DAYONE company knowledge for clients, projects, evidence, decisions, commitments, risks, and live operating state.",
		);

		for (const context of existingContexts) {
			if (context.collection === this.collectionName) {
				await store.removeContext(this.collectionName, context.path);
			}
		}

		await store.addContext(this.collectionName, "/", "DAYONE Atlas workspace root.");
		await store.addContext(
			this.collectionName,
			"/clients",
			"Client and project-scoped DAYONE Atlas knowledge.",
		);

		for (const object of atlasGraph.objects) {
			await store.addContext(
				this.collectionName,
				contextPathForObject(object),
				contextForObject(object),
			);
		}
	}

	async index(options?: { embed?: boolean; forceEmbed?: boolean }) {
		const store = await this.getStore();
		await this.syncQmdContexts();
		const update = await store.update();
		let embed;

		if (options?.embed) {
			embed = await store.embed({
				force: options.forceEmbed,
				chunkStrategy: "regex",
			});
		}

		return {
			ok: true,
			workspaceRoot: this.workspace.root,
			dbPath: this.dbPath,
			collection: this.collectionName,
			update,
			...(embed ? { embed } : {}),
		};
	}

	async status() {
		const store = await this.getStore();
		const [qmd, graph, health] = await Promise.all([
			store.getStatus(),
			this.workspace.buildGraph(),
			this.workspace.healthCheck(),
		]);

		return {
			ok: true,
			workspaceRoot: this.workspace.root,
			dbPath: this.dbPath,
			collection: this.collectionName,
			qmd,
			graph: graph.summary,
			health: {
				ok: health.ok,
				issueCount: health.issues.length,
				errorCount: health.issues.filter((issue) => issue.severity === "error").length,
				warningCount: health.issues.filter((issue) => issue.severity === "warning").length,
			},
		};
	}

	async embed() {
		return this.index({ embed: true });
	}

	async search(input: SearchInput) {
		const refreshed = await this.index();
		const store = await this.getStore();
		const graph = await this.workspace.buildGraph();
		const limit = input.limit ?? 10;
		const query = input.query?.trim() ?? "";
		const client = input.client ? this.workspace.clientSlug(input.client) : undefined;
		const project = input.project ? this.workspace.projectSlug(input.project) : undefined;
		const scopePrefix = client
			? project
				? `clients/${client}/projects/${project}/`
				: `clients/${client}/`
			: undefined;
		const scopeIntent = [
			input.intent?.trim(),
			client ? `client ${client}` : undefined,
			project ? `project ${project}` : undefined,
		]
			.filter(Boolean)
			.join("; ");

		if (!query) {
			throw new Error("search requires query.");
		}

		const results = await store.search({
			query,
			...(scopeIntent ? { intent: scopeIntent } : {}),
			collections: [this.collectionName],
			limit: scopePrefix ? Math.max(limit * 3, 20) : limit,
			rerank: true,
			chunkStrategy: "regex",
		});
		const filteredResults = scopePrefix
			? results.filter((result) =>
					atlasPathFromQmdDisplayPath(result.displayPath, this.collectionName).startsWith(
						scopePrefix,
					),
				)
			: results;

		return {
			ok: true,
			query,
			...(input.intent ? { intent: input.intent } : {}),
			scope: {
				client: client ?? null,
				project: project ?? null,
			},
			...(refreshed ? { refreshedIndex: refreshed.update } : {}),
			results: filteredResults
				.slice(0, limit)
				.map((result) => formatSearchResult(result, graph, this.collectionName, query)),
			graphWarnings: graph.warnings,
		};
	}
}

const clientSchema = z.string().min(1);
const projectSchema = z.string().min(1);
const knowledgeKindSchema = z.enum([
	"conversation",
	"topic",
	"decision",
	"report",
	"research",
	"artifact",
	"source",
	"assumption",
	"commitment",
	"risk",
	"product_gap",
	"incident",
	"strategy",
	"fact",
	"event",
]);
const coreRoleSchema = z.enum(["atlas", "client", "project", "state", "index"]);

async function writeContent(
	runtime: LocalAtlasRuntime,
	operation: () => Promise<Record<string, unknown>>,
) {
	const result = await operation();
	const index = await runtime.index();
	const health = await runtime.workspace.healthCheck();

	return jsonContent({
		...result,
		index: index.update,
		health: {
			ok: health.ok,
			issueCount: health.issues.length,
			issues: health.issues,
		},
	});
}

async function createMcpServer(runtime: LocalAtlasRuntime) {
	const server = new McpServer(
		{
			name: "Atlas Local MCP",
			version: "0.1.0",
		},
		{
			instructions: formatInstructions(runtime),
		},
	);

	server.registerTool(
		"atlas_status",
		{
			description: "Show local Atlas workspace, qmd index, graph, and health status.",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.status()),
	);

	server.registerTool(
		"atlas_embed",
		{
			description:
				"Refresh the qmd index and generate missing local vector embeddings for Atlas search. Use manually after bulk or out-of-band markdown changes; suitable for future scheduled runs.",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.embed()),
	);

	server.registerTool(
		"atlas_search",
		{
			description:
				"Refresh qmd context/index and query Atlas markdown via query expansion, hybrid retrieval, and reranking. Optional client/project scope and intent steer expansion and filter results.",
			inputSchema: {
				query: z.string().min(1),
				client: clientSchema.optional(),
				project: projectSchema.optional(),
				intent: z.string().min(1).optional(),
				limit: z.number().int().min(1).max(50).default(10),
			},
		},
		async (input) => jsonContent(await runtime.search(input)),
	);

	server.registerTool(
		"atlas_context",
		{
			description:
				"Read one project context, read exact Atlas paths, or list one workspace directory. Pass exactly one of path, paths, or listPath.",
			inputSchema: {
				path: z.string().optional(),
				paths: z.array(z.string()).min(1).max(50).optional(),
				listPath: z.string().optional(),
			},
		},
		async ({ path: workspacePath, paths, listPath }) => {
			const modeCount = [workspacePath, paths, listPath].filter(Boolean).length;
			if (modeCount !== 1) {
				throw new Error("atlas_context requires exactly one of path, paths, or listPath.");
			}

			if (workspacePath) {
				if (workspacePath.endsWith(".md")) {
					return jsonContent({
						ok: true,
						files: await runtime.workspace.readMany([workspacePath]),
					});
				}

				return jsonContent(await runtime.workspace.projectContext(workspacePath));
			}

			if (paths) {
				return jsonContent({
					ok: true,
					files: await runtime.workspace.readMany(paths),
				});
			}

			return jsonContent({
				ok: true,
				listing: await runtime.workspace.list(listPath ?? "/"),
			});
		},
	);

	server.registerTool(
		"atlas_trace",
		{
			description:
				"Trace Atlas relation hints from flat frontmatter relations from an Atlas ID or markdown path.",
			inputSchema: {
				idOrPath: z.string().min(1),
				depth: z.number().int().min(1).max(5).default(2),
			},
		},
		async ({ idOrPath, depth }) => jsonContent(await runtime.workspace.trace(idOrPath, depth)),
	);

	server.registerTool(
		"atlas_health_check",
		{
			description:
				"Lint local Atlas knowledge for broken relation hints, frontmatter parse errors, and missing required fields (id, title, updated_at).",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.workspace.healthCheck()),
	);

	server.registerTool(
		"atlas_knowledge_read",
		{
			description: "Read one Atlas knowledge page.",
			inputSchema: z
				.object({ client: clientSchema, project: projectSchema, slug: z.string().min(1) })
				.strict(),
		},
		async (input) => jsonContent(await runtime.workspace.getKnowledge(input)),
	);

	server.registerTool(
		"atlas_knowledge_create",
		{
			description: "Create one Atlas knowledge page in a project root.",
			inputSchema: z
				.object({
					client: clientSchema,
					project: projectSchema,
					slug: z.string().min(1),
					kind: knowledgeKindSchema,
					title: z.string().min(1),
					body: z.string().min(1),
					sources: z.array(z.string().min(1)).optional(),
					relations: z.array(z.string().min(1)).optional(),
				})
				.strict(),
		},
		async (input) => writeContent(runtime, () => runtime.workspace.createKnowledge(input)),
	);

	server.registerTool(
		"atlas_knowledge_update",
		{
			description: "Update one Atlas knowledge page.",
			inputSchema: z
				.object({
					client: clientSchema,
					project: projectSchema,
					slug: z.string().min(1),
					title: z.string().min(1).optional(),
					body: z.string().optional(),
					sources: z.array(z.string().min(1)).optional(),
					relations: z.array(z.string().min(1)).optional(),
				})
				.strict(),
		},
		async (input) => writeContent(runtime, () => runtime.workspace.updateKnowledge(input)),
	);

	server.registerTool(
		"atlas_knowledge_delete",
		{
			description: "Delete one Atlas knowledge page.",
			inputSchema: z
				.object({ client: clientSchema, project: projectSchema, slug: z.string().min(1) })
				.strict(),
		},
		async (input) => writeContent(runtime, () => runtime.workspace.deleteKnowledge(input)),
	);

	server.registerTool(
		"atlas_core_create",
		{
			description:
				"Create a bounded Atlas core underscore file. Roles: atlas, client, project, state, index. Project role creates or repairs the full project scaffold.",
			inputSchema: z
				.object({
					role: coreRoleSchema,
					client: clientSchema.optional(),
					project: projectSchema.optional(),
					title: z.string().min(1).optional(),
					body: z.string().optional(),
					sources: z.array(z.string().min(1)).optional(),
					relations: z.array(z.string().min(1)).optional(),
				})
				.strict(),
		},
		async (input) =>
			writeContent(runtime, () =>
				runtime.workspace.createCore({ ...input, role: input.role as AtlasCoreRole }),
			),
	);

	server.registerTool(
		"atlas_core_update",
		{
			description:
				"Update a bounded Atlas core underscore file. Roles: atlas, client, project, state, index.",
			inputSchema: z
				.object({
					role: coreRoleSchema,
					client: clientSchema.optional(),
					project: projectSchema.optional(),
					title: z.string().min(1).optional(),
					body: z.string().optional(),
					sources: z.array(z.string().min(1)).optional(),
					relations: z.array(z.string().min(1)).optional(),
				})
				.strict(),
		},
		async (input) =>
			writeContent(runtime, () =>
				runtime.workspace.updateCore({ ...input, role: input.role as AtlasCoreRole }),
			),
	);

	return server;
}

export async function startStdio(runtime: LocalAtlasRuntime) {
	const server = await createMcpServer(runtime);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`Atlas Local MCP running on stdio for ${runtime.workspace.root}`);
}

type HttpServerHandle = {
	port: number;
	stop: () => Promise<void>;
};

export async function startHttp(
	runtime: LocalAtlasRuntime,
	options: { port?: number; quiet?: boolean } = {},
): Promise<HttpServerHandle> {
	await runtime.workspace.ensureReady();

	const port = options.port ?? DEFAULT_PORT;
	const quiet = options.quiet ?? false;
	const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
	const startTime = Date.now();

	function log(message: string) {
		if (!quiet) {
			console.error(message);
		}
	}

	async function createSession() {
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			enableJsonResponse: true,
			onsessioninitialized: (sessionId) => {
				sessions.set(sessionId, transport);
				log(`New MCP session ${sessionId} (${sessions.size} active)`);
			},
		});
		const server = await createMcpServer(runtime);
		await server.connect(transport);
		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
			}
		};

		return transport;
	}

	async function collectBody(req: IncomingMessage) {
		const chunks: Buffer[] = [];

		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}

		return Buffer.concat(chunks).toString();
	}

	function writeJson(res: ServerResponse, status: number, value: unknown) {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(value, null, 2));
	}

	const httpServer = createHttpServer(async (req, res) => {
		const requestStarted = Date.now();
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);

		try {
			if (url.pathname === "/health" && req.method === "GET") {
				writeJson(res, 200, {
					ok: true,
					uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
					workspaceRoot: runtime.workspace.root,
					dbPath: runtime.dbPath,
				});
				return;
			}

			if (url.pathname === "/status" && req.method === "GET") {
				writeJson(res, 200, await runtime.status());
				return;
			}

			if (
				(url.pathname === "/query" || url.pathname === "/search") &&
				req.method === "POST"
			) {
				const rawBody = await collectBody(req);
				const params = JSON.parse(rawBody) as SearchInput;
				writeJson(res, 200, await runtime.search(params));
				return;
			}

			if (url.pathname === "/mcp" && req.method === "POST") {
				const rawBody = await collectBody(req);
				const body = JSON.parse(rawBody);
				const headers: Record<string, string> = {};

				for (const [key, value] of Object.entries(req.headers)) {
					if (typeof value === "string") {
						headers[key] = value;
					}
				}

				const sessionId = headers["mcp-session-id"];
				let transport: WebStandardStreamableHTTPServerTransport;

				if (sessionId) {
					const existing = sessions.get(sessionId);

					if (!existing) {
						writeJson(res, 404, {
							jsonrpc: "2.0",
							error: { code: -32001, message: "Session not found" },
							id: body?.id ?? null,
						});
						return;
					}

					transport = existing;
				} else if (isInitializeRequest(body)) {
					transport = await createSession();
				} else {
					writeJson(res, 400, {
						jsonrpc: "2.0",
						error: { code: -32000, message: "Bad Request: Missing session ID" },
						id: body?.id ?? null,
					});
					return;
				}

				const request = new Request(`http://localhost:${port}${url.pathname}`, {
					method: "POST",
					headers,
					body: rawBody,
				});
				const response = await transport.handleRequest(request, { parsedBody: body });

				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
				log(`${req.method} ${url.pathname} ${Date.now() - requestStarted}ms`);
				return;
			}

			if (url.pathname === "/mcp") {
				const headers: Record<string, string> = {};

				for (const [key, value] of Object.entries(req.headers)) {
					if (typeof value === "string") {
						headers[key] = value;
					}
				}

				const sessionId = headers["mcp-session-id"];

				if (!sessionId) {
					writeJson(res, 400, {
						jsonrpc: "2.0",
						error: { code: -32000, message: "Bad Request: Missing session ID" },
						id: null,
					});
					return;
				}

				const transport = sessions.get(sessionId);

				if (!transport) {
					writeJson(res, 404, {
						jsonrpc: "2.0",
						error: { code: -32001, message: "Session not found" },
						id: null,
					});
					return;
				}

				const rawBody =
					req.method !== "GET" && req.method !== "HEAD"
						? await collectBody(req)
						: undefined;
				const request = new Request(`http://localhost:${port}${url.pathname}`, {
					method: req.method ?? "GET",
					headers,
					...(rawBody ? { body: rawBody } : {}),
				});
				const response = await transport.handleRequest(request);

				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		} catch (error) {
			writeJson(res, 500, {
				ok: false,
				error: errorMessage(error),
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, "localhost", resolve);
	});

	const address = httpServer.address();
	const actualPort = typeof address === "object" && address ? address.port : port;

	const stop = async () => {
		for (const transport of sessions.values()) {
			await transport.close();
		}
		sessions.clear();
		await runtime.close();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	};

	const shutdown = async () => {
		await stop();
		process.exit(0);
	};

	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	log(`Atlas Local MCP listening on http://localhost:${actualPort}/mcp`);
	log(`Workspace: ${runtime.workspace.root}`);
	log(`qmd SQLite: ${runtime.dbPath}`);

	return {
		port: actualPort,
		stop,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const runtime = new LocalAtlasRuntime({
		workspaceRoot: args.workspaceRoot,
		dbPath: args.dbPath,
	});

	if (args.mode === "stdio") {
		await startStdio(runtime);
		return;
	}

	if (args.mode === "index") {
		console.log(JSON.stringify(await runtime.index({ embed: args.embed }), null, 2));
		await runtime.close();
		return;
	}

	await startHttp(runtime, {
		port: args.port,
		quiet: args.quiet,
	});
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;

if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
