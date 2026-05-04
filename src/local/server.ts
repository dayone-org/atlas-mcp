import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
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
	type ExpandedQuery,
	type HybridQueryResult,
	type QMDStore,
	type SearchResult,
} from "@tobilu/qmd";
import { z } from "zod";
import {
	atlasPathFromQmdDisplayPath,
	LocalAtlasWorkspace,
	type AtlasGraph,
	type AtlasObject,
} from "./workspace.js";
import { ATLAS_SKILL_PROMPTS, AtlasSkillLibrary } from "./skill-library.js";

const DEFAULT_PORT = 8787;
const DEFAULT_COLLECTION = "atlas";

type SearchMode = "lex" | "vector" | "hybrid";

type SearchInput = {
	query?: string;
	searches?: ExpandedQuery[];
	mode?: SearchMode;
	limit?: number;
	minScore?: number;
	intent?: string;
	rerank?: boolean;
	refreshIndex?: boolean;
};

type RuntimeOptions = {
	workspaceRoot?: string;
	dbPath?: string;
	collectionName?: string;
	skillRoot?: string;
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

function textContent(text: string) {
	return {
		content: [
			{
				type: "text" as const,
				text,
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
		skillRoot?: string;
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

		if (arg === "--skill-dir") {
			result.skillRoot = args[++index];
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return result;
}

function formatInstructions(runtime: LocalAtlasRuntime) {
	return [
		"Atlas Local MCP is a local company-brain orchestration server.",
		`Workspace: ${runtime.workspace.root}`,
		`QMD collection: ${runtime.collectionName}`,
		"",
		"Use `atlas_search` for refreshed retrieval, `atlas_context` for exact reads, and `atlas_trace` for frontmatter graph context.",
		"Markdown files remain canonical. qmd is used only as the local retrieval index.",
		"Atlas workflow docs are served as MCP resources under atlas://skill/... and as workflow prompts such as atlas_ingest_workflow.",
		"Frontmatter is intentionally minimal: id, title, updated_at, optional owners, and optional relations (supersedes, supports, contradicts, depends_on, related_to). Lifecycle is derived from the graph and timestamps.",
	].join("\n");
}

function sourceQuery(input: SearchInput) {
	if (input.query) {
		return input.query;
	}

	return input.searches?.find((item) => item.type === "lex")?.query
		?? input.searches?.find((item) => item.type === "vec")?.query
		?? input.searches?.[0]?.query
		?? "";
}

function objectSummary(object: AtlasObject | undefined) {
	if (!object) {
		return undefined;
	}

	return {
		id: object.id ?? null,
		type: object.type ?? null,
		title: object.title,
		owners: object.owners,
		updatedAt: object.updatedAt ?? null,
		relationCount: object.relations.length,
	};
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
	const body = "bestChunk" in result ? result.bestChunk : ((result as SearchResult).body ?? "");
	const snippet = body
		? extractSnippet(body, query, 450, undefined, undefined).snippet
		: "";

	return {
		docid: `#${result.docid}`,
		path: atlasPath,
		qmdPath: displayPath,
		title: result.title,
		score: Math.round(result.score * 1000) / 1000,
		context: result.context,
		snippet,
		metadata: objectSummary(object),
	};
}

export class LocalAtlasRuntime {
	readonly workspace: LocalAtlasWorkspace;
	readonly collectionName: string;
	readonly dbPath: string;
	readonly skillRoot?: string;
	private storePromise?: Promise<QMDStore>;
	private skillLibraryPromise?: Promise<AtlasSkillLibrary | undefined>;

	constructor(options: RuntimeOptions = {}) {
		this.workspace = LocalAtlasWorkspace.fromEnv(options.workspaceRoot);
		this.collectionName = options.collectionName ?? process.env.ATLAS_QMD_COLLECTION ?? DEFAULT_COLLECTION;
		this.dbPath = this.workspace.dbPath(options.dbPath);
		this.skillRoot = options.skillRoot;
	}

	async getStore() {
		if (!this.storePromise) {
			await this.workspace.ensureReady();
			this.storePromise = createStore({
				dbPath: this.dbPath,
				config: {
					global_context:
						"Atlas local markdown company brain. Frontmatter carries id, title, updated_at, owners, and a small set of relations.",
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
							context:
								{
									"/": "Atlas markdown memory workspace.",
									"/clients": "Client and project-scoped Atlas memory.",
									"/sources": "Source markdown records.",
									"/knowledge": "Maintained knowledge objects.",
								},
						},
					},
				},
			});
		}

		return this.storePromise;
	}

	async getSkillLibrary() {
		if (!this.skillLibraryPromise) {
			this.skillLibraryPromise = AtlasSkillLibrary.discover({
				workspaceRoot: this.workspace.root,
				explicitRoot: this.skillRoot,
			});
		}

		return this.skillLibraryPromise;
	}

	async close() {
		if (!this.storePromise) {
			return;
		}

		const store = await this.storePromise;
		await store.close();
		this.storePromise = undefined;
	}

	async index(options?: { embed?: boolean; forceEmbed?: boolean }) {
		const store = await this.getStore();
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

	async status(options: { refreshIndex?: boolean } = {}) {
		const refreshed = options.refreshIndex ? await this.index() : undefined;
		const store = await this.getStore();
		const [qmd, graph, health, skillLibrary] = await Promise.all([
			store.getStatus(),
			this.workspace.buildGraph(),
			this.workspace.healthCheck(),
			this.getSkillLibrary(),
		]);

		return {
			ok: true,
			workspaceRoot: this.workspace.root,
			dbPath: this.dbPath,
			collection: this.collectionName,
			...(refreshed ? { refreshedIndex: refreshed.update } : {}),
			qmd,
			graph: graph.summary,
			health: {
				ok: health.ok,
				issueCount: health.issues.length,
				errorCount: health.issues.filter((issue) => issue.severity === "error").length,
				warningCount: health.issues.filter((issue) => issue.severity === "warning").length,
			},
			skill: skillLibrary
				? {
						root: skillLibrary.root,
						resources: skillLibrary.resources.length,
						prompts: ATLAS_SKILL_PROMPTS,
					}
				: null,
		};
	}

	async search(input: SearchInput) {
		const refreshed = input.refreshIndex === false ? undefined : await this.index();
		const store = await this.getStore();
		const graph = await this.workspace.buildGraph();
		const limit = input.limit ?? 10;
		const mode = input.mode ?? (input.searches ? "hybrid" : "lex");
		const query = sourceQuery(input);

		if (!query && !input.searches) {
			throw new Error("search requires either query or searches.");
		}

		const results =
			mode === "lex"
				? await store.searchLex(query, {
						limit,
						collection: this.collectionName,
					})
				: mode === "vector"
					? await store.searchVector(query, {
							limit,
							collection: this.collectionName,
						})
					: await store.search({
							...(input.searches ? { queries: input.searches } : { query }),
							collections: [this.collectionName],
							limit,
							minScore: input.minScore ?? 0,
							intent: input.intent,
							rerank: input.rerank ?? false,
							chunkStrategy: "regex",
						});

		return {
			ok: true,
			mode,
			query,
			...(refreshed ? { refreshedIndex: refreshed.update } : {}),
			results: results.map((result) => formatSearchResult(result, graph, this.collectionName, query)),
			graphWarnings: graph.warnings,
		};
	}
}

function sourcePatchWarning(paths: string[]) {
	const touchesSource = paths.some((workspacePath) => workspacePath.includes("/sources/"));
	const touchesKnowledge = paths.some((workspacePath) => workspacePath.includes("/knowledge/"));

	if (!touchesSource || touchesKnowledge) {
		return undefined;
	}

	return {
		severity: "warning" as const,
		type: "source_without_knowledge_update",
		message:
			"Patch touches sources/ but no knowledge/ page. For source ingest, Atlas is incomplete until at least one knowledge page is created or updated.",
	};
}

function sourceUploadWarning(workspacePath: string) {
	if (!workspacePath.includes("/sources/")) {
		return undefined;
	}

	return {
		severity: "warning" as const,
		type: "source_upload_requires_knowledge_update",
		message:
			"File uploaded under sources/. Source ingest is incomplete until a source markdown record and at least one knowledge page are created or updated.",
	};
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

	const skillLibrary = await runtime.getSkillLibrary();

	if (skillLibrary) {
		for (const resource of skillLibrary.resources) {
			server.registerResource(
				resource.name,
				resource.uri,
				{
					title: resource.title,
					description: `Atlas skill workflow document: ${resource.relativePath}`,
					mimeType: resource.mimeType,
					size: await skillLibrary.resourceSize(resource.relativePath),
				},
				async (uri) => ({
					contents: [
						{
							uri: uri.toString(),
							mimeType: resource.mimeType,
							text: await skillLibrary.read(skillLibrary.resolveResourceUri(uri)),
						},
					],
				}),
			);
		}

		for (const promptName of ATLAS_SKILL_PROMPTS) {
			server.registerPrompt(
				promptName,
				{
					title: promptName.replace(/_/g, " ").replace(/\b\w/g, (value) => value.toUpperCase()),
					description:
						"Client-orchestrated Atlas workflow prompt served from the canonical Atlas skill.",
					argsSchema: {
						scope: z.string().optional(),
					},
				},
				async ({ scope }) => ({
					description:
						"Follow this Atlas workflow using Atlas MCP as deterministic memory tooling.",
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: await skillLibrary.readPrompt(promptName, scope),
							},
						},
					],
				}),
			);
		}
	}

	server.registerTool(
		"atlas_status",
		{
			description:
				"Show local Atlas workspace, qmd index, graph, health, and served skill status. Set refreshIndex=true after out-of-band file changes.",
			inputSchema: {
				refreshIndex: z.boolean().default(false),
			},
		},
		async ({ refreshIndex }) => jsonContent(await runtime.status({ refreshIndex })),
	);

	server.registerTool(
		"atlas_search",
		{
			description:
				"Refresh and search Atlas markdown locally via qmd. Default mode is lex for fast BM25; use hybrid/vector after embeddings are available.",
			inputSchema: {
				query: z.string().optional(),
				searches: z
					.array(
						z.object({
							type: z.enum(["lex", "vec", "hyde"]),
							query: z.string().min(1),
						}),
					)
					.optional(),
				mode: z.enum(["lex", "vector", "hybrid"]).default("lex"),
				limit: z.number().int().min(1).max(50).default(10),
				minScore: z.number().min(0).max(1).default(0),
				intent: z.string().optional(),
				rerank: z.boolean().default(false),
				refreshIndex: z.boolean().default(true),
			},
		},
		async (input) => jsonContent(await runtime.search(input)),
	);

	server.registerTool(
		"atlas_context",
		{
			description:
				"Hydrate a project scope, read exact Atlas paths, or list a workspace directory. A singular path ending in .md is treated as an exact file read.",
			inputSchema: {
				path: z.string().optional(),
				paths: z.array(z.string()).min(1).max(50).optional(),
				listPath: z.string().optional(),
			},
		},
		async ({ path: workspacePath, paths, listPath }) => {
			if (workspacePath && !paths && !listPath) {
				if (workspacePath.endsWith(".md")) {
					return jsonContent({
						ok: true,
						files: await runtime.workspace.readMany([workspacePath]),
					});
				}

				return jsonContent(await runtime.workspace.projectContext(workspacePath));
			}

			const result: Record<string, unknown> = {
				ok: true,
			};

			if (workspacePath) {
				result.project = await runtime.workspace.projectContext(workspacePath);
			}

			if (paths) {
				result.files = await runtime.workspace.readMany(paths);
			}

			result.listing = await runtime.workspace.list(listPath ?? "/");

			return jsonContent(result);
		},
	);

	server.registerTool(
		"atlas_trace",
		{
			description:
				"Trace Atlas frontmatter graph relations (supersedes, supports, contradicts, depends_on, related_to) and owners from an Atlas ID or markdown path.",
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
				"Lint local Atlas memory for broken relationships, frontmatter parse errors, and missing required fields (id, title, updated_at).",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.workspace.healthCheck()),
	);

	server.registerTool(
		"atlas_upload_file",
		{
			description:
				"Copy a local filesystem file directly into the Atlas workspace. localPath must be absolute. Use for original binary artifacts; do not base64-encode files in prompts or patches.",
			inputSchema: {
				localPath: z.string().min(1),
				path: z.string().min(1),
				overwrite: z.boolean().default(false),
				indexAfterUpload: z.boolean().default(true),
			},
		},
		async ({ localPath, path: workspacePath, overwrite, indexAfterUpload }) => {
			const upload = await runtime.workspace.uploadFile(localPath, workspacePath, { overwrite });
			const index = indexAfterUpload ? await runtime.index() : undefined;
			const warning = sourceUploadWarning(upload.path);

			return jsonContent({
				...upload,
				...(index ? { index: index.update } : {}),
				...(warning ? { warnings: [warning] } : {}),
			});
		},
	);

	server.registerTool(
		"atlas_apply_patch",
		{
			description:
				"Apply a text patch to local Atlas memory. The patch is staged and validated before files are written; successful writes re-index by default.",
			inputSchema: z
				.object({
					input: z.string().min(1),
					indexAfterWrite: z.boolean().default(true),
				})
				.strict(),
		},
		async ({ input, indexAfterWrite }) => {
			const patch = await runtime.workspace.applyTextPatch(input);
			const index = indexAfterWrite ? await runtime.index() : undefined;
			const warning = sourcePatchWarning(patch.touched);

			return jsonContent({
				...patch,
				...(index ? { index: index.update } : {}),
				...(warning ? { warnings: [warning] } : {}),
			});
		},
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

			if ((url.pathname === "/query" || url.pathname === "/search") && req.method === "POST") {
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

				const rawBody = req.method !== "GET" && req.method !== "HEAD" ? await collectBody(req) : undefined;
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
		skillRoot: args.skillRoot,
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
