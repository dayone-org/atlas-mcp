import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DIRECTORY_MARKER_NAME = ".atlas-directory";
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const PROJECT_CORE_FILE_NAMES = ["_project.md", "_state.md", "_index.md"] as const;

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
	path: string,
	{
		allowRoot = false,
		allowTrailingSlash = false,
	}: {
		allowRoot?: boolean;
		allowTrailingSlash?: boolean;
	} = {},
) {
	if (path.trim() !== path) {
		throw new Error("Path must not contain leading or trailing whitespace.");
	}

	if (hasControlCharacter(path)) {
		throw new Error("Path must not contain control characters.");
	}

	if (path.includes("\\")) {
		throw new Error("Use forward slashes in Atlas paths.");
	}

	const withoutLeadingSlash = path.replace(/^\/+/, "");
	const isRoot = withoutLeadingSlash === "" || /^\/+$/.test(path);

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

function normalizeFilePath(path: string) {
	const key = normalizePath(path);

	if (isDirectoryMarkerKey(key)) {
		throw new Error("Directory marker files are internal to Atlas MCP.");
	}

	return key;
}

function normalizeDirectoryPath(path: string) {
	return normalizePath(path, { allowTrailingSlash: true });
}

function isDirectoryMarkerKey(key: string) {
	return key.endsWith(`/${DIRECTORY_MARKER_NAME}`) || key === DIRECTORY_MARKER_NAME;
}

function basename(path: string) {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

async function readTextObject(bucket: R2Bucket, key: string) {
	const object = await bucket.get(key);

	if (!object) {
		return undefined;
	}

	if (object.size > MAX_TEXT_FILE_BYTES) {
		throw new Error(`${key} is too large to read as text (${object.size} bytes).`);
	}

	return object.text();
}

async function readTextFileResult(bucket: R2Bucket, path: string) {
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
		const content = await readTextObject(bucket, key);

		if (content === undefined) {
			return {
				ok: false as const,
				path: key,
				error: `${key} does not exist.`,
			};
		}

		return {
			ok: true as const,
			path: key,
			content,
		};
	} catch (error) {
		return {
			ok: false as const,
			path: key,
			error: errorMessage(error),
		};
	}
}

async function readOptionalProjectCoreFile(
	bucket: R2Bucket,
	projectPath: string,
	name: (typeof PROJECT_CORE_FILE_NAMES)[number],
) {
	const path = `${projectPath}/${name}`;

	try {
		const content = await readTextObject(bucket, path);

		if (content === undefined) {
			return undefined;
		}

		return {
			ok: true as const,
			name,
			path,
			content,
		};
	} catch (error) {
		return {
			ok: false as const,
			name,
			path,
			error: errorMessage(error),
		};
	}
}

async function listShallowDirectory(bucket: R2Bucket, path: string) {
	const directory = normalizeDirectoryPath(path);
	const prefix = `${directory}/`;
	const directories = new Map<string, { type: "directory"; name: string; path: string }>();
	const files = new Map<
		string,
		{ type: "file"; name: string; path: string; size: number; uploaded: string }
	>();
	let exists = false;
	let cursor: string | undefined;

	do {
		const result = await bucket.list({
			prefix,
			cursor,
			limit: 1000,
			delimiter: "/",
		});

		exists = exists || result.objects.length > 0 || result.delimitedPrefixes.length > 0;

		for (const delimitedPrefix of result.delimitedPrefixes) {
			const entryPath = delimitedPrefix.replace(/\/$/, "");
			directories.set(entryPath, {
				type: "directory",
				name: basename(entryPath),
				path: entryPath,
			});
		}

		for (const object of result.objects) {
			if (isDirectoryMarkerKey(object.key)) {
				continue;
			}

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
		exists,
		entries: [...directories.values(), ...files.values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		),
	};
}

function createServer(env: Env, origin: string) {
	const server = new McpServer({
		name: "Atlas MCP",
		version: "1.0.0",
		icons: [
			{
				src: `${origin}/atlas.svg`,
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
	});

	server.registerTool(
		"atlas_status",
		{
			description: "Show read-only legacy Worker/R2 Atlas status.",
			inputSchema: {},
		},
		async () =>
			jsonContent({
				ok: true,
				mode: "worker-r2-read-only",
				mutationTools: false,
			}),
	);

	server.registerTool(
		"atlas_context",
			{
				description:
					"Read exact Atlas paths, list one R2 workspace directory, or read project context from the read-only Worker/R2 fallback.",
			inputSchema: {
				path: z.string().optional(),
				paths: z.array(z.string()).min(1).max(50).optional(),
				listPath: z.string().optional(),
				cursor: z.string().optional(),
				limit: z.number().int().min(1).max(1000).default(100),
			},
		},
		async ({ path, paths, listPath, cursor, limit }) => {
			const modeCount = [path, paths, listPath].filter(Boolean).length;

			if (modeCount !== 1) {
				throw new Error("atlas_context requires exactly one of path, paths, or listPath.");
			}

			if (paths) {
				return jsonContent({
					ok: true,
					files: await Promise.all(
						paths.map((filePath) => readTextFileResult(env.ATLAS_BUCKET, filePath)),
					),
				});
			}

			if (listPath) {
				const directory = normalizePath(listPath, {
					allowRoot: true,
					allowTrailingSlash: true,
				});
				const prefix = directory === "" ? "" : `${directory}/`;
				const result = await env.ATLAS_BUCKET.list({
					prefix,
					cursor,
					limit,
					delimiter: "/",
				});
				const directories = result.delimitedPrefixes.map((delimitedPrefix) => {
					const entryPath = delimitedPrefix.replace(/\/$/, "");

					return {
						type: "directory" as const,
						name: basename(entryPath),
						path: entryPath,
					};
				});
				const files = result.objects
					.filter((object) => !isDirectoryMarkerKey(object.key))
					.map((object) => ({
						type: "file" as const,
						name: basename(object.key),
						path: object.key,
						size: object.size,
						uploaded: object.uploaded.toISOString(),
					}));

				return jsonContent({
					ok: true,
					listing: {
						path: directory,
						entries: [...directories, ...files].sort((left, right) =>
							left.name.localeCompare(right.name),
						),
						truncated: result.truncated,
						cursor: result.truncated ? result.cursor : null,
					},
				});
			}

			if (path?.endsWith(".md")) {
				return jsonContent({
					ok: true,
					files: await Promise.all([readTextFileResult(env.ATLAS_BUCKET, path)]),
				});
			}

			const projectPath = normalizeDirectoryPath(path ?? "");
			const [coreFileResults, knowledge, sources] = await Promise.all([
				Promise.all(
					PROJECT_CORE_FILE_NAMES.map((name) =>
						readOptionalProjectCoreFile(env.ATLAS_BUCKET, projectPath, name),
					),
				),
				listShallowDirectory(env.ATLAS_BUCKET, `${projectPath}/knowledge`),
				listShallowDirectory(env.ATLAS_BUCKET, `${projectPath}/sources`),
			]);
			const coreFiles = coreFileResults.filter((result) => result !== undefined);

			return jsonContent({
				ok: true,
				path: projectPath,
				coreFiles,
				knowledge,
				sources,
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
			const server = createServer(env, url.origin);
			return createMcpHandler(server)(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
