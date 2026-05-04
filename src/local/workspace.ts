import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export const PROJECT_CORE_FILE_NAMES = ["_project.md", "_state.md", "_index.md", "_log.md"] as const;
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const IGNORED_DIRECTORY_NAMES = new Set([
	".atlas",
	".git",
	".next",
	".wrangler",
	"build",
	"dist",
	"node_modules",
	"vendor",
]);

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

export type AtlasRelation = {
	type: string;
	target: string;
};

export type AtlasEvidence = {
	id?: string;
	source?: string;
	claim?: string;
	support?: string;
	confidence?: string;
	observedAt?: string;
};

export type AtlasObject = {
	path: string;
	id?: string;
	type?: string;
	title: string;
	status?: string;
	scope?: string;
	visibility?: string;
	confidence?: string;
	owners: string[];
	tags: string[];
	sourceSystems: string[];
	createdAt?: string;
	updatedAt?: string;
	validFrom?: string;
	validUntil?: string;
	staleAfter?: string;
	relations: AtlasRelation[];
	evidence: AtlasEvidence[];
	metacognition?: Record<string, unknown>;
	hasFrontmatter: boolean;
	frontmatterError?: string;
};

export type AtlasEdge = {
	from: string;
	to: string;
	type: string;
	kind: "relation" | "evidence" | "metadata" | "metacognition";
	resolved: boolean;
	sourcePath: string;
	targetPath?: string;
	evidenceId?: string;
	claim?: string;
};

export type AtlasGraph = {
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

export type AtlasHealthIssue = {
	severity: "info" | "warning" | "error";
	type: string;
	path: string;
	id?: string;
	message: string;
};

type NormalizeOptions = {
	allowRoot?: boolean;
	allowTrailingSlash?: boolean;
};

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

export function normalizeWorkspacePath(input: string, options: NormalizeOptions = {}) {
	const { allowRoot = false, allowTrailingSlash = false } = options;
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

function normalizeDirectoryPath(input: string) {
	return normalizeWorkspacePath(input, { allowTrailingSlash: true });
}

function normalizeFilePath(input: string) {
	return normalizeWorkspacePath(input);
}

function basename(input: string) {
	const parts = input.split("/");
	return parts[parts.length - 1] ?? input;
}

function toPosixPath(input: string) {
	return input.split(path.sep).join("/");
}

function fromPosixPath(input: string) {
	return input.split("/").join(path.sep);
}

function dirnamePosix(input: string) {
	return path.posix.dirname(input);
}

function joinRelativePath(basePath: string, target: string) {
	const joined = path.posix.normalize(path.posix.join(dirnamePosix(basePath), target));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
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

function parseRelations(value: unknown) {
	const relations: AtlasRelation[] = [];

	if (Array.isArray(value)) {
		for (const item of value) {
			const record = objectRecord(item);
			const type = record ? scalar(record.type ?? record.relation ?? record.kind) : undefined;
			const target = record ? scalar(record.target ?? record.to ?? record.id ?? record.path) : undefined;

			if (type && target) {
				relations.push({ type, target });
			}
		}

		return relations;
	}

	const record = objectRecord(value);

	if (!record) {
		return relations;
	}

	for (const [type, targets] of Object.entries(record)) {
		if (Array.isArray(targets)) {
			for (const target of targets) {
				const targetValue = scalar(target);

				if (targetValue) {
					relations.push({ type, target: targetValue });
				}
			}
			continue;
		}

		const target = scalar(targets);

		if (target) {
			relations.push({ type, target });
		}
	}

	return relations;
}

function parseEvidence(value: unknown) {
	if (!Array.isArray(value)) {
		return [];
	}

	const evidence: AtlasEvidence[] = [];

	for (const item of value) {
		const record = objectRecord(item);

		if (!record) {
			continue;
		}

		evidence.push({
			id: scalar(record.id),
			source: scalar(record.source),
			claim: scalar(record.claim),
			support: scalar(record.support),
			confidence: scalar(record.confidence),
			observedAt: scalar(record.observed_at ?? record.observedAt),
		});
	}

	return evidence;
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

function titleFromBody(body: string, filePath: string) {
	const match = body.match(/^#\s+(.+)$/m) ?? body.match(/^##\s+(.+)$/m);

	if (match?.[1]) {
		return match[1].trim();
	}

	return basename(filePath).replace(/\.md$/i, "");
}

function isAtlasIdLike(value: string) {
	return /^[a-z][a-z0-9_]*:[^\s]+$/i.test(value);
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

function normalizeTargetPath(target: string, sourcePath: string) {
	if (target.startsWith("/")) {
		return normalizeWorkspacePath(target, { allowRoot: true });
	}

	if (target.startsWith("./") || target.startsWith("../")) {
		return joinRelativePath(sourcePath, target);
	}

	return normalizeWorkspacePath(target, { allowRoot: true });
}

function isKnowledgePath(filePath: string) {
	return (
		filePath.includes("/knowledge/") ||
		filePath.startsWith("knowledge/") ||
		/^(decisions|assumptions|commitments|incidents|risks|sources|customers|people|teams)\//.test(
			filePath,
		)
	);
}

function requiredFrontmatterFields(object: AtlasObject) {
	const missing: string[] = [];

	for (const field of ["id", "type", "title", "status", "created_at", "updated_at"] as const) {
		if (field === "created_at") {
			if (!object.createdAt) {
				missing.push(field);
			}
			continue;
		}

		if (field === "updated_at") {
			if (!object.updatedAt) {
				missing.push(field);
			}
			continue;
		}

		if (!object[field]) {
			missing.push(field);
		}
	}

	return missing;
}

function extractDissentingViews(metacognition: Record<string, unknown> | undefined) {
	const views = metacognition ? metacognition.dissenting_views : undefined;
	return stringArray(views);
}

function safeToAct(metacognition: Record<string, unknown> | undefined) {
	const guidance = objectRecord(metacognition?.agent_guidance);
	return typeof guidance?.safe_to_act === "boolean" ? guidance.safe_to_act : undefined;
}

function dateIsPast(value: string | undefined, now: Date) {
	if (!value) {
		return false;
	}

	const timestamp = Date.parse(value);

	if (Number.isNaN(timestamp)) {
		return false;
	}

	return timestamp < now.getTime();
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
			const filePath = normalizeFilePath(line.slice("*** Add File: ".length));
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
					throw new Error(`Add file lines for ${filePath} must start with +.`);
				}

				addLines.push(addLine.slice(1));
				index++;
			}

			operations.push({
				kind: "add",
				path: filePath,
				content:
					addLines.length === 0 ? "" : addLines.join("\n") + (finalNewline ? "\n" : ""),
			});
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const filePath = normalizeFilePath(line.slice("*** Update File: ".length));
			const hunks: PatchHunk[] = [];
			index++;

			while (index < lines.length && !isPatchDirective(lines[index])) {
				if (!lines[index].startsWith("@@")) {
					throw new Error(`Update for ${filePath} must contain @@ hunks.`);
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
						throw new Error(`Invalid hunk line for ${filePath}: ${hunkLine}`);
					}

					hunkLines.push({
						kind: operator === " " ? "context" : operator === "+" ? "add" : "remove",
						text: hunkLine.slice(1),
					});
					index++;
				}

				if (hunkLines.length === 0) {
					throw new Error(`Empty hunk in update for ${filePath}.`);
				}

				hunks.push({ lines: hunkLines });
			}

			if (hunks.length === 0) {
				throw new Error(`Update for ${filePath} must contain at least one hunk.`);
			}

			operations.push({ kind: "update", path: filePath, hunks });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			const filePath = normalizeFilePath(line.slice("*** Delete File: ".length));
			index++;

			if (index < lines.length && !isPatchDirective(lines[index])) {
				throw new Error(`Delete file operation for ${filePath} must not contain a body.`);
			}

			operations.push({ kind: "delete", path: filePath });
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

function applyHunks(filePath: string, content: string, hunks: PatchHunk[]) {
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
			throw new Error(`Update hunk for ${filePath} must include context or removed lines.`);
		}

		const matchIndex = findSubsequence(lines, oldLines, cursor);

		if (matchIndex === -1) {
			throw new Error(`Patch hunk did not match ${filePath}.`);
		}

		lines.splice(matchIndex, oldLines.length, ...newLines);
		cursor = matchIndex + newLines.length;
	}

	return lines.join("\n");
}

export class LocalAtlasWorkspace {
	readonly root: string;
	readonly stateDir: string;

	constructor(root: string) {
		this.root = path.resolve(root);
		this.stateDir = path.join(this.root, ".atlas");
	}

	static fromEnv(root?: string) {
		return new LocalAtlasWorkspace(root ?? process.env.ATLAS_WORKSPACE ?? process.cwd());
	}

	async ensureReady() {
		await mkdir(this.root, { recursive: true });
		await mkdir(this.stateDir, { recursive: true });
	}

	resolvePath(workspacePath: string, options: NormalizeOptions = {}) {
		const normalized = normalizeWorkspacePath(workspacePath, options);
		const absolute = path.resolve(this.root, fromPosixPath(normalized));

		if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) {
			throw new Error(`${workspacePath} escapes the Atlas workspace.`);
		}

		return {
			workspacePath: normalized,
			absolute,
		};
	}

	dbPath(input?: string) {
		return path.resolve(input ?? process.env.ATLAS_QMD_DB ?? path.join(this.stateDir, "qmd.sqlite"));
	}

	async readText(workspacePath: string) {
		const { workspacePath: normalized, absolute } = this.resolvePath(workspacePath);
		const info = await stat(absolute);

		if (!info.isFile()) {
			throw new Error(`${normalized} is not a file.`);
		}

		if (info.size > MAX_TEXT_FILE_BYTES) {
			throw new Error(`${normalized} is too large to read as text (${info.size} bytes).`);
		}

		return readFile(absolute, "utf8");
	}

	async readTextResult(workspacePath: string) {
		let normalized: string;

		try {
			normalized = normalizeFilePath(workspacePath);
		} catch (error) {
			return {
				ok: false as const,
				path: workspacePath,
				error: errorMessage(error),
			};
		}

		try {
			const content = await this.readText(normalized);

			return {
				ok: true as const,
				path: normalized,
				content,
			};
		} catch (error) {
			return {
				ok: false as const,
				path: normalized,
				error: errorMessage(error),
			};
		}
	}

	async readMany(paths: string[]) {
		return Promise.all(paths.map((item) => this.readTextResult(item)));
	}

	async writeText(workspacePath: string, content: string, options?: { overwrite?: boolean }) {
		const { workspacePath: normalized, absolute } = this.resolvePath(workspacePath);

		if (new TextEncoder().encode(content).byteLength > MAX_TEXT_FILE_BYTES) {
			throw new Error(`${normalized} is too large for text writing.`);
		}

		if (!options?.overwrite) {
			try {
				await access(absolute);
				throw new Error(`${normalized} already exists. Pass overwrite: true to replace it.`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
		}

		await mkdir(path.dirname(absolute), { recursive: true });
		await writeFile(absolute, content, "utf8");

		return {
			ok: true,
			path: normalized,
			bytes: new TextEncoder().encode(content).byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
			overwritten: Boolean(options?.overwrite),
		};
	}

	async list(workspacePath = "/") {
		const { workspacePath: normalized, absolute } = this.resolvePath(workspacePath, {
			allowRoot: true,
			allowTrailingSlash: true,
		});

		try {
			const entries = await readdir(absolute, { withFileTypes: true });
			const results = await Promise.all(
				entries
					.filter((entry) => entry.name !== ".DS_Store")
					.map(async (entry) => {
						const childWorkspacePath = normalized
							? `${normalized}/${entry.name}`
							: entry.name;
						const childAbsolute = path.join(absolute, entry.name);

						if (entry.isDirectory()) {
							return {
								type: "directory" as const,
								name: entry.name,
								path: childWorkspacePath,
							};
						}

						if (!entry.isFile()) {
							return undefined;
						}

						const info = await stat(childAbsolute);

						return {
							type: "file" as const,
							name: entry.name,
							path: childWorkspacePath,
							size: info.size,
							modified: info.mtime.toISOString(),
						};
					}),
			);

			return {
				path: normalized,
				exists: true,
				entries: results
					.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
					.sort((left, right) => left.name.localeCompare(right.name)),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					path: normalized,
					exists: false,
					entries: [],
				};
			}

			throw error;
		}
	}

	async projectContext(workspacePath: string) {
		const projectPath = normalizeDirectoryPath(workspacePath);
		const [coreFiles, knowledge, sources] = await Promise.all([
			Promise.all(
				PROJECT_CORE_FILE_NAMES.map(async (name) => {
					const filePath = `${projectPath}/${name}`;
					const result = await this.readTextResult(filePath);

					if (!result.ok && /ENOENT|no such file or directory/i.test(result.error)) {
						return undefined;
					}

					return {
						...result,
						name,
					};
				}),
			),
			this.list(`${projectPath}/knowledge`),
			this.list(`${projectPath}/sources`),
		]);

		return {
			ok: true,
			path: projectPath,
			coreFiles: coreFiles.filter((file) => file !== undefined),
			knowledge,
			sources,
		};
	}

	async enumerateMarkdownFiles() {
		const files: string[] = [];

		const walk = async (absoluteDirectory: string, relativeDirectory: string) => {
			let entries;

			try {
				entries = await readdir(absoluteDirectory, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return;
				}

				throw error;
			}

			for (const entry of entries) {
				if (entry.name === ".DS_Store") {
					continue;
				}

				if (entry.isDirectory()) {
					if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
						continue;
					}

					await walk(path.join(absoluteDirectory, entry.name), path.posix.join(relativeDirectory, entry.name));
					continue;
				}

				if (!entry.isFile() || !entry.name.endsWith(".md")) {
					continue;
				}

				files.push(path.posix.join(relativeDirectory, entry.name));
			}
		};

		await walk(this.root, "");

		return files.sort((left, right) => left.localeCompare(right));
	}

	async readAtlasObject(workspacePath: string): Promise<AtlasObject> {
		const normalized = normalizeFilePath(workspacePath);
		const content = await this.readText(normalized);
		const parsed = extractFrontmatter(content);
		const frontmatter = parsed.frontmatter ?? {};
		const metacognition = objectRecord(frontmatter.metacognition);

		return {
			path: normalized,
			id: scalar(frontmatter.id),
			type: scalar(frontmatter.type),
			title: scalar(frontmatter.title) ?? titleFromBody(parsed.body, normalized),
			status: scalar(frontmatter.status),
			scope: scalar(frontmatter.scope),
			visibility: scalar(frontmatter.visibility),
			confidence: scalar(frontmatter.confidence),
			owners: stringArray(frontmatter.owners),
			tags: stringArray(frontmatter.tags),
			sourceSystems: stringArray(frontmatter.source_systems ?? frontmatter.sourceSystems),
			createdAt: scalar(frontmatter.created_at ?? frontmatter.createdAt),
			updatedAt: scalar(frontmatter.updated_at ?? frontmatter.updatedAt),
			validFrom: scalar(frontmatter.valid_from ?? frontmatter.validFrom),
			validUntil: scalar(frontmatter.valid_until ?? frontmatter.validUntil),
			staleAfter: scalar(frontmatter.stale_after ?? frontmatter.staleAfter),
			relations: parseRelations(frontmatter.relations),
			evidence: parseEvidence(frontmatter.evidence),
			...(metacognition ? { metacognition } : {}),
			hasFrontmatter: parsed.hasFrontmatter,
			...(parsed.error ? { frontmatterError: parsed.error } : {}),
		};
	}

	async buildGraph(): Promise<AtlasGraph> {
		const paths = await this.enumerateMarkdownFiles();
		const objects = await Promise.all(paths.map((filePath) => this.readAtlasObject(filePath)));
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
				return {
					resolved: false,
				};
			}

			const targetPath = normalizeTargetPath(target, sourcePath);

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
					type: relation.type,
					kind: "relation",
					sourcePath: object.path,
					resolved: resolution.resolved,
					...(resolution.targetPath ? { targetPath: resolution.targetPath } : {}),
				});
			}

			for (const evidence of object.evidence) {
				if (!evidence.source) {
					continue;
				}

				const resolution = resolveTarget(evidence.source, object.path);
				edges.push({
					from,
					to: evidence.source,
					type: evidence.support ?? "evidence",
					kind: "evidence",
					sourcePath: object.path,
					resolved: resolution.resolved,
					...(resolution.targetPath ? { targetPath: resolution.targetPath } : {}),
					...(evidence.id ? { evidenceId: evidence.id } : {}),
					...(evidence.claim ? { claim: evidence.claim } : {}),
				});
			}

			for (const owner of object.owners) {
				const resolution = resolveTarget(owner, object.path);
				edges.push({
					from,
					to: owner,
					type: "owned_by",
					kind: "metadata",
					sourcePath: object.path,
					resolved: resolution.resolved,
					...(resolution.targetPath ? { targetPath: resolution.targetPath } : {}),
				});
			}

			for (const dissent of extractDissentingViews(object.metacognition)) {
				const resolution = resolveTarget(dissent, object.path);
				edges.push({
					from,
					to: dissent,
					type: "dissenting_view",
					kind: "metacognition",
					sourcePath: object.path,
					resolved: resolution.resolved,
					...(resolution.targetPath ? { targetPath: resolution.targetPath } : {}),
				});
			}
		}

		for (const edge of edges) {
			if (!edge.resolved && edge.kind !== "metadata" && edge.kind !== "metacognition") {
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

	async healthCheck() {
		const graph = await this.buildGraph();
		const now = new Date();
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
			} else if (isKnowledgePath(object.path)) {
				issues.push(
					makeIssue(
						"info",
						"missing_frontmatter",
						object,
						"Knowledge/source page has no Atlas frontmatter yet.",
					),
				);
			}

			if (object.status === "active" && dateIsPast(object.staleAfter, now)) {
				issues.push(
					makeIssue(
						"warning",
						"stale_object",
						object,
						`Object is active but stale_after has passed (${object.staleAfter}).`,
					),
				);
			}

			if (object.type === "commitment" && object.status === "active" && object.owners.length === 0) {
				issues.push(
					makeIssue(
						"warning",
						"ownerless_commitment",
						object,
						"Active commitment has no owner.",
					),
				);
			}

			if (safeToAct(object.metacognition) === false) {
				issues.push(
					makeIssue(
						"info",
						"agent_action_requires_review",
						object,
						"Metacognition says this object is not safe for autonomous action.",
					),
				);
			}
		}

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
			graph.byPath.get(normalizeWorkspacePath(idOrPath, { allowRoot: true }));

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
					graph.byId.get(edge.to) ?? (edge.targetPath ? graph.byPath.get(edge.targetPath) : undefined);
				const targetKey = targetObject?.id ?? targetObject?.path;

				return targetKey === current.key;
			});

			for (const edge of adjacent) {
				includedEdges.push(edge);

				const targets = [edge.from, edge.to];

				if (edge.targetPath) {
					const targetObject = graph.byPath.get(edge.targetPath);
					const targetKey = targetObject?.id ?? targetObject?.path;

					if (targetKey) {
						targets.push(targetKey);
					}
				}

				for (const target of targets) {
					const object = graph.byId.get(target) ?? graph.byPath.get(target);
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

	private async stageTextPatch(input: string) {
		const operations = parsePatch(input);
		const staged = new Map<string, string | null>();

		const getCurrentText = async (workspacePath: string) => {
			if (staged.has(workspacePath)) {
				return staged.get(workspacePath) ?? undefined;
			}

			try {
				return await this.readText(workspacePath);
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code === "ENOENT" ||
					/ENOENT|no such file or directory/i.test(errorMessage(error))
				) {
					return undefined;
				}

				throw error;
			}
		};

		for (const operation of operations) {
			if (operation.kind === "add") {
				const current = await getCurrentText(operation.path);

				if (current !== undefined) {
					throw new Error(`${operation.path} already exists.`);
				}

				staged.set(operation.path, operation.content);
				continue;
			}

			if (operation.kind === "update") {
				const current = await getCurrentText(operation.path);

				if (current === undefined) {
					throw new Error(`${operation.path} does not exist.`);
				}

				staged.set(operation.path, applyHunks(operation.path, current, operation.hunks));
				continue;
			}

			const current = await getCurrentText(operation.path);

			if (current === undefined) {
				throw new Error(`${operation.path} does not exist.`);
			}

			staged.set(operation.path, null);
		}

		return {
			operations,
			staged,
		};
	}

	async proposeTextPatch(input: string) {
		const { operations, staged } = await this.stageTextPatch(input);

		return {
			ok: true,
			mode: "propose" as const,
			touched: [...staged.keys()],
			operations: operations.map((operation) => ({
				kind: operation.kind,
				path: operation.path,
			})),
		};
	}

	async applyTextPatch(input: string) {
		const { operations, staged } = await this.stageTextPatch(input);

		for (const [workspacePath, content] of staged) {
			const { absolute } = this.resolvePath(workspacePath);

			if (content === null) {
				await rm(absolute);
				continue;
			}

			await mkdir(path.dirname(absolute), { recursive: true });
			await writeFile(absolute, content, "utf8");
		}

		return {
			ok: true,
			touched: [...staged.keys()],
			operations: operations.map((operation) => ({
				kind: operation.kind,
				path: operation.path,
			})),
		};
	}
}

export function atlasPathFromQmdDisplayPath(displayPath: string, collectionName: string) {
	if (displayPath.startsWith(`${collectionName}/`)) {
		return displayPath.slice(collectionName.length + 1);
	}

	return displayPath;
}
