import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DIRECTORY_MARKER_NAME = ".atlas-directory";
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DELETE_BATCH_SIZE = 1000;
const PROJECT_CORE_FILE_NAMES = ["_project.md", "_state.md", "_index.md", "_log.md"] as const;

type PatchOperation =
	| {
			kind: "add";
			path: string;
			content: string;
	  }
	| {
			kind: "update";
			path: string;
			hunks: PatchHunk[];
	  }
	| {
			kind: "delete";
			path: string;
	  };

type PatchHunk = {
	lines: PatchHunkLine[];
};

type PatchHunkLine = {
	kind: "context" | "add" | "remove";
	text: string;
};

function assertSafeByteLength(path: string, content: string) {
	const byteLength = new TextEncoder().encode(content).byteLength;

	if (byteLength > MAX_TEXT_FILE_BYTES) {
		throw new Error(`${path} is too large for text patching (${byteLength} bytes).`);
	}
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

function jsonResponse(value: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");

	return new Response(JSON.stringify(value, null, 2), {
		...init,
		headers,
	});
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function errorResponse(error: unknown, status = 400) {
	const message = errorMessage(error);

	return jsonResponse({ ok: false, error: message }, { status });
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

function directoryMarkerKey(path: string) {
	return `${path}/${DIRECTORY_MARKER_NAME}`;
}

function isDirectoryMarkerKey(key: string) {
	return key.endsWith(`/${DIRECTORY_MARKER_NAME}`) || key === DIRECTORY_MARKER_NAME;
}

function basename(path: string) {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

function contentTypeForPath(path: string) {
	if (path.endsWith(".md")) {
		return "text/markdown; charset=utf-8";
	}

	if (path.endsWith(".json")) {
		return "application/json; charset=utf-8";
	}

	return "text/plain; charset=utf-8";
}

function contentTypeForUploadPath(path: string) {
	const lower = path.toLowerCase();

	if (lower.endsWith(".md")) {
		return "text/markdown; charset=utf-8";
	}

	if (lower.endsWith(".txt")) {
		return "text/plain; charset=utf-8";
	}

	if (lower.endsWith(".json")) {
		return "application/json; charset=utf-8";
	}

	if (lower.endsWith(".csv")) {
		return "text/csv; charset=utf-8";
	}

	if (lower.endsWith(".pdf")) {
		return "application/pdf";
	}

	if (lower.endsWith(".docx")) {
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	}

	if (lower.endsWith(".pptx")) {
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
	}

	if (lower.endsWith(".xlsx")) {
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	}

	if (lower.endsWith(".png")) {
		return "image/png";
	}

	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return "image/jpeg";
	}

	if (lower.endsWith(".svg")) {
		return "image/svg+xml";
	}

	return "application/octet-stream";
}

function parseOverwriteParam(url: URL) {
	const value = url.searchParams.get("overwrite");

	if (value === null || value === "" || value === "false" || value === "0") {
		return false;
	}

	if (value === "true" || value === "1") {
		return true;
	}

	throw new Error("overwrite must be true or false.");
}

function parseContentLength(request: Request) {
	const value = request.headers.get("content-length");

	if (value === null) {
		throw new Error("Content-Length is required for file uploads.");
	}

	if (!/^\d+$/.test(value)) {
		throw new Error("Content-Length must be a non-negative integer.");
	}

	const size = Number(value);

	if (!Number.isSafeInteger(size)) {
		throw new Error("Content-Length is too large.");
	}

	if (size > MAX_UPLOAD_BYTES) {
		throw new Error(`Upload is too large (${size} bytes).`);
	}

	return size;
}

function normalizeFilesRoutePath(url: URL) {
	const prefix = "/files/";

	if (!url.pathname.startsWith(prefix)) {
		throw new Error("File upload path must start with /files/.");
	}

	const rawPath = url.pathname.slice(prefix.length);

	if (rawPath === "") {
		throw new Error("File upload path is required.");
	}

	try {
		return normalizeFilePath(decodeURIComponent(rawPath));
	} catch (error) {
		if (error instanceof URIError) {
			const pathError = new Error("File upload path contains invalid percent encoding.");
			(pathError as Error & { cause: unknown }).cause = error;
			throw pathError;
		}

		throw error;
	}
}

function normalizeSha256Header(request: Request) {
	const value = request.headers.get("x-atlas-sha256");

	if (value === null || value.trim() === "") {
		return undefined;
	}

	const normalized = value.trim().toLowerCase();

	if (!/^[a-f0-9]{64}$/.test(normalized)) {
		throw new Error("X-Atlas-Sha256 must be a lowercase or uppercase SHA-256 hex digest.");
	}

	return normalized;
}

function normalizeOptionalMetadataHeader(request: Request, headerName: string, label: string) {
	const value = request.headers.get(headerName);

	if (value === null || value.trim() === "") {
		return undefined;
	}

	const normalized = value.trim();

	if (hasControlCharacter(normalized)) {
		throw new Error(`${label} must not contain control characters.`);
	}

	if (normalized.length > 512) {
		throw new Error(`${label} is too long.`);
	}

	return normalized;
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

async function listKeysWithPrefix(bucket: R2Bucket, prefix: string) {
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const result = await bucket.list({
			prefix,
			cursor,
			limit: 1000,
		});

		keys.push(...result.objects.map((object) => object.key));
		cursor = result.truncated ? result.cursor : undefined;
	} while (cursor);

	return keys;
}

async function deleteKeys(bucket: R2Bucket, keys: string[]) {
	for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
		await bucket.delete(keys.slice(index, index + DELETE_BATCH_SIZE));
	}
}

async function removeDirectory(bucket: R2Bucket, path: string, recursive: boolean) {
	const directory = normalizeDirectoryPath(path);
	const prefix = `${directory}/`;
	const marker = directoryMarkerKey(directory);
	const keys = await listKeysWithPrefix(bucket, prefix);

	if (keys.length === 0) {
		throw new Error(`${directory} does not exist.`);
	}

	if (!recursive) {
		const children = keys.filter((key) => key !== marker);

		if (children.length > 0) {
			throw new Error(`${directory} is not empty. Pass recursive: true to remove it.`);
		}

		await bucket.delete(marker);

		return {
			ok: true,
			path: directory,
			recursive,
			deletedCount: 1,
		};
	}

	await deleteKeys(bucket, keys);

	return {
		ok: true,
		path: directory,
		recursive,
		deletedCount: keys.length,
	};
}

async function uploadFileRequest(request: Request, env: Env, url: URL) {
	const key = normalizeFilesRoutePath(url);
	const overwrite = parseOverwriteParam(url);
	const size = parseContentLength(request);
	const sha256 = normalizeSha256Header(request);
	const sourceFilename = normalizeOptionalMetadataHeader(
		request,
		"x-atlas-source-filename",
		"X-Atlas-Source-Filename",
	);
	const body = request.body;

	if (body === null) {
		throw new Error("Upload request body is required.");
	}

	if (!overwrite && (await env.ATLAS_BUCKET.head(key))) {
		return errorResponse(`${key} already exists. Add ?overwrite=true to replace it.`, 409);
	}

	const contentType = request.headers.get("content-type") || contentTypeForUploadPath(key);
	const object = await env.ATLAS_BUCKET.put(key, body, {
		httpMetadata: {
			contentType,
		},
		customMetadata: {
			...(sha256 ? { sha256 } : {}),
			...(sourceFilename ? { sourceFilename } : {}),
		},
	});

	return jsonResponse({
		ok: true,
		path: key,
		size: object.size,
		etag: object.etag,
		sha256: sha256 ?? null,
		sourceFilename: sourceFilename ?? null,
		overwritten: overwrite,
		contentType,
		contentLength: size,
	});
}

function isPatchDirective(line: string) {
	return (
		line === "*** End Patch" ||
		line.startsWith("*** Add File: ") ||
		line.startsWith("*** Update File: ") ||
		line.startsWith("*** Delete File: ")
	);
}

function parsePatch(input: string): PatchOperation[] {
	const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const start = lines.findIndex((line) => line.trim() !== "");

	if (start === -1 || lines[start] !== "*** Begin Patch") {
		throw new Error("Patch must start with *** Begin Patch.");
	}

	const operations: PatchOperation[] = [];
	let index = start + 1;

	while (index < lines.length) {
		const line = lines[index];

		if (line === "*** End Patch") {
			const trailing = lines.slice(index + 1).some((value) => value.trim() !== "");

			if (trailing) {
				throw new Error("Patch contains content after *** End Patch.");
			}

			if (operations.length === 0) {
				throw new Error("Patch must contain at least one operation.");
			}

			return operations;
		}

		if (line.startsWith("*** Add File: ")) {
			const path = normalizeFilePath(line.slice("*** Add File: ".length));
			const addLines: string[] = [];
			let finalNewline = true;
			index++;

			while (index < lines.length && !isPatchDirective(lines[index])) {
				const addLine = lines[index];

				if (addLine === "\\ No newline at end of file") {
					finalNewline = false;
					index++;
					continue;
				}

				if (!addLine.startsWith("+")) {
					throw new Error(`Add file lines for ${path} must start with +.`);
				}

				addLines.push(addLine.slice(1));
				index++;
			}

			operations.push({
				kind: "add",
				path,
				content:
					addLines.length === 0 ? "" : addLines.join("\n") + (finalNewline ? "\n" : ""),
			});
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const path = normalizeFilePath(line.slice("*** Update File: ".length));
			const hunks: PatchHunk[] = [];
			index++;

			while (index < lines.length && !isPatchDirective(lines[index])) {
				if (!lines[index].startsWith("@@")) {
					throw new Error(`Update for ${path} must contain @@ hunks.`);
				}

				const hunkLines: PatchHunkLine[] = [];
				index++;

				while (
					index < lines.length &&
					!lines[index].startsWith("@@") &&
					!isPatchDirective(lines[index])
				) {
					const hunkLine = lines[index];

					if (
						hunkLine === "\\ No newline at end of file" ||
						hunkLine === "*** End of File"
					) {
						index++;
						continue;
					}

					const operator = hunkLine[0];

					if (operator !== " " && operator !== "+" && operator !== "-") {
						throw new Error(`Invalid hunk line for ${path}: ${hunkLine}`);
					}

					hunkLines.push({
						kind: operator === " " ? "context" : operator === "+" ? "add" : "remove",
						text: hunkLine.slice(1),
					});
					index++;
				}

				if (hunkLines.length === 0) {
					throw new Error(`Empty hunk in update for ${path}.`);
				}

				hunks.push({ lines: hunkLines });
			}

			if (hunks.length === 0) {
				throw new Error(`Update for ${path} must contain at least one hunk.`);
			}

			operations.push({ kind: "update", path, hunks });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			const path = normalizeFilePath(line.slice("*** Delete File: ".length));
			index++;

			if (index < lines.length && !isPatchDirective(lines[index])) {
				throw new Error(`Delete file operation for ${path} must not contain a body.`);
			}

			operations.push({ kind: "delete", path });
			continue;
		}

		if (line.trim() === "") {
			index++;
			continue;
		}

		throw new Error(`Unexpected patch line: ${line}`);
	}

	throw new Error("Patch must end with *** End Patch.");
}

function findSubsequence(lines: string[], needle: string[], start: number) {
	if (needle.length === 0) {
		return -1;
	}

	for (let index = start; index <= lines.length - needle.length; index++) {
		let matched = true;

		for (let offset = 0; offset < needle.length; offset++) {
			if (lines[index + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}

		if (matched) {
			return index;
		}
	}

	return -1;
}

function applyHunks(path: string, content: string, hunks: PatchHunk[]) {
	const lines = content.split("\n");
	let cursor = 0;

	for (const hunk of hunks) {
		const oldLines = hunk.lines
			.filter((line) => line.kind === "context" || line.kind === "remove")
			.map((line) => line.text);
		const newLines = hunk.lines
			.filter((line) => line.kind === "context" || line.kind === "add")
			.map((line) => line.text);

		if (oldLines.length === 0) {
			throw new Error(`Update hunk for ${path} must include context or removed lines.`);
		}

		const matchIndex = findSubsequence(lines, oldLines, cursor);

		if (matchIndex === -1) {
			throw new Error(`Patch hunk did not match ${path}.`);
		}

		lines.splice(matchIndex, oldLines.length, ...newLines);
		cursor = matchIndex + newLines.length;
	}

	return lines.join("\n");
}

async function applyTextPatch(bucket: R2Bucket, input: string) {
	const operations = parsePatch(input);
	const staged = new Map<string, string | null>();

	async function getCurrentText(path: string) {
		if (staged.has(path)) {
			return staged.get(path) ?? undefined;
		}

		return readTextObject(bucket, path);
	}

	for (const operation of operations) {
		if (operation.kind === "add") {
			const current = await getCurrentText(operation.path);

			if (current !== undefined) {
				throw new Error(`${operation.path} already exists.`);
			}

			assertSafeByteLength(operation.path, operation.content);
			staged.set(operation.path, operation.content);
			continue;
		}

		if (operation.kind === "update") {
			const current = await getCurrentText(operation.path);

			if (current === undefined) {
				throw new Error(`${operation.path} does not exist.`);
			}

			const next = applyHunks(operation.path, current, operation.hunks);
			assertSafeByteLength(operation.path, next);
			staged.set(operation.path, next);
			continue;
		}

		const current = await getCurrentText(operation.path);

		if (current === undefined) {
			throw new Error(`${operation.path} does not exist.`);
		}

		staged.set(operation.path, null);
	}

	const touched = [...staged.keys()];

	for (const [path, content] of staged) {
		if (content === null) {
			await bucket.delete(path);
			continue;
		}

		await bucket.put(path, content, {
			httpMetadata: {
				contentType: contentTypeForPath(path),
			},
		});
	}

	return {
		ok: true,
		touched,
		operations: operations.map((operation) => ({
			kind: operation.kind,
			path: operation.path,
		})),
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
		"list",
		{
			description: "List files and directories in the Atlas workspace.",
			inputSchema: {
				path: z.string().default("/"),
				cursor: z.string().optional(),
				limit: z.number().int().min(1).max(1000).default(100),
			},
		},
		async ({ path, cursor, limit }) => {
			const directory = normalizePath(path, {
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
				const withoutSlash = delimitedPrefix.replace(/\/$/, "");
				const entryPath = withoutSlash;

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
				path: directory,
				entries: [...directories, ...files].sort((left, right) =>
					left.name.localeCompare(right.name),
				),
				truncated: result.truncated,
				cursor: result.truncated ? result.cursor : null,
			});
		},
	);

	server.registerTool(
		"read",
		{
			description: "Read a UTF-8 text file from the Atlas workspace.",
			inputSchema: {
				path: z.string().min(1),
			},
		},
		async ({ path }) => {
			const key = normalizeFilePath(path);
			const content = await readTextObject(env.ATLAS_BUCKET, key);

			if (content === undefined) {
				throw new Error(`${key} does not exist.`);
			}

			return {
				content: [{ type: "text", text: content }],
			};
		},
	);

	server.registerTool(
		"read_many",
		{
			description: "Read multiple UTF-8 text files from the Atlas workspace in one call.",
			inputSchema: {
				paths: z.array(z.string()).min(1).max(50),
			},
		},
		async ({ paths }) => {
			const results = await Promise.all(
				paths.map((path) => readTextFileResult(env.ATLAS_BUCKET, path)),
			);

			return jsonContent({
				ok: true,
				results,
			});
		},
	);

	server.registerTool(
		"project_context",
		{
			description:
				"Read core Atlas project files and shallow knowledge/source catalogs for a project.",
			inputSchema: {
				path: z.string().min(1),
			},
		},
		async ({ path }) => {
			const projectPath = normalizeDirectoryPath(path);
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

	server.registerTool(
		"mkdir",
		{
			description: "Create a logical directory in the Atlas workspace.",
			inputSchema: {
				path: z.string().min(1),
			},
		},
		async ({ path }) => {
			const directory = normalizeDirectoryPath(path);
			const marker = directoryMarkerKey(directory);
			await env.ATLAS_BUCKET.put(marker, "", {
				httpMetadata: {
					contentType: "text/plain; charset=utf-8",
				},
				customMetadata: {
					atlasType: "directory",
				},
			});

			return jsonContent({
				ok: true,
				path: directory,
			});
		},
	);

	server.registerTool(
		"rmdir",
		{
			description: "Remove a logical directory from the Atlas workspace.",
			inputSchema: {
				path: z.string().min(1),
				recursive: z.boolean().default(false),
			},
		},
		async ({ path, recursive }) => {
			return jsonContent(await removeDirectory(env.ATLAS_BUCKET, path, recursive));
		},
	);

	server.registerTool(
		"apply_patch",
		{
			description: "Apply a text patch to files in the Atlas workspace.",
			inputSchema: {
				input: z.string().min(1),
			},
		},
		async ({ input }) => {
			return jsonContent(await applyTextPatch(env.ATLAS_BUCKET, input));
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

		if (url.pathname.startsWith("/files/")) {
			if (!requireApiKey(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}

			if (request.method !== "PUT") {
				return new Response("Method not allowed", {
					status: 405,
					headers: {
						allow: "PUT",
					},
				});
			}

			return uploadFileRequest(request, env, url).catch((error) => errorResponse(error));
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
