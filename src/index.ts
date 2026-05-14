import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import YAML from "yaml";
import { z } from "zod";

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const PROJECT_CORE_FILE_NAMES = ["_project.md", "_state.md", "_index.md"] as const;
const PROJECT_CORE_FILE_NAME_SET = new Set<string>(PROJECT_CORE_FILE_NAMES);

type AiSearchChunk = {
	id: string;
	type?: string;
	score: number;
	text?: string;
	item?: {
		key?: string;
		timestamp?: number;
		metadata?: Record<string, unknown>;
	};
	scoring_details?: Record<string, unknown>;
};

type AiSearchResult = {
	search_query?: string;
	chunks?: AiSearchChunk[];
};

type AiSearchInstanceBinding = {
	search(input: Record<string, unknown>): Promise<AiSearchResult>;
	info(): Promise<unknown>;
	stats(): Promise<unknown>;
};

type AtlasCoreRole = "atlas" | "client" | "project" | "state" | "index";

type ProjectScope = {
	client: string;
	project: string;
};

type AtlasRelation = {
	target: string;
};

type AtlasObject = {
	path: string;
	id?: string;
	type?: string;
	title: string;
	sources: string[];
	updatedAt?: string;
	relations: AtlasRelation[];
	hasFrontmatter: boolean;
	frontmatterError?: string;
};

type AtlasEdge = {
	from: string;
	to: string;
	type: string;
	kind: "relation";
	resolved: boolean;
	sourcePath: string;
	targetPath?: string;
};

type AtlasHealthIssue = {
	severity: "info" | "warning" | "error";
	type: string;
	path: string;
	id?: string;
	message: string;
};

type AtlasGraph = {
	objects: AtlasObject[];
	edges: AtlasEdge[];
	byId: Map<string, AtlasObject>;
	byPath: Map<string, AtlasObject>;
	warnings: AtlasHealthIssue[];
	summary: {
		files: number;
		typedObjects: number;
		ids: number;
		edges: number;
		unresolvedEdges: number;
	};
};

type AtlasFrontmatterInput = {
	id: string;
	title: string;
	updated_at?: string;
	sources?: string[];
	relations?: string[];
};

type AtlasAccessEvent = {
	path: string;
	nodeId: string;
	source: string;
	timestamp: string;
};

type AtlasWorkerEnv = Env & {
	ATLAS_ACCESS_EVENTS_ENABLED?: string;
	ATLAS_ACCESS_EVENTS_TOKEN?: string;
	ATLAS_ACCESS_HUB: DurableObjectNamespace;
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

function atlasNodeIdForPath(path: string) {
	return `atlas/${normalizeFilePath(path)}`;
}

function accessEventsEnabled(env: Env) {
	return (env as AtlasWorkerEnv).ATLAS_ACCESS_EVENTS_ENABLED === "true";
}

function accessEventsToken(env: Env) {
	return (env as AtlasWorkerEnv).ATLAS_ACCESS_EVENTS_TOKEN?.trim();
}

function accessHub(env: Env) {
	return (env as AtlasWorkerEnv).ATLAS_ACCESS_HUB.getByName("global");
}

function isAuthorizedAccessEventRequest(request: Request, env: Env) {
	const configuredToken = accessEventsToken(env);
	const url = new URL(request.url);
	const queryToken = url.searchParams.get("access_token")?.trim();

	if (configuredToken && queryToken === configuredToken) {
		return true;
	}

	if (apiKeyIsConfigured(env) && requireApiKey(request, env)) {
		return true;
	}

	return !configuredToken && !apiKeyIsConfigured(env);
}

async function maybeEmitAccess(env: Env, path: string, source: string) {
	if (!accessEventsEnabled(env)) return;

	try {
		const normalizedPath = normalizeFilePath(path);
		const event: AtlasAccessEvent = {
			path: normalizedPath,
			nodeId: atlasNodeIdForPath(normalizedPath),
			source,
			timestamp: nowIso(),
		};

		await accessHub(env).fetch("https://atlas-access-hub.local/record", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(event),
		});
	} catch (error) {
		console.warn("Failed to emit Atlas access event", error);
	}
}

async function maybeEmitManyAccesses(env: Env, paths: string[], source: string) {
	const uniquePaths = [...new Set(paths.filter((path) => path.endsWith(".md")))];
	await Promise.all(uniquePaths.map((path) => maybeEmitAccess(env, path, source)));
}

function getAiSearch(env: Env) {
	const binding = (env as Env & { ATLAS_SEARCH?: AiSearchInstanceBinding }).ATLAS_SEARCH;

	if (!binding) {
		throw new Error("ATLAS_SEARCH binding is not configured.");
	}

	return binding;
}

export class AtlasAccessHub {
	private readonly sseClients = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();
	private readonly textEncoder = new TextEncoder();

	constructor(
		private readonly state: DurableObjectState,
		private readonly env: AtlasWorkerEnv,
	) {}

	async fetch(request: Request) {
		const url = new URL(request.url);

			if (url.pathname === "/record" && request.method === "POST") {
				const event = await request.json() as AtlasAccessEvent;
				this.broadcast({ type: "atlas_access", event });
				return Response.json({ ok: true });
			}

		if (url.pathname === "/sse" && request.method === "GET") {
			if (!accessEventsEnabled(this.env)) {
				return new Response("Atlas access events are disabled.", { status: 404 });
			}

			const clientId = crypto.randomUUID();
			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
			const writer = writable.getWriter();
			this.sseClients.set(clientId, writer);
			writer.write(this.encodeSse("atlas_access_ready", {
				enabled: true,
				timestamp: nowIso(),
			})).catch(() => {
				this.sseClients.delete(clientId);
			});

			request.signal.addEventListener("abort", () => {
				this.sseClients.delete(clientId);
				writer.close().catch(() => {});
			});

			return new Response(readable, {
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					"connection": "keep-alive",
				},
			});
		}

		if (url.pathname === "/ws" && request.method === "GET") {
			if (!accessEventsEnabled(this.env)) {
				return new Response("Atlas access events are disabled.", { status: 404 });
			}

			const upgrade = request.headers.get("Upgrade");
			if (upgrade !== "websocket") {
				return new Response("Expected WebSocket upgrade.", { status: 426 });
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
			this.state.acceptWebSocket(server);
			server.send(JSON.stringify({
				type: "atlas_access_ready",
				enabled: true,
				timestamp: nowIso(),
			}));

			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response("Not found", { status: 404 });
	}

	webSocketMessage(ws: WebSocket) {
		ws.send(JSON.stringify({ type: "atlas_access_pong", timestamp: nowIso() }));
	}

	private encodeSse(event: string, data: unknown) {
		return this.textEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

		private broadcast(message: unknown) {
			const payload = JSON.stringify(message);

		for (const socket of this.state.getWebSockets()) {
			try {
				socket.send(payload);
			} catch {
				socket.close(1011, "Failed to send Atlas access event.");
			}
			}

			const ssePayload = this.encodeSse("atlas_access", message);
			for (const [clientId, writer] of this.sseClients) {
				writer.write(ssePayload).catch(() => {
					this.sseClients.delete(clientId);
					writer.close().catch(() => {});
				});
			}
		}
	}

function hasControlCharacter(value: string) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);

		if (code <= 31 || code === 127) {
			return true;
		}
	}

	return false;
}

function normalizePath(
	input: string,
	{
		allowRoot = false,
		allowTrailingSlash = false,
	}: { allowRoot?: boolean; allowTrailingSlash?: boolean } = {},
) {
	const value = input === "" ? "/" : input;

	if (value.trim() !== value) {
		throw new Error("Path must not contain leading or trailing whitespace.");
	}

	if (hasControlCharacter(value)) {
		throw new Error("Path must not contain control characters.");
	}

	if (value.includes("\\")) {
		throw new Error("Use forward slashes in Atlas paths.");
	}

	const withoutLeadingSlash = value.replace(/^\/+/, "");
	const isRoot = withoutLeadingSlash === "" || /^\/+$/.test(value);

	if (isRoot) {
		if (allowRoot) {
			return "";
		}

		throw new Error("Path must not be the workspace root.");
	}

	if (!allowTrailingSlash && /\/+$/.test(withoutLeadingSlash)) {
		throw new Error("File paths must not end with a slash.");
	}

	const normalized = withoutLeadingSlash.replace(/\/+$/, "");

	if (normalized.includes("//")) {
		throw new Error("Path must not contain empty segments.");
	}

	const parts = normalized.split("/");

	for (const part of parts) {
		if (part === "" || part === "." || part === "..") {
			throw new Error(`Unsafe path segment: ${part || "(empty)"}`);
		}
	}

	return parts.join("/");
}

function normalizeFilePath(input: string) {
	return normalizePath(input);
}

function normalizeDirectoryPath(input: string) {
	return normalizePath(input, { allowTrailingSlash: true });
}

function basename(input: string) {
	const parts = input.split("/");
	return parts[parts.length - 1] ?? input;
}

function dirnamePosix(input: string) {
	return input.includes("/") ? input.slice(0, input.lastIndexOf("/")) : "";
}

function withoutMarkdownExtension(input: string) {
	return input.replace(/\.md$/i, "");
}

function nowIso() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function slugify(value: string, label: string) {
	const slug = value
		.trim()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	if (!slug) {
		throw new Error(`${label} must contain at least one slug character.`);
	}

	if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
		throw new Error(`${label} produced an invalid slug: ${slug}`);
	}

	return slug;
}

function scalar(value: unknown) {
	if (typeof value === "string") {
		return value.trim() || undefined;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	return undefined;
}

function stringArray(value: unknown) {
	if (!Array.isArray(value)) {
		const single = scalar(value);
		return single ? [single] : [];
	}

	return value.map((item) => scalar(item)).filter((item): item is string => Boolean(item));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

function parseRelations(value: unknown): AtlasRelation[] {
	return stringArray(value).map((target) => ({ target }));
}

function targetLooksLikeAtlasId(value: string) {
	return /^[a-z][a-z0-9_]*:[^\s]+$/i.test(value);
}

function validateRelationTargets(relations: string[]) {
	const invalidTargets = relations.filter(
		(target) => !targetLooksLikePath(target) && !targetLooksLikeAtlasId(target),
	);

	if (invalidTargets.length > 0) {
		throw new Error(
			`Invalid Atlas relation target(s): ${invalidTargets.join(", ")}. Relations must be resolvable .md paths or existing Atlas IDs; bare slugs are not valid.`,
		);
	}
}

function typeFromId(id: string | undefined) {
	const match = id?.match(/^([a-z][a-z0-9_]*):/i);
	return match ? match[1] : undefined;
}

function titleFromBody(body: string, filePath: string) {
	const match = body.match(/^#\s+(.+)$/m) ?? body.match(/^##\s+(.+)$/m);

	if (match?.[1]) {
		return match[1].trim();
	}

	return basename(filePath).replace(/\.md$/i, "");
}

function extractFrontmatter(content: string) {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	if (!normalized.startsWith("---\n")) {
		return {
			hasFrontmatter: false,
			body: content,
		};
	}

	const end = normalized.indexOf("\n---\n", 4);

	if (end === -1) {
		return {
			hasFrontmatter: true,
			body: content,
			error: "Frontmatter starts with --- but has no closing ---.",
		};
	}

	const raw = normalized.slice(4, end);
	const body = normalized.slice(end + "\n---\n".length);

	try {
		const parsed = YAML.parse(raw);

		return {
			hasFrontmatter: true,
			body,
			frontmatter: objectRecord(parsed) ?? {},
		};
	} catch (error) {
		return {
			hasFrontmatter: true,
			body,
			error: errorMessage(error),
		};
	}
}

function parseMarkdownObject(content: string, fallbackPath: string) {
	const parsed = extractFrontmatter(content);
	const frontmatter = parsed.frontmatter ?? {};
	return {
		parsed,
		frontmatter,
		body: parsed.body,
		title: scalar(frontmatter.title) ?? titleFromBody(parsed.body, fallbackPath),
		sources: stringArray(frontmatter.sources),
		relations: stringArray(frontmatter.relations),
		updatedAt: scalar(frontmatter.updated_at ?? frontmatter.updatedAt),
	};
}

function renderFrontmatter(input: AtlasFrontmatterInput) {
	const frontmatter: Record<string, unknown> = {
		id: input.id,
		title: input.title,
		updated_at: input.updated_at ?? nowIso(),
	};

	if (input.sources && input.sources.length > 0) {
		frontmatter.sources = [
			...new Set(input.sources.map((item) => item.trim()).filter(Boolean)),
		];
	}

	if (input.relations && input.relations.length > 0) {
		const relations = [
			...new Set(input.relations.map((item) => item.trim()).filter(Boolean)),
		];
		validateRelationTargets(relations);
		frontmatter.relations = relations;
	}

	return YAML.stringify(frontmatter).trimEnd();
}

function renderMarkdownObject(frontmatter: AtlasFrontmatterInput, body: string) {
	const normalizedBody = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${normalizedBody}\n`;
}

function ensureTrailingNewline(content: string) {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function listItemForLink(title: string, linkTarget: string, summary?: string) {
	const suffix = summary?.trim() ? ` - ${summary.trim()}` : "";
	return `- [${title}](${linkTarget})${suffix}`;
}

function findHeadingRange(lines: string[], heading: string) {
	const headingIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);

	if (headingIndex === -1) {
		return undefined;
	}

	let endIndex = lines.length;

	for (let index = headingIndex + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index])) {
			endIndex = index;
			break;
		}
	}

	return { headingIndex, endIndex };
}

function upsertHeadingListLink(body: string, heading: string, linkTarget: string, line: string) {
	const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const range = findHeadingRange(lines, heading);

	if (!range) {
		const trimmed = body.trimEnd();
		return `${trimmed}${trimmed ? "\n\n" : ""}## ${heading}\n\n${line}\n`;
	}

	const before = lines.slice(0, range.headingIndex + 1);
	const section = lines
		.slice(range.headingIndex + 1, range.endIndex)
		.filter((sectionLine) => !sectionLine.includes(`](${linkTarget})`))
		.filter((sectionLine) => sectionLine.trim() !== "_No projects yet._")
		.filter((sectionLine) => sectionLine.trim() !== "_No clients yet._");
	const after = lines.slice(range.endIndex);

	while (section.length > 0 && section[0].trim() === "") {
		section.shift();
	}

	while (section.length > 0 && section[section.length - 1].trim() === "") {
		section.pop();
	}

	return ensureTrailingNewline(
		[...before, "", ...section, line, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n"),
	);
}

function removeHeadingListLink(
	body: string,
	heading: string,
	linkTarget: string,
	emptyText: string,
) {
	const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const range = findHeadingRange(lines, heading);

	if (!range) {
		return ensureTrailingNewline(body);
	}

	const before = lines.slice(0, range.headingIndex + 1);
	const kept = lines
		.slice(range.headingIndex + 1, range.endIndex)
		.filter((sectionLine) => !sectionLine.includes(`](${linkTarget})`));
	const after = lines.slice(range.endIndex);
	const linkLines = kept.filter((sectionLine) => /^\s*-\s+\[/.test(sectionLine));
	const section = linkLines.length > 0 ? ["", ...kept, ""] : ["", emptyText, ""];

	return ensureTrailingNewline(
		[...before, ...section, ...after].join("\n").replace(/\n{3,}/g, "\n\n"),
	);
}

function upsertIndexEntryBody(
	body: string,
	pathTarget: string,
	title: string,
	kind?: string,
	summary?: string,
) {
	const entry = `- [${title}](${pathTarget}) - ${kind?.trim() || "knowledge"} - ${summary?.trim() || "Knowledge page."}`;
	return upsertHeadingListLink(body, "Knowledge Pages", pathTarget, entry);
}

function removeIndexEntryBody(body: string, pathTarget: string) {
	return removeHeadingListLink(body, "Knowledge Pages", pathTarget, "_No knowledge pages yet._");
}

function targetLooksLikePath(value: string) {
	return (
		value.endsWith(".md") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("/") ||
		value.includes("/")
	);
}

function joinRelativePath(basePath: string, target: string) {
	const stack = dirnamePosix(basePath).split("/").filter(Boolean);

	for (const segment of target.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}

		if (segment === "..") {
			if (stack.length === 0) {
				return undefined;
			}
			stack.pop();
			continue;
		}

		stack.push(segment);
	}

	return stack.join("/");
}

function projectRootForPath(sourcePath: string) {
	const match = sourcePath.match(/^(clients\/[^/]+\/projects\/[^/]+)\//);
	return match?.[1];
}

function isProjectRelativePath(target: string) {
	return !target.includes("/") || PROJECT_CORE_FILE_NAME_SET.has(target);
}

function normalizeAtlasReferencePath(target: string, sourcePath: string) {
	if (target.startsWith("/")) {
		return normalizePath(target, { allowRoot: true });
	}

	if (target.startsWith("./") || target.startsWith("../")) {
		return joinRelativePath(sourcePath, target);
	}

	if (target.startsWith("clients/") || target === "_atlas.md") {
		return normalizePath(target, { allowRoot: true });
	}

	const projectRoot = projectRootForPath(sourcePath);

	if (projectRoot && isProjectRelativePath(target)) {
		return normalizePath(`${projectRoot}/${target}`, { allowRoot: true });
	}

	return normalizePath(target, { allowRoot: true });
}

function markdownLinkTargets(content: string) {
	return new Set(
		[...content.matchAll(/\]\(([^)]+)\)/g)].map((match) => (match[1] ?? "").split("#", 1)[0]),
	);
}

function requiredFrontmatterFields(object: AtlasObject) {
	const missing: string[] = [];

	if (!object.id) {
		missing.push("id");
	}

	if (!object.title) {
		missing.push("title");
	}

	if (!object.updatedAt) {
		missing.push("updated_at");
	}

	return missing;
}

function makeIssue(
	severity: AtlasHealthIssue["severity"],
	type: string,
	object: Pick<AtlasObject, "path" | "id">,
	message: string,
): AtlasHealthIssue {
	return {
		severity,
		type,
		path: object.path,
		...(object.id ? { id: object.id } : {}),
		message,
	};
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

function folderUpperBound(prefix: string) {
	return `${prefix.replace(/\/$/, "")}0`;
}

function snippetFromText(text: string | undefined, query: string) {
	if (!text) {
		return "";
	}

	const compact = text.replace(/\s+/g, " ").trim();
	const firstTerm = query.split(/\s+/).find(Boolean)?.toLowerCase();

	if (!firstTerm) {
		return compact.slice(0, 450);
	}

	const index = compact.toLowerCase().indexOf(firstTerm);

	if (index === -1) {
		return compact.slice(0, 450);
	}

	const start = Math.max(0, index - 180);
	return compact.slice(start, start + 450);
}

class R2AtlasWorkspace {
	constructor(readonly bucket: R2Bucket) {}

	clientSlug(input: string) {
		return slugify(input, "client");
	}

	projectSlug(input: string) {
		return slugify(input, "project");
	}

	objectSlug(input: string) {
		return slugify(withoutMarkdownExtension(input), "slug");
	}

	clientDirectory(client: string) {
		return `clients/${this.clientSlug(client)}`;
	}

	clientFile(client: string) {
		return `${this.clientDirectory(client)}/_client.md`;
	}

	projectDirectory(scope: ProjectScope) {
		return `${this.clientDirectory(scope.client)}/projects/${this.projectSlug(scope.project)}`;
	}

	projectFile(scope: ProjectScope) {
		return `${this.projectDirectory(scope)}/_project.md`;
	}

	stateFile(scope: ProjectScope) {
		return `${this.projectDirectory(scope)}/_state.md`;
	}

	indexFile(scope: ProjectScope) {
		return `${this.projectDirectory(scope)}/_index.md`;
	}

	knowledgeFile(scope: ProjectScope, slug: string) {
		return `${this.projectDirectory(scope)}/${this.objectSlug(slug)}.md`;
	}

	private normalizeScope(input: { client?: string; project?: string }) {
		return {
			...(input.client ? { client: this.clientSlug(input.client) } : {}),
			...(input.project ? { project: this.projectSlug(input.project) } : {}),
		};
	}

	private requireScopeForRole(role: AtlasCoreRole, input: { client?: string; project?: string }) {
		const scope = this.normalizeScope(input);

		if (role === "client" && !scope.client) {
			throw new Error("client is required for client core files.");
		}

		if (["project", "state", "index"].includes(role)) {
			if (!scope.client || !scope.project) {
				throw new Error(`${role} core files require client and project.`);
			}
		}

		return scope;
	}

	private coreFile(role: AtlasCoreRole, input: { client?: string; project?: string }) {
		const scope = this.requireScopeForRole(role, input);

		if (role === "atlas") {
			return "_atlas.md";
		}

		if (role === "client") {
			return this.clientFile(scope.client!);
		}

		const projectScope = { client: scope.client!, project: scope.project! };

		if (role === "project") {
			return this.projectFile(projectScope);
		}

		if (role === "state") {
			return this.stateFile(projectScope);
		}

		if (role === "index") {
			return this.indexFile(projectScope);
		}

		throw new Error(`Unsupported Atlas core role: ${role}.`);
	}

	private defaultCoreTitle(role: AtlasCoreRole, input: { client?: string; project?: string }) {
		const scope = this.requireScopeForRole(role, input);

		if (role === "atlas") {
			return "DAYONE Knowledge";
		}

		if (role === "client") {
			return scope.client!;
		}

		const project = scope.project!;

		if (role === "state") {
			return `Live State - ${project}`;
		}

		if (role === "index") {
			return `Index - ${project}`;
		}

		return project;
	}

	private defaultCoreId(role: AtlasCoreRole, input: { client?: string; project?: string }) {
		const scope = this.requireScopeForRole(role, input);

		if (role === "atlas") {
			return "atlas:root";
		}

		if (role === "client") {
			return `client:${scope.client}`;
		}

		return `${role}:${scope.client}-${scope.project}`;
	}

	private defaultCoreBody(role: AtlasCoreRole, title: string) {
		if (role === "atlas") {
			return "# DAYONE Knowledge\n\n## Context\n\nDAYONE company knowledge.\n\n## Clients\n\n_No clients yet._\n";
		}

		if (role === "client") {
			return `# ${title} Context\n\n## Context\n\nDAYONE relationship context for ${title}.\n\n## Projects\n\n_No projects yet._\n`;
		}

		if (role === "project") {
			return [
				`# ${title} Context`,
				"",
				"## Context",
				"",
				`Stable DAYONE project context for ${title}.`,
				"",
				"## State",
				"",
				"- [_state](_state.md)",
				"",
				"## Index",
				"",
				"- [_index](_index.md)",
				"",
			].join("\n");
		}

		if (role === "state") {
			return `# ${title.replace(/^Live State - /, "")} State\n\nCurrent operating state has not been captured yet.\n\n## Project\n\n- [_project](_project.md)\n`;
		}

		if (role === "index") {
			return `# ${title.replace(/^Index - /, "")} Index\n\n## Core Files\n\n- [_project](_project.md) - stable project context\n- [_state](_state.md) - live operating state\n\n## Knowledge Pages\n\n_No knowledge pages yet._\n`;
		}

		throw new Error(`Unsupported Atlas core role: ${role}.`);
	}

	private defaultCoreRelations(role: AtlasCoreRole) {
		if (role === "project") {
			return ["_state.md", "_index.md"];
		}

		if (role === "state") {
			return ["_project.md"];
		}

		if (role === "index") {
			return ["_project.md", "_state.md"];
		}

		return [];
	}

	async readText(path: string) {
		const key = normalizeFilePath(path);
		const object = await this.bucket.get(key);

		if (!object) {
			throw new Error(`${key} does not exist.`);
		}

		if (object.size > MAX_TEXT_FILE_BYTES) {
			throw new Error(`${key} is too large to read as text (${object.size} bytes).`);
		}

		return object.text();
	}

	async readOptionalText(path: string) {
		const key = normalizeFilePath(path);
		const object = await this.bucket.get(key);

		if (!object) {
			return undefined;
		}

		if (object.size > MAX_TEXT_FILE_BYTES) {
			throw new Error(`${key} is too large to read as text (${object.size} bytes).`);
		}

		return object.text();
	}

	async readTextResult(path: string) {
		let key: string;

		try {
			key = normalizeFilePath(path);
		} catch (error) {
			return {
				ok: false as const,
				path,
				error: errorMessage(error),
			};
		}

		try {
			return {
				ok: true as const,
				path: key,
				content: await this.readText(key),
			};
		} catch (error) {
			return {
				ok: false as const,
				path: key,
				error: errorMessage(error),
			};
		}
	}

	async readMany(paths: string[]) {
		return Promise.all(paths.map((path) => this.readTextResult(path)));
	}

	private async writeText(path: string, content: string, options?: { overwrite?: boolean }) {
		const key = normalizeFilePath(path);
		const bytes = new TextEncoder().encode(content).byteLength;

		if (bytes > MAX_TEXT_FILE_BYTES) {
			throw new Error(`${key} is too large for text writing.`);
		}

		if (!options?.overwrite && (await this.bucket.head(key))) {
			throw new Error(`${key} already exists. Pass overwrite: true to replace it.`);
		}

		await this.bucket.put(key, content, {
			httpMetadata: {
				contentType: "text/markdown; charset=utf-8",
			},
		});

		return {
			ok: true,
			path: key,
			bytes,
			overwritten: Boolean(options?.overwrite),
		};
	}

	private async deleteFile(path: string) {
		const key = normalizeFilePath(path);
		const existing = await this.bucket.head(key);

		if (!existing) {
			throw new Error(`${key} does not exist.`);
		}

		await this.bucket.delete(key);

		return {
			ok: true,
			path: key,
			deleted: true,
			bytes: existing.size,
		};
	}

	private async writeMarkdownObject(
		path: string,
		frontmatter: AtlasFrontmatterInput,
		body: string,
	) {
		return this.writeText(path, renderMarkdownObject(frontmatter, body), { overwrite: true });
	}

	private async createMarkdownObject(
		path: string,
		frontmatter: AtlasFrontmatterInput,
		body: string,
	) {
		return this.writeText(path, renderMarkdownObject(frontmatter, body), { overwrite: false });
	}

	async list(path = "/") {
		const directory = normalizePath(path, { allowRoot: true, allowTrailingSlash: true });
		const prefix = directory ? `${directory}/` : "";
		const directories = new Map<string, { type: "directory"; name: string; path: string }>();
		const files = new Map<
			string,
			{ type: "file"; name: string; path: string; size: number; uploaded: string }
		>();
		let cursor: string | undefined;

		do {
			const result = await this.bucket.list({
				prefix,
				cursor,
				limit: 1000,
				delimiter: "/",
			});

			for (const delimitedPrefix of result.delimitedPrefixes) {
				const entryPath = delimitedPrefix.replace(/\/$/, "");
				directories.set(entryPath, {
					type: "directory",
					name: basename(entryPath),
					path: entryPath,
				});
			}

			for (const object of result.objects) {
				files.set(object.key, {
					type: "file",
					name: basename(object.key),
					path: object.key,
					size: object.size,
					uploaded: object.uploaded.toISOString(),
				});
			}

			cursor = result.truncated ? result.cursor : undefined;
		} while (cursor);

		return {
			path: directory,
			exists: directories.size > 0 || files.size > 0,
			entries: [...directories.values(), ...files.values()].sort((left, right) =>
				left.name.localeCompare(right.name),
			),
		};
	}

	async projectContext(path: string) {
		const projectPath = normalizeDirectoryPath(path);
		const [coreFiles, projectListing] = await Promise.all([
			Promise.all(
				PROJECT_CORE_FILE_NAMES.map(async (name) => {
					const filePath = `${projectPath}/${name}`;
					const result = await this.readTextResult(filePath);

					if (!result.ok && /does not exist/i.test(result.error)) {
						return undefined;
					}

					return {
						...result,
						name,
					};
				}),
			),
			this.list(projectPath),
		]);

		return {
			ok: true,
			path: projectPath,
			coreFiles: coreFiles.filter((file) => file !== undefined),
			pages: {
				...projectListing,
				entries: projectListing.entries.filter(
					(entry) =>
						entry.type === "file" &&
						entry.name.endsWith(".md") &&
						!PROJECT_CORE_FILE_NAME_SET.has(entry.name),
				),
			},
		};
	}

	async readAtlasObject(path: string): Promise<AtlasObject> {
		const normalized = normalizeFilePath(path);
		const content = await this.readText(normalized);
		const parsed = extractFrontmatter(content);
		const frontmatter = parsed.frontmatter ?? {};
		const id = scalar(frontmatter.id);

		return {
			path: normalized,
			id,
			type: typeFromId(id),
			title: scalar(frontmatter.title) ?? titleFromBody(parsed.body, normalized),
			sources: stringArray(frontmatter.sources),
			updatedAt: scalar(frontmatter.updated_at ?? frontmatter.updatedAt),
			relations: parseRelations(frontmatter.relations),
			hasFrontmatter: parsed.hasFrontmatter,
			...(parsed.error ? { frontmatterError: parsed.error } : {}),
		};
	}

	private async requireObject(path: string) {
		const content = await this.readText(path);
		const object = await this.readAtlasObject(path);
		return {
			content,
			object,
			parsed: parseMarkdownObject(content, path),
		};
	}

	private async ensureAtlasRoot() {
		const existing = await this.readOptionalText("_atlas.md");

		if (existing !== undefined) {
			return existing;
		}

		await this.writeMarkdownObject(
			"_atlas.md",
			{
				id: "atlas:root",
				title: "DAYONE Knowledge",
				relations: [],
			},
			this.defaultCoreBody("atlas", "DAYONE Knowledge"),
		);

		return this.readText("_atlas.md");
	}

	private async updateAtlasClientLink(
		client: string,
		title: string,
		action: "upsert" | "remove",
	) {
		const clientSlug = this.clientSlug(client);
		const clientPath = this.clientFile(clientSlug);
		const content = await this.ensureAtlasRoot();
		const parsed = parseMarkdownObject(content, "_atlas.md");
		const relations = new Set(parsed.relations);

		if (action === "upsert") {
			relations.add(clientPath);
		} else {
			relations.delete(clientPath);
		}

		const body =
			action === "upsert"
				? upsertHeadingListLink(
						parsed.body,
						"Clients",
						clientPath,
						listItemForLink(title, clientPath),
					)
				: removeHeadingListLink(parsed.body, "Clients", clientPath, "_No clients yet._");

		await this.writeMarkdownObject(
			"_atlas.md",
			{
				id: scalar(parsed.frontmatter.id) ?? "atlas:root",
				title: parsed.title,
				sources: parsed.sources,
				relations: [...relations],
			},
			body,
		);
	}

	private async updateClientProjectLink(
		scope: ProjectScope,
		title: string,
		action: "upsert" | "remove",
	) {
		const clientPath = this.clientFile(scope.client);
		const projectPath = `./projects/${this.projectSlug(scope.project)}/_project.md`;
		const { parsed } = await this.requireObject(clientPath);
		const relations = new Set(parsed.relations);

		if (action === "upsert") {
			relations.add(projectPath);
		} else {
			relations.delete(projectPath);
		}

		const body =
			action === "upsert"
				? upsertHeadingListLink(
						parsed.body,
						"Projects",
						projectPath,
						listItemForLink(title, projectPath),
					)
				: removeHeadingListLink(parsed.body, "Projects", projectPath, "_No projects yet._");

		await this.writeMarkdownObject(
			clientPath,
			{
				id: scalar(parsed.frontmatter.id) ?? `client:${this.clientSlug(scope.client)}`,
				title: parsed.title,
				sources: parsed.sources,
				relations: [...relations],
			},
			body,
		);
	}

	private async requireClient(client: string) {
		const clientPath = this.clientFile(client);

		if ((await this.readOptionalText(clientPath)) === undefined) {
			throw new Error(
				`Atlas client does not exist: ${client}. Create it first with atlas_core_create using role "client".`,
			);
		}
	}

	private async requireProjectScaffold(scope: ProjectScope) {
		await this.requireClient(scope.client);
		const missing = [];

		for (const requiredPath of [
			this.projectFile(scope),
			this.stateFile(scope),
			this.indexFile(scope),
		]) {
			if ((await this.readOptionalText(requiredPath)) === undefined) {
				missing.push(requiredPath);
			}
		}

		if (missing.length > 0) {
			throw new Error(
				`Atlas project scaffold is incomplete for ${scope.client}/${scope.project}. Create or repair it first with atlas_core_create using role "project". Missing: ${missing.join(", ")}.`,
			);
		}
	}

	async createClient(input: {
		client: string;
		title: string;
		context?: string;
		sources?: string[];
	}) {
		const client = this.clientSlug(input.client);
		const clientPath = this.clientFile(client);
		const existing = await this.readOptionalText(clientPath);

		if (existing !== undefined) {
			const object = await this.readAtlasObject(clientPath);
			await this.updateAtlasClientLink(client, object.title, "upsert");
			return {
				ok: true,
				created: false,
				client: object,
				changedPaths: ["_atlas.md"],
			};
		}

		await this.createMarkdownObject(
			clientPath,
			{
				id: `client:${client}`,
				title: input.title,
				sources: input.sources,
				relations: [],
			},
			[
				`# ${input.title} Context`,
				"",
				"## Context",
				"",
				input.context?.trim() || `DAYONE relationship context for ${input.title}.`,
				"",
				"## Projects",
				"",
				"_No projects yet._",
				"",
			].join("\n"),
		);
		await this.updateAtlasClientLink(client, input.title, "upsert");

		return {
			ok: true,
			created: true,
			client: await this.readAtlasObject(clientPath),
			changedPaths: ["_atlas.md", clientPath],
		};
	}

	async createProject(input: {
		client: string;
		project: string;
		title: string;
		context?: string;
	}) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireClient(scope.client);
		const projectRoot = this.projectDirectory(scope);
		const projectPath = this.projectFile(scope);
		const existing = await this.readOptionalText(projectPath);

		if (existing !== undefined) {
			const object = await this.readAtlasObject(projectPath);
			const changedPaths = [this.clientFile(scope.client)];

			if ((await this.readOptionalText(this.stateFile(scope))) === undefined) {
				await this.createMarkdownObject(
					this.stateFile(scope),
					{
						id: `state:${scope.client}-${scope.project}`,
						title: `Live State - ${object.title}`,
						relations: ["_project.md"],
					},
					this.defaultCoreBody("state", `Live State - ${object.title}`),
				);
				changedPaths.push(this.stateFile(scope));
			}

			if ((await this.readOptionalText(this.indexFile(scope))) === undefined) {
				await this.createMarkdownObject(
					this.indexFile(scope),
					{
						id: `index:${scope.client}-${scope.project}`,
						title: `Index - ${object.title}`,
						relations: ["_project.md", "_state.md"],
					},
					this.defaultCoreBody("index", `Index - ${object.title}`),
				);
				changedPaths.push(this.indexFile(scope));
			}

			await this.updateClientProjectLink(scope, object.title, "upsert");

			return {
				ok: true,
				created: false,
				repaired: changedPaths.length > 1,
				project: object,
				changedPaths,
			};
		}

		const projectTitle = input.title.trim();
		const projectBody = [
			`# ${projectTitle} Context`,
			"",
			"## Context",
			"",
			input.context?.trim() || `Stable DAYONE project context for ${projectTitle}.`,
			"",
			"## State",
			"",
			"- [_state](_state.md)",
			"",
			"## Index",
			"",
			"- [_index](_index.md)",
			"",
		].join("\n");
		await this.createMarkdownObject(
			`${projectRoot}/_project.md`,
			{
				id: `project:${scope.client}-${scope.project}`,
				title: projectTitle,
				relations: ["_state.md", "_index.md"],
			},
			projectBody,
		);
		await this.createMarkdownObject(
			`${projectRoot}/_state.md`,
			{
				id: `state:${scope.client}-${scope.project}`,
				title: `Live State - ${projectTitle}`,
				relations: ["_project.md"],
			},
			this.defaultCoreBody("state", `Live State - ${projectTitle}`),
		);
		await this.createMarkdownObject(
			`${projectRoot}/_index.md`,
			{
				id: `index:${scope.client}-${scope.project}`,
				title: `Index - ${projectTitle}`,
				relations: ["_project.md", "_state.md"],
			},
			this.defaultCoreBody("index", `Index - ${projectTitle}`),
		);
		await this.updateClientProjectLink(scope, projectTitle, "upsert");

		return {
			ok: true,
			created: true,
			project: await this.readAtlasObject(projectPath),
			changedPaths: [
				this.clientFile(scope.client),
				projectPath,
				this.stateFile(scope),
				this.indexFile(scope),
			],
		};
	}

	async createCore(input: {
		role: AtlasCoreRole;
		client?: string;
		project?: string;
		title?: string;
		body?: string;
		sources?: string[];
		relations?: string[];
	}) {
		const role = input.role;
		const scope = this.requireScopeForRole(role, input);

		if (role === "atlas") {
			if ((await this.readOptionalText("_atlas.md")) !== undefined) {
				return {
					ok: true,
					created: false,
					core: await this.readAtlasObject("_atlas.md"),
					changedPaths: [],
				};
			}

			const title = input.title?.trim() || this.defaultCoreTitle(role, input);
			await this.writeMarkdownObject(
				"_atlas.md",
				{
					id: this.defaultCoreId(role, input),
					title,
					sources: input.sources,
					relations: input.relations ?? [],
				},
				input.body ?? this.defaultCoreBody(role, title),
			);

			return {
				ok: true,
				created: true,
				core: await this.readAtlasObject("_atlas.md"),
				changedPaths: ["_atlas.md"],
			};
		}

		if (role === "client") {
			return this.createClient({
				client: scope.client!,
				title: input.title?.trim() || this.defaultCoreTitle(role, input),
				context: input.body,
				sources: input.sources,
			});
		}

		if (role === "project") {
			return this.createProject({
				client: scope.client!,
				project: scope.project!,
				title: input.title?.trim() || this.defaultCoreTitle(role, input),
				context: input.body,
			});
		}

		const corePath = this.coreFile(role, input);

		if ((await this.readOptionalText(corePath)) !== undefined) {
			return {
				ok: true,
				created: false,
				core: await this.readAtlasObject(corePath),
				changedPaths: [],
			};
		}

		await this.requireClient(scope.client!);
		const title = input.title?.trim() || this.defaultCoreTitle(role, input);
		await this.createMarkdownObject(
			corePath,
			{
				id: this.defaultCoreId(role, input),
				title,
				sources: input.sources,
				relations: input.relations ?? this.defaultCoreRelations(role),
			},
			input.body ?? this.defaultCoreBody(role, title),
		);

		return {
			ok: true,
			created: true,
			core: await this.readAtlasObject(corePath),
			changedPaths: [corePath],
		};
	}

	async updateCore(input: {
		role: AtlasCoreRole;
		client?: string;
		project?: string;
		title?: string;
		body?: string;
		sources?: string[];
		relations?: string[];
	}) {
		const role = input.role;
		const scope = this.requireScopeForRole(role, input);
		const corePath = this.coreFile(role, input);
		const { parsed } = await this.requireObject(corePath);
		const title = input.title?.trim() || parsed.title;

		await this.writeMarkdownObject(
			corePath,
			{
				id: scalar(parsed.frontmatter.id) ?? this.defaultCoreId(role, input),
				title,
				sources: input.sources ?? parsed.sources,
				relations: input.relations ?? parsed.relations,
			},
			input.body ?? parsed.body,
		);

		if (role === "client") {
			await this.updateAtlasClientLink(scope.client!, title, "upsert");
		}

		if (role === "project") {
			await this.updateClientProjectLink(
				{ client: scope.client!, project: scope.project! },
				title,
				"upsert",
			);
		}

		return {
			ok: true,
			core: await this.readAtlasObject(corePath),
			changedPaths:
				role === "client"
					? [corePath, "_atlas.md"]
					: role === "project"
						? [corePath, this.clientFile(scope.client!)]
						: [corePath],
		};
	}

	async getKnowledge(scopeInput: ProjectScope & { slug: string }) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const knowledgePath = this.knowledgeFile(scope, scopeInput.slug);

		return {
			ok: true,
			path: knowledgePath,
			content: await this.readText(knowledgePath),
			object: await this.readAtlasObject(knowledgePath),
		};
	}

	async createKnowledge(
		input: ProjectScope & {
			slug: string;
			kind: string;
			title: string;
			body: string;
			sources?: string[];
			relations?: string[];
		},
	) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireProjectScaffold(scope);
		const slug = this.objectSlug(input.slug);
		const knowledgePath = this.knowledgeFile(scope, slug);

		if ((await this.readOptionalText(knowledgePath)) !== undefined) {
			return {
				ok: true,
				created: false,
				page: await this.readAtlasObject(knowledgePath),
				changedPaths: [],
			};
		}

		await this.createMarkdownObject(
			knowledgePath,
			{
				id: `${input.kind}:${scope.client}-${scope.project}-${slug}`,
				title: input.title,
				sources: input.sources,
				relations: input.relations,
			},
			input.body,
		);
		const index = await this.upsertIndexEntry({
			client: scope.client,
			project: scope.project,
			path: `${slug}.md`,
			title: input.title,
			kind: input.kind,
		});

		return {
			ok: true,
			created: true,
			page: await this.readAtlasObject(knowledgePath),
			index,
			changedPaths: [knowledgePath, ...index.changedPaths],
		};
	}

	async updateKnowledge(
		input: ProjectScope & {
			slug: string;
			title?: string;
			body?: string;
			sources?: string[];
			relations?: string[];
		},
	) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireProjectScaffold(scope);
		const knowledgePath = this.knowledgeFile(scope, input.slug);
		const { parsed } = await this.requireObject(knowledgePath);
		const title = input.title?.trim() || parsed.title;
		const kind = scalar(parsed.frontmatter.id)?.split(":", 1)[0] ?? "topic";

		await this.writeMarkdownObject(
			knowledgePath,
			{
				id:
					scalar(parsed.frontmatter.id) ??
					`topic:${scope.client}-${scope.project}-${this.objectSlug(input.slug)}`,
				title,
				sources: input.sources ?? parsed.sources,
				relations: input.relations ?? parsed.relations,
			},
			input.body ?? parsed.body,
		);
		const index = await this.upsertIndexEntry({
			client: scope.client,
			project: scope.project,
			path: `${this.objectSlug(input.slug)}.md`,
			title,
			kind,
		});

		return {
			ok: true,
			page: await this.readAtlasObject(knowledgePath),
			index,
			changedPaths: [knowledgePath, ...index.changedPaths],
		};
	}

	async deleteKnowledge(scopeInput: ProjectScope & { slug: string }) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const knowledgePath = this.knowledgeFile(scope, scopeInput.slug);
		const object = await this.readAtlasObject(knowledgePath);
		const index = await this.removeIndexEntry({
			client: scope.client,
			project: scope.project,
			path: `${this.objectSlug(scopeInput.slug)}.md`,
		});
		const deletion = await this.deleteFile(knowledgePath);

		return {
			ok: true,
			deleted: object,
			deletion,
			index,
			changedPaths: [knowledgePath, ...index.changedPaths],
		};
	}

	async upsertIndexEntry(
		input: ProjectScope & { path: string; title: string; summary?: string; kind?: string },
	) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireProjectScaffold(scope);
		const indexPath = this.indexFile(scope);
		const { parsed } = await this.requireObject(indexPath);
		const body = upsertIndexEntryBody(
			parsed.body,
			normalizeFilePath(input.path),
			input.title,
			input.kind,
			input.summary,
		);

		await this.writeMarkdownObject(
			indexPath,
			{
				id: scalar(parsed.frontmatter.id) ?? `index:${scope.client}-${scope.project}`,
				title: parsed.title,
				sources: parsed.sources,
				relations: parsed.relations,
			},
			body,
		);

		return {
			ok: true,
			index: await this.readAtlasObject(indexPath),
			changedPaths: [indexPath],
		};
	}

	async removeIndexEntry(scopeInput: ProjectScope & { path: string }) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const indexPath = this.indexFile(scope);
		const { parsed } = await this.requireObject(indexPath);
		const body = removeIndexEntryBody(parsed.body, normalizeFilePath(scopeInput.path));

		await this.writeMarkdownObject(
			indexPath,
			{
				id: scalar(parsed.frontmatter.id) ?? `index:${scope.client}-${scope.project}`,
				title: parsed.title,
				sources: parsed.sources,
				relations: parsed.relations,
			},
			body,
		);

		return {
			ok: true,
			index: await this.readAtlasObject(indexPath),
			changedPaths: [indexPath],
		};
	}

	async enumerateMarkdownFiles() {
		const files: string[] = [];
		let cursor: string | undefined;

		do {
			const result = await this.bucket.list({
				cursor,
				limit: 1000,
			});

			for (const object of result.objects) {
				if (object.key.endsWith(".md")) {
					files.push(object.key);
				}
			}

			cursor = result.truncated ? result.cursor : undefined;
		} while (cursor);

		return files.sort((left, right) => left.localeCompare(right));
	}

	async buildGraph(): Promise<AtlasGraph> {
		const paths = await this.enumerateMarkdownFiles();
		const objects = await Promise.all(paths.map((path) => this.readAtlasObject(path)));
		const byPath = new Map(objects.map((object) => [object.path, object]));
		const byId = new Map<string, AtlasObject>();
		const warnings: AtlasHealthIssue[] = [];

		for (const object of objects) {
			if (!object.id) {
				continue;
			}

			if (byId.has(object.id)) {
				warnings.push(
					makeIssue(
						"error",
						"duplicate_id",
						object,
						`${object.id} is used by both ${byId.get(object.id)?.path} and ${object.path}.`,
					),
				);
				continue;
			}

			byId.set(object.id, object);
		}

		const resolveTarget = (target: string, sourcePath: string) => {
			if (byId.has(target)) {
				return {
					resolved: true,
					targetPath: byId.get(target)?.path,
				};
			}

			if (!targetLooksLikePath(target)) {
				return { resolved: false };
			}

			const targetPath = normalizeAtlasReferencePath(target, sourcePath);

			if (targetPath && byPath.has(targetPath)) {
				return {
					resolved: true,
					targetPath,
				};
			}

			return {
				resolved: false,
				targetPath,
			};
		};

		const edges: AtlasEdge[] = [];

		for (const object of objects) {
			const from = object.id ?? object.path;

			for (const relation of object.relations) {
				const resolution = resolveTarget(relation.target, object.path);
				edges.push({
					from,
					to: relation.target,
					type: "related_file",
					kind: "relation",
					sourcePath: object.path,
					resolved: resolution.resolved,
					...(resolution.targetPath ? { targetPath: resolution.targetPath } : {}),
				});
			}
		}

		for (const edge of edges) {
			if (!edge.resolved) {
				warnings.push({
					severity: "warning",
					type: "unresolved_edge",
					path: edge.sourcePath,
					id: byPath.get(edge.sourcePath)?.id,
					message: `${edge.type} points at unresolved target ${edge.to}.`,
				});
			}
		}

		return {
			objects,
			edges,
			byId,
			byPath,
			warnings,
			summary: {
				files: objects.length,
				typedObjects: objects.filter((object) => object.hasFrontmatter).length,
				ids: byId.size,
				edges: edges.length,
				unresolvedEdges: edges.filter((edge) => !edge.resolved).length,
			},
		};
	}

	private async graphCompletenessIssues(graph: AtlasGraph) {
		const issues: AtlasHealthIssue[] = [];
		const clientPaths = graph.objects
			.map((object) => object.path)
			.filter((objectPath) => /^clients\/[^/]+\/_client\.md$/.test(objectPath))
			.sort((left, right) => left.localeCompare(right));
		const atlas = graph.byPath.get("_atlas.md");

		if (atlas) {
			const content = await this.readOptionalText("_atlas.md");
			const relationTargets = new Set(
				atlas.relations
					.map((relation) => normalizeAtlasReferencePath(relation.target, "_atlas.md"))
					.filter((target): target is string => Boolean(target)),
			);
			const linkTargets = new Set(
				[...(content ? markdownLinkTargets(content) : [])]
					.map((target) => normalizeAtlasReferencePath(target, "_atlas.md"))
					.filter((target): target is string => Boolean(target)),
			);

			for (const clientPath of clientPaths) {
				if (!relationTargets.has(clientPath)) {
					issues.push({
						severity: "warning",
						type: "missing_root_client_relation",
						path: "_atlas.md",
						id: atlas.id,
						message: `_atlas.md relations must include ${clientPath}.`,
					});
				}

				if (!linkTargets.has(clientPath)) {
					issues.push({
						severity: "warning",
						type: "missing_root_client_link",
						path: "_atlas.md",
						id: atlas.id,
						message: `_atlas.md ## Clients must link to ${clientPath}.`,
					});
				}
			}
		}

		for (const clientPath of clientPaths) {
			const clientObject = graph.byPath.get(clientPath);

			if (!clientObject) {
				continue;
			}

			const clientDir = dirnamePosix(clientPath);
			const expectedProjects = graph.objects
				.map((object) => object.path)
				.filter(
					(objectPath) =>
						objectPath.startsWith(`${clientDir}/projects/`) &&
						objectPath.endsWith("/_project.md"),
				)
				.sort((left, right) => left.localeCompare(right));
			const content = await this.readOptionalText(clientPath);
			const relationTargets = new Set(
				clientObject.relations
					.map((relation) => normalizeAtlasReferencePath(relation.target, clientPath))
					.filter((target): target is string => Boolean(target)),
			);
			const linkTargets = new Set(
				[...(content ? markdownLinkTargets(content) : [])]
					.map((target) => normalizeAtlasReferencePath(target, clientPath))
					.filter((target): target is string => Boolean(target)),
			);

			for (const projectPath of expectedProjects) {
				if (!relationTargets.has(projectPath)) {
					issues.push({
						severity: "warning",
						type: "missing_client_project_relation",
						path: clientPath,
						id: clientObject.id,
						message: `${clientPath} relations must include ${projectPath}.`,
					});
				}

				if (!linkTargets.has(projectPath)) {
					issues.push({
						severity: "warning",
						type: "missing_client_project_link",
						path: clientPath,
						id: clientObject.id,
						message: `${clientPath} ## Projects must link to ${projectPath}.`,
					});
				}
			}
		}

		return issues;
	}

	async healthCheck(graphInput?: AtlasGraph) {
		const graph = graphInput ?? (await this.buildGraph());
		const issues: AtlasHealthIssue[] = [...graph.warnings];

		for (const object of graph.objects) {
			if (object.frontmatterError) {
				issues.push(
					makeIssue(
						"error",
						"frontmatter_parse_error",
						object,
						`Frontmatter could not be parsed: ${object.frontmatterError}`,
					),
				);
			}

			if (object.hasFrontmatter) {
				const missing = requiredFrontmatterFields(object);

				if (missing.length > 0) {
					issues.push(
						makeIssue(
							"warning",
							"missing_required_frontmatter",
							object,
							`Missing required frontmatter: ${missing.join(", ")}.`,
						),
					);
				}
			}
		}

		issues.push(...(await this.graphCompletenessIssues(graph)));

		return {
			ok: !issues.some((issue) => issue.severity === "error"),
			summary: graph.summary,
			issues,
		};
	}

	async trace(idOrPath: string, depth = 2) {
		const graph = await this.buildGraph();
		const start =
			graph.byId.get(idOrPath) ??
			graph.byPath.get(normalizePath(idOrPath, { allowRoot: true }));

		if (!start) {
			throw new Error(`${idOrPath} does not resolve to an Atlas ID or markdown path.`);
		}

		const startKey = start.id ?? start.path;
		const visited = new Set<string>([startKey]);
		const queue: Array<{ key: string; distance: number }> = [{ key: startKey, distance: 0 }];
		const includedEdges: AtlasEdge[] = [];

		while (queue.length > 0) {
			const current = queue.shift()!;

			if (current.distance >= depth) {
				continue;
			}

			const adjacent = graph.edges.filter((edge) => {
				if (edge.from === current.key) {
					return true;
				}

				const targetObject =
					graph.byId.get(edge.to) ??
					(edge.targetPath ? graph.byPath.get(edge.targetPath) : undefined);
				const targetKey = targetObject?.id ?? targetObject?.path;

				return targetKey === current.key;
			});

			for (const edge of adjacent) {
				includedEdges.push(edge);

				for (const target of [edge.from, edge.to]) {
					const object = graph.byId.get(target) ?? graph.byPath.get(target);
					const key = object?.id ?? object?.path;

					if (key && !visited.has(key)) {
						visited.add(key);
						queue.push({ key, distance: current.distance + 1 });
					}
				}

				if (edge.targetPath) {
					const object = graph.byPath.get(edge.targetPath);
					const key = object?.id ?? object?.path;

					if (key && !visited.has(key)) {
						visited.add(key);
						queue.push({ key, distance: current.distance + 1 });
					}
				}
			}
		}

		const nodes = [...visited]
			.map((key) => graph.byId.get(key) ?? graph.byPath.get(key))
			.filter((object): object is AtlasObject => Boolean(object));

		return {
			ok: true,
			start: {
				id: start.id ?? null,
				path: start.path,
				title: start.title,
				type: start.type ?? null,
			},
			depth,
			nodes,
			edges: includedEdges,
		};
	}
}

class CloudAtlasRuntime {
	readonly workspace: R2AtlasWorkspace;

	constructor(readonly env: Env) {
		this.workspace = new R2AtlasWorkspace(env.ATLAS_BUCKET);
	}

	async status() {
		const [graph, aiSearchInfo, aiSearchStats] = await Promise.all([
			this.workspace.buildGraph(),
			getAiSearch(this.env)
				.info()
				.catch((error) => ({ ok: false, error: errorMessage(error) })),
			getAiSearch(this.env)
				.stats()
				.catch((error) => ({ ok: false, error: errorMessage(error) })),
		]);
		const health = await this.workspace.healthCheck(graph);

		return {
			ok: true,
			mode: "worker-r2-ai-search",
			storage: {
				canonical: "r2",
			},
			search: {
				provider: "cloudflare-ai-search",
				info: aiSearchInfo,
				stats: aiSearchStats,
			},
			accessEvents: {
				enabled: accessEventsEnabled(this.env),
				transport: "durable-object-websocket",
			},
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
		const search = getAiSearch(this.env);
		const [info, stats] = await Promise.all([search.info(), search.stats()]);

		return {
			ok: true,
			mode: "cloudflare-ai-search-managed-indexing",
			note: "AI Search manages indexing for R2-backed Atlas content. R2-backed instances sync automatically; use Cloudflare AI Search controls for manual sync when immediate re-indexing is needed.",
			info,
			stats,
		};
	}

	async search(input: {
		query: string;
		client?: string;
		project?: string;
		intent?: string;
		limit?: number;
	}) {
		const query = input.query.trim();

		if (!query) {
			throw new Error("search requires query.");
		}

		const client = input.client ? this.workspace.clientSlug(input.client) : undefined;
		const project = input.project ? this.workspace.projectSlug(input.project) : undefined;
		const limit = input.limit ?? 10;
		const scopePrefix = client
			? project
				? `clients/${client}/projects/${project}/`
				: `clients/${client}/`
			: undefined;
		const filters = scopePrefix
			? {
					folder: {
						$gte: scopePrefix,
						$lt: folderUpperBound(scopePrefix),
					},
				}
			: undefined;
		const graph = await this.workspace.buildGraph();
		const searchText = [input.intent?.trim(), query].filter(Boolean).join("\n\n");
		const results = await getAiSearch(this.env).search({
			query: searchText,
			ai_search_options: {
				retrieval: {
					retrieval_type: "hybrid",
					max_num_results: limit,
					context_expansion: 1,
					keyword_match_mode: "or",
					return_on_failure: true,
					...(filters ? { filters } : {}),
				},
				query_rewrite: { enabled: true },
				reranking: {
					enabled: true,
					model: "@cf/baai/bge-reranker-base",
				},
			},
		});

		return {
			ok: true,
			query,
			...(input.intent ? { intent: input.intent } : {}),
			searchQuery: results.search_query ?? searchText,
			scope: {
				client: client ?? null,
				project: project ?? null,
			},
			results: (results.chunks ?? []).map((chunk) => {
				const atlasPath = normalizePath(chunk.item?.key ?? "", { allowRoot: true });
				const object = graph.byPath.get(atlasPath);
				const scope = scopeFromPath(atlasPath);

				return {
					chunkId: chunk.id,
					path: atlasPath,
					title: object?.title ?? basename(atlasPath),
					score: Math.round(chunk.score * 1000) / 1000,
					client: scope.client,
					project: scope.project,
					kind: object?.type ?? null,
					snippet: snippetFromText(chunk.text, query),
					metadata: objectSummary(object),
					item: chunk.item ?? null,
					scoring: chunk.scoring_details ?? null,
				};
			}),
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
	runtime: CloudAtlasRuntime,
	operation: () => Promise<Record<string, unknown>>,
) {
	const result = await operation();
	const health = await runtime.workspace.healthCheck();

	return jsonContent({
		...result,
		searchIndex: {
			provider: "cloudflare-ai-search",
			mode: "managed-r2-sync",
		},
		health: {
			ok: health.ok,
			issueCount: health.issues.length,
			issues: health.issues,
		},
	});
}

async function writeContentWithAccessEvents(
	runtime: CloudAtlasRuntime,
	env: Env,
	source: string,
	operation: () => Promise<Record<string, unknown>>,
) {
	const result = await operation();
	const changedPaths = Array.isArray(result.changedPaths)
		? result.changedPaths.filter((path): path is string => typeof path === "string")
		: [];
	await maybeEmitManyAccesses(env, changedPaths, source);
	const health = await runtime.workspace.healthCheck();

	return jsonContent({
		...result,
		searchIndex: {
			provider: "cloudflare-ai-search",
			mode: "managed-r2-sync",
		},
		health: {
			ok: health.ok,
			issueCount: health.issues.length,
			issues: health.issues,
		},
	});
}

function createServer(env: Env, origin: string) {
	const runtime = new CloudAtlasRuntime(env);
	const server = new McpServer(
		{
			name: "Atlas MCP",
			title: "Atlas",
			version: "1.0.0",
			icons: [
				{
					src: `${origin}/atlas.svg`,
					mimeType: "image/svg+xml",
					sizes: ["any"],
				},
			],
		},
		{
			instructions: [
				"Atlas MCP provides and manages DAYONE company knowledge.",
				"Markdown files in R2 are canonical.",
				"Cloudflare AI Search provides managed retrieval over Atlas markdown.",
			].join("\n"),
		},
	);

	server.registerTool(
		"atlas_status",
		{
			title: "Atlas Status",
			description: "Show Atlas R2 workspace, AI Search, graph, and health status.",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.status()),
	);

	server.registerTool(
		"atlas_embed",
		{
			title: "Atlas Embed",
			description:
				"Show Cloudflare AI Search managed indexing status for Atlas. AI Search owns cloud indexing for R2-backed content.",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.embed()),
	);

	server.registerTool(
		"atlas_search",
		{
			title: "Atlas Search",
			description:
				"Answer user questions and find relevant Atlas knowledge with Cloudflare AI Search. Optional client/project scope filters by Atlas path.",
			inputSchema: {
				query: z.string().min(1),
				client: clientSchema.optional(),
				project: projectSchema.optional(),
				intent: z.string().min(1).optional(),
				limit: z.number().int().min(1).max(50).default(10),
			},
		},
		async (input) => {
			const result = await runtime.search(input);
			await maybeEmitManyAccesses(
				env,
				result.results.map((item) => item.path),
				"atlas_search",
			);
			return jsonContent(result);
		},
	);

	server.registerTool(
		"atlas_context",
		{
			title: "Atlas Context",
			description:
				"Read one project context, read exact Atlas paths, or list one workspace directory. Pass exactly one of path, paths, or listPath.",
			inputSchema: {
				path: z.string().optional(),
				paths: z.array(z.string()).min(1).max(50).optional(),
				listPath: z.string().optional(),
			},
		},
		async ({ path, paths, listPath }) => {
			const modeCount = [path, paths, listPath].filter(Boolean).length;

			if (modeCount !== 1) {
				throw new Error("atlas_context requires exactly one of path, paths, or listPath.");
			}

			if (path) {
				if (path.endsWith(".md")) {
					const files = await runtime.workspace.readMany([path]);
					await maybeEmitManyAccesses(
						env,
						files.filter((file) => file.ok).map((file) => file.path),
						"atlas_context",
					);
					return jsonContent({
						ok: true,
						files,
					});
				}

				const result = await runtime.workspace.projectContext(path);
				await maybeEmitManyAccesses(
					env,
					result.coreFiles.filter((file) => file.ok).map((file) => file.path),
					"atlas_context",
				);
				return jsonContent(result);
			}

			if (paths) {
				const files = await runtime.workspace.readMany(paths);
				await maybeEmitManyAccesses(
					env,
					files.filter((file) => file.ok).map((file) => file.path),
					"atlas_context",
				);
				return jsonContent({
					ok: true,
					files,
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
			title: "Atlas Trace",
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
			title: "Atlas Health Check",
			description:
				"Lint Atlas knowledge in R2 for broken relation hints, frontmatter parse errors, and missing required fields.",
			inputSchema: {},
		},
		async () => jsonContent(await runtime.workspace.healthCheck()),
	);

	server.registerTool(
		"atlas_knowledge_read",
		{
			title: "Atlas Knowledge Read",
			description: "Read one Atlas knowledge page.",
			inputSchema: z
				.object({ client: clientSchema, project: projectSchema, slug: z.string().min(1) })
				.strict(),
		},
		async (input) => {
			const result = await runtime.workspace.getKnowledge(input);
			await maybeEmitAccess(env, result.path, "atlas_knowledge_read");
			return jsonContent(result);
		},
	);

	server.registerTool(
		"atlas_knowledge_create",
		{
			title: "Atlas Knowledge Create",
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
		async (input) =>
			writeContentWithAccessEvents(
				runtime,
				env,
				"atlas_knowledge_create",
				() => runtime.workspace.createKnowledge(input),
			),
	);

	server.registerTool(
		"atlas_knowledge_update",
		{
			title: "Atlas Knowledge Update",
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
		async (input) =>
			writeContentWithAccessEvents(
				runtime,
				env,
				"atlas_knowledge_update",
				() => runtime.workspace.updateKnowledge(input),
			),
	);

	server.registerTool(
		"atlas_knowledge_delete",
		{
			title: "Atlas Knowledge Delete",
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
			title: "Atlas Core Create",
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
			writeContentWithAccessEvents(runtime, env, "atlas_core_create", () =>
				runtime.workspace.createCore({ ...input, role: input.role as AtlasCoreRole }),
			),
	);

	server.registerTool(
		"atlas_core_update",
		{
			title: "Atlas Core Update",
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
			writeContentWithAccessEvents(runtime, env, "atlas_core_update", () =>
				runtime.workspace.updateCore({ ...input, role: input.role as AtlasCoreRole }),
			),
	);

	return server;
}

function requireApiKey(request: Request, env: Env) {
	const auth = request.headers.get("Authorization");
	return auth === `Bearer ${env.MCP_API_KEY}`;
}

function apiKeyIsConfigured(env: Env) {
	return typeof env.MCP_API_KEY === "string" && env.MCP_API_KEY.length > 0;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/status" && request.method === "GET") {
			if (apiKeyIsConfigured(env) && !requireApiKey(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}

			const runtime = new CloudAtlasRuntime(env);
			return Response.json(await runtime.status());
		}

		if (url.pathname === "/access/ws" && request.method === "GET") {
			if (!isAuthorizedAccessEventRequest(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}

			const hubUrl = new URL("/ws", request.url);
			return accessHub(env).fetch(new Request(hubUrl, request));
		}

		if (url.pathname === "/access/events" && request.method === "GET") {
			if (!isAuthorizedAccessEventRequest(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}

			const hubUrl = new URL("/sse", request.url);
			return accessHub(env).fetch(new Request(hubUrl, request));
		}

		if (url.pathname === "/mcp") {
			if (!requireApiKey(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}

			const server = createServer(env, url.origin);
			return createMcpHandler(server)(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<AtlasWorkerEnv>;
