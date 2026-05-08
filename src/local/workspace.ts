import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	copyFile,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export const PROJECT_CORE_FILE_NAMES = [
	"_project.md",
	"_state.md",
	"_index.md",
] as const;
const PROJECT_CORE_FILE_NAME_SET = new Set<string>(PROJECT_CORE_FILE_NAMES);
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 250 * 1024 * 1024;

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

export type AtlasRelation = {
	target: string;
};

export type AtlasObject = {
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

export type AtlasEdge = {
	from: string;
	to: string;
	type: string;
	kind: "relation";
	resolved: boolean;
	sourcePath: string;
	targetPath?: string;
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

export type AtlasFrontmatterInput = {
	id: string;
	title: string;
	updated_at?: string;
	sources?: string[];
	relations?: string[];
};

export type AtlasKnowledgeKind =
	| "conversation"
	| "topic"
	| "decision"
	| "report"
	| "research"
	| "artifact"
	| "source"
	| "assumption"
	| "commitment"
	| "risk"
	| "product_gap"
	| "incident"
	| "strategy"
	| "fact"
	| "event";

export type AtlasCoreRole = "atlas" | "client" | "project" | "state" | "index";

type NormalizeOptions = {
	allowRoot?: boolean;
	allowTrailingSlash?: boolean;
};

type ProjectScope = {
	client: string;
	project: string;
};

type StateTask = {
	owner?: string;
	task: string;
	done?: boolean;
};

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function isAlreadyExistsError(error: unknown) {
	return /already exists/i.test(errorMessage(error));
}

function sha256File(absolutePath: string) {
	return new Promise<string>((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(absolutePath);

		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
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

function parseRelations(value: unknown): AtlasRelation[] {
	return stringArray(value).map((target) => ({ target }));
}

function typeFromId(id: string | undefined) {
	if (!id) {
		return undefined;
	}

	const match = id.match(/^([a-z][a-z0-9_]*):/i);
	return match ? match[1] : undefined;
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
		frontmatter.relations = [
			...new Set(input.relations.map((item) => item.trim()).filter(Boolean)),
		];
	}

	return YAML.stringify(frontmatter).trimEnd();
}

function renderMarkdownObject(frontmatter: AtlasFrontmatterInput, body: string) {
	const normalizedBody = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${normalizedBody}\n`;
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

function titleFromBody(body: string, filePath: string) {
	const match = body.match(/^#\s+(.+)$/m) ?? body.match(/^##\s+(.+)$/m);

	if (match?.[1]) {
		return match[1].trim();
	}

	return basename(filePath).replace(/\.md$/i, "");
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

function projectRootForPath(sourcePath: string) {
	const match = sourcePath.match(/^(clients\/[^/]+\/projects\/[^/]+)\//);
	return match?.[1];
}

function isProjectRelativePath(target: string) {
	return !target.includes("/") || PROJECT_CORE_FILE_NAME_SET.has(target);
}

function normalizeAtlasReferencePath(target: string, sourcePath: string) {
	if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) {
		return normalizeTargetPath(target, sourcePath);
	}

	if (target.startsWith("clients/") || target === "_atlas.md") {
		return normalizeWorkspacePath(target, { allowRoot: true });
	}

	const projectRoot = projectRootForPath(sourcePath);

	if (projectRoot && isProjectRelativePath(target)) {
		return normalizeWorkspacePath(`${projectRoot}/${target}`, { allowRoot: true });
	}

	return normalizeWorkspacePath(target, { allowRoot: true });
}

function isKnowledgePath(filePath: string) {
	const projectRoot = projectRootForPath(filePath);

	if (projectRoot) {
		const relativePath = filePath.slice(projectRoot.length + 1);
		return (
			relativePath.endsWith(".md") &&
			!PROJECT_CORE_FILE_NAME_SET.has(relativePath)
		);
	}

	return /^(decisions|assumptions|commitments|incidents|risks|customers|people|teams)\//.test(
		filePath,
	);
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

	return {
		headingIndex,
		endIndex,
	};
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

	const updatedSection = ["", ...section, line, ""];

	return ensureTrailingNewline(
		[...before, ...updatedSection, ...after].join("\n").replace(/\n{3,}/g, "\n\n"),
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

function replaceHeadingSection(body: string, heading: string, sectionBody: string) {
	const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const range = findHeadingRange(lines, heading);
	const replacement = [`## ${heading}`, "", sectionBody.trim(), ""];

	if (!range) {
		const trimmed = body.trimEnd();
		return `${trimmed}${trimmed ? "\n\n" : ""}${replacement.join("\n")}\n`;
	}

	return ensureTrailingNewline(
		[...lines.slice(0, range.headingIndex), ...replacement, ...lines.slice(range.endIndex)]
			.join("\n")
			.replace(/\n{3,}/g, "\n\n"),
	);
}

function upsertIndexEntry(
	body: string,
	pathTarget: string,
	title: string,
	kind?: string,
	summary?: string,
) {
	const entry = `- [${title}](${pathTarget}) - ${kind?.trim() || "knowledge"} - ${summary?.trim() || "Knowledge page."}`;
	return upsertHeadingListLink(body, "Knowledge Pages", pathTarget, entry);
}

function removeIndexEntry(body: string, pathTarget: string) {
	return removeHeadingListLink(body, "Knowledge Pages", pathTarget, "_No knowledge pages yet._");
}

function markdownLinkTargets(content: string) {
	return new Set(
		[...content.matchAll(/\]\(([^)]+)\)/g)].map((match) => (match[1] ?? "").split("#", 1)[0]),
	);
}

function formatTasks(tasks: StateTask[] | undefined) {
	if (!tasks || tasks.length === 0) {
		return [];
	}

	return tasks.map((task) => {
		const owner = task.owner?.trim() || "Unassigned";
		return `- [${task.done ? "x" : " "}] (${owner}) ${task.task.trim()}`;
	});
}

function stringSection(title: string, values: string[] | undefined) {
	if (!values || values.length === 0) {
		return [];
	}

	return [`## ${title}`, "", ...values.map((value) => `- ${value.trim()}`), ""];
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
		return path.resolve(
			input ?? process.env.ATLAS_QMD_DB ?? path.join(this.stateDir, "qmd.sqlite"),
		);
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

	private async writeText(
		workspacePath: string,
		content: string,
		options?: { overwrite?: boolean },
	) {
		const { workspacePath: normalized, absolute } = this.resolvePath(workspacePath);

		if (new TextEncoder().encode(content).byteLength > MAX_TEXT_FILE_BYTES) {
			throw new Error(`${normalized} is too large for text writing.`);
		}

		if (!options?.overwrite) {
			try {
				await access(absolute);
				throw new Error(
					`${normalized} already exists. Pass overwrite: true to replace it.`,
				);
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

	private async uploadFile(
		localPath: string,
		workspacePath: string,
		options?: { overwrite?: boolean },
	) {
		if (!path.isAbsolute(localPath)) {
			throw new Error("localPath must be an absolute filesystem path.");
		}

		const sourceAbsolute = path.resolve(localPath);
		const { workspacePath: normalized, absolute } = this.resolvePath(workspacePath);
		const info = await stat(sourceAbsolute);

		if (!info.isFile()) {
			throw new Error(`${sourceAbsolute} is not a file.`);
		}

		if (info.size > MAX_UPLOAD_FILE_BYTES) {
			throw new Error(`${sourceAbsolute} is too large to upload (${info.size} bytes).`);
		}

		if (sourceAbsolute === absolute) {
			throw new Error("Source and destination paths are the same file.");
		}

		if (!options?.overwrite) {
			try {
				await access(absolute);
				throw new Error(
					`${normalized} already exists. Pass overwrite: true to replace it.`,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
		}

		await mkdir(path.dirname(absolute), { recursive: true });
		await copyFile(sourceAbsolute, absolute);

		return {
			ok: true,
			path: normalized,
			localPath: sourceAbsolute,
			bytes: info.size,
			sha256: await sha256File(absolute),
			overwritten: Boolean(options?.overwrite),
		};
	}

	private async deleteFile(
		workspacePath: string,
		options?: { missingOk?: boolean; recursive?: boolean },
	) {
		const { workspacePath: normalized, absolute } = this.resolvePath(workspacePath);

		let info;

		try {
			info = await stat(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && options?.missingOk) {
				return {
					ok: true,
					path: normalized,
					deleted: false,
					missing: true,
				};
			}

			throw error;
		}

		if (!info.isFile() && !info.isDirectory()) {
			throw new Error(`${normalized} is not a file or directory.`);
		}

		if (info.isDirectory() && !options?.recursive) {
			throw new Error(`${normalized} is a directory. Pass recursive: true to delete it.`);
		}

		await rm(absolute, { recursive: info.isDirectory(), force: false });

		return {
			ok: true,
			path: normalized,
			deleted: true,
			type: info.isDirectory() ? "directory" : "file",
			...(info.isFile() ? { bytes: info.size } : {}),
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
		const [coreFiles, projectListing] = await Promise.all([
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
			this.list(projectPath),
		]);

		const pages = {
			...projectListing,
			entries: projectListing.entries.filter(
				(entry) =>
					entry.type === "file" &&
					entry.name.endsWith(".md") &&
					!PROJECT_CORE_FILE_NAME_SET.has(entry.name),
			),
		};

		return {
			ok: true,
			path: projectPath,
			coreFiles: coreFiles.filter((file) => file !== undefined),
			pages,
		};
	}

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

	sourceFile(scope: ProjectScope, name: string) {
		const slug = this.objectSlug(name);
		return `${this.projectDirectory(scope)}/sources/${slug}.md`;
	}

	private normalizeScope(input: { client?: string; project?: string }) {
		return {
			...(input.client ? { client: this.clientSlug(input.client) } : {}),
			...(input.project ? { project: this.projectSlug(input.project) } : {}),
		};
	}

	private requireScopeForRole(
		role: AtlasCoreRole,
		input: { client?: string; project?: string },
	): { client?: string; project?: string } {
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

	private async requireClient(client: string) {
		const clientPath = this.clientFile(client);
		try {
			await this.readAtlasObject(clientPath);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" ||
				/ENOENT|no such file or directory/i.test(errorMessage(error))
			) {
				throw new Error(
					`Atlas client does not exist: ${client}. Create it first with atlas_core_create using role "client".`,
				);
			}

			throw error;
		}
	}

	private async requireProjectScaffold(scope: ProjectScope) {
		await this.requireClient(scope.client);

		const requiredPaths = [
			this.projectFile(scope),
			this.stateFile(scope),
			this.indexFile(scope),
		];
		const missing = [];

		for (const requiredPath of requiredPaths) {
			const content = await this.readOptionalText(requiredPath);

			if (content === undefined) {
				missing.push(requiredPath);
			}
		}

		if (missing.length > 0) {
			throw new Error(
				`Atlas project scaffold is incomplete for ${scope.client}/${scope.project}. Create or repair it first with atlas_core_create using role "project". Missing: ${missing.join(", ")}.`,
			);
		}
	}

	private async readOptionalText(workspacePath: string) {
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
	}

	private async writeMarkdownObject(
		workspacePath: string,
		frontmatter: AtlasFrontmatterInput,
		body: string,
	) {
		return this.writeText(workspacePath, renderMarkdownObject(frontmatter, body), {
			overwrite: true,
		});
	}

	private async createMarkdownObject(
		workspacePath: string,
		frontmatter: AtlasFrontmatterInput,
		body: string,
	) {
		return this.writeText(workspacePath, renderMarkdownObject(frontmatter, body), {
			overwrite: false,
		});
	}

	private async requireObject(workspacePath: string) {
		const content = await this.readText(workspacePath);
		const object = await this.readAtlasObject(workspacePath);
		return {
			content,
			object,
			parsed: parseMarkdownObject(content, workspacePath),
		};
	}

	private async ensureAtlasRoot() {
		const existing = await this.readOptionalText("_atlas.md");

		if (existing !== undefined) {
			return existing;
		}

		const body =
			"# DAYONE Knowledge\n\n## Context\n\nDAYONE company knowledge.\n\n## Clients\n\n_No clients yet._\n";
		await this.writeMarkdownObject(
			"_atlas.md",
			{
				id: "atlas:root",
				title: "DAYONE Knowledge",
				relations: [],
			},
			body,
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

	async listClients() {
		const listing = await this.list("clients");
		const clients = [];

		for (const entry of listing.entries) {
			if (entry.type !== "directory") {
				continue;
			}

			const filePath = `${entry.path}/_client.md`;
			const content = await this.readOptionalText(filePath);

			if (content === undefined) {
				continue;
			}

			clients.push(await this.readAtlasObject(filePath));
		}

		return {
			ok: true,
			clients,
		};
	}

	async getClient(client: string) {
		const clientPath = this.clientFile(client);
		const object = await this.readAtlasObject(clientPath);
		const projects = await this.listProjects(client);

		return {
			ok: true,
			client: object,
			projects: projects.projects,
		};
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

		const body = [
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
		].join("\n");

		try {
			await this.createMarkdownObject(
				clientPath,
				{
					id: `client:${client}`,
					title: input.title,
					sources: input.sources,
					relations: [],
				},
				body,
			);
		} catch (error) {
			if (!isAlreadyExistsError(error)) {
				throw error;
			}

			const object = await this.readAtlasObject(clientPath);
			await this.updateAtlasClientLink(client, object.title, "upsert");

			return {
				ok: true,
				created: false,
				client: object,
				changedPaths: ["_atlas.md"],
			};
		}
		await this.updateAtlasClientLink(client, input.title, "upsert");

		return {
			ok: true,
			created: true,
			client: await this.readAtlasObject(clientPath),
			changedPaths: ["_atlas.md", clientPath],
		};
	}

	async updateClient(input: {
		client: string;
		title?: string;
		context?: string;
		sources?: string[];
		relations?: string[];
	}) {
		const client = this.clientSlug(input.client);
		const clientPath = this.clientFile(client);
		const { parsed } = await this.requireObject(clientPath);
		const title = input.title?.trim() || parsed.title;
		let body = parsed.body;

		if (input.context !== undefined) {
			body = replaceHeadingSection(body, "Context", input.context);
		}

		await this.writeMarkdownObject(
			clientPath,
			{
				id: scalar(parsed.frontmatter.id) ?? `client:${client}`,
				title,
				sources: input.sources ?? parsed.sources,
				relations: input.relations ?? parsed.relations,
			},
			body,
		);
		await this.updateAtlasClientLink(client, title, "upsert");

		return {
			ok: true,
			client: await this.readAtlasObject(clientPath),
			changedPaths: [clientPath, "_atlas.md"],
		};
	}

	async deleteClient(clientInput: string) {
		const client = this.clientSlug(clientInput);
		const clientPath = this.clientFile(client);
		const clientDir = this.clientDirectory(client);
		const existing = await this.readAtlasObject(clientPath);
		await this.deleteFile(clientDir, { recursive: true });
		await this.updateAtlasClientLink(client, existing.title, "remove");

		return {
			ok: true,
			deleted: existing,
			changedPaths: [clientDir, "_atlas.md"],
		};
	}

	async listProjects(clientInput: string) {
		const client = this.clientSlug(clientInput);
		await this.requireClient(client);
		const listing = await this.list(`${this.clientDirectory(client)}/projects`);
		const projects = [];

		for (const entry of listing.entries) {
			if (entry.type !== "directory") {
				continue;
			}

			const filePath = `${entry.path}/_project.md`;
			const content = await this.readOptionalText(filePath);

			if (content === undefined) {
				continue;
			}

			projects.push(await this.readAtlasObject(filePath));
		}

		return {
			ok: true,
			client,
			projects,
		};
	}

	async getProject(scope: ProjectScope) {
		const normalizedScope = {
			client: this.clientSlug(scope.client),
			project: this.projectSlug(scope.project),
		};
		await this.requireProjectScaffold(normalizedScope);
		return this.projectContext(this.projectDirectory(normalizedScope));
	}

	async createProject(input: {
		client: string;
		project: string;
		title: string;
		context?: string;
		state?: string;
	}) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireClient(scope.client);

		const projectRoot = this.projectDirectory(scope);
		const projectTitle = input.title.trim();
		const existing = await this.readOptionalText(`${projectRoot}/_project.md`);

		if (existing !== undefined) {
			const object = await this.readAtlasObject(`${projectRoot}/_project.md`);
			const changedPaths = [this.clientFile(scope.client)];

			if ((await this.readOptionalText(`${projectRoot}/_state.md`)) === undefined) {
				await this.createMarkdownObject(
					`${projectRoot}/_state.md`,
					{
						id: `state:${scope.client}-${scope.project}`,
						title: `Live State - ${object.title}`,
						relations: ["_project.md"],
					},
					[
						`# ${object.title} State`,
						"",
						"Current operating state has not been captured yet.",
						"",
						"## Project",
						"",
						"- [_project](_project.md)",
						"",
					].join("\n"),
				);
				changedPaths.push(`${projectRoot}/_state.md`);
			}

			if ((await this.readOptionalText(`${projectRoot}/_index.md`)) === undefined) {
				await this.createMarkdownObject(
					`${projectRoot}/_index.md`,
					{
						id: `index:${scope.client}-${scope.project}`,
						title: `Index - ${object.title}`,
						relations: ["_project.md", "_state.md"],
					},
					[
						`# ${object.title} Index`,
						"",
						"## Core Files",
						"",
						"- [_project](_project.md) - stable project context",
						"- [_state](_state.md) - live operating state",
						"",
						"## Knowledge Pages",
						"",
						"_No knowledge pages yet._",
						"",
					].join("\n"),
				);
				changedPaths.push(`${projectRoot}/_index.md`);
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
		const stateBody = [
			`# ${projectTitle} State`,
			"",
			input.state?.trim() || "Current operating state has not been captured yet.",
			"",
			"## Project",
			"",
			"- [_project](_project.md)",
			"",
		].join("\n");
		const indexBody = [
			`# ${projectTitle} Index`,
			"",
			"## Core Files",
			"",
			"- [_project](_project.md) - stable project context",
			"- [_state](_state.md) - live operating state",
			"",
			"## Knowledge Pages",
			"",
			"_No knowledge pages yet._",
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
			stateBody,
		);
		await this.createMarkdownObject(
			`${projectRoot}/_index.md`,
			{
				id: `index:${scope.client}-${scope.project}`,
				title: `Index - ${projectTitle}`,
				relations: ["_project.md", "_state.md"],
			},
			indexBody,
		);
		await this.updateClientProjectLink(scope, projectTitle, "upsert");

		return {
			ok: true,
			created: true,
			project: await this.readAtlasObject(`${projectRoot}/_project.md`),
			changedPaths: [
				this.clientFile(scope.client),
				`${projectRoot}/_project.md`,
				`${projectRoot}/_state.md`,
				`${projectRoot}/_index.md`,
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
			const existing = await this.readOptionalText("_atlas.md");

			if (existing !== undefined) {
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
		const existing = await this.readOptionalText(corePath);

		if (existing !== undefined) {
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

	async updateProject(input: {
		client: string;
		project: string;
		title?: string;
		context?: string;
		relations?: string[];
	}) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		const projectPath = this.projectFile(scope);
		const { parsed } = await this.requireObject(projectPath);
		const title = input.title?.trim() || parsed.title;
		let body = parsed.body;

		if (input.context !== undefined) {
			body = replaceHeadingSection(body, "Context", input.context);
		}

		await this.writeMarkdownObject(
			projectPath,
			{
				id: scalar(parsed.frontmatter.id) ?? `project:${scope.client}-${scope.project}`,
				title,
				sources: parsed.sources,
				relations: input.relations ?? parsed.relations,
			},
			body,
		);
		await this.updateClientProjectLink(scope, title, "upsert");

		return {
			ok: true,
			project: await this.readAtlasObject(projectPath),
			changedPaths: [projectPath, this.clientFile(scope.client)],
		};
	}

	async deleteProject(scopeInput: ProjectScope) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		const project = await this.readAtlasObject(this.projectFile(scope));
		const projectDir = this.projectDirectory(scope);
		await this.deleteFile(projectDir, { recursive: true });
		await this.updateClientProjectLink(scope, project.title, "remove");

		return {
			ok: true,
			deleted: project,
			changedPaths: [projectDir, this.clientFile(scope.client)],
		};
	}

	async addSource(input: {
		client: string;
		project: string;
		name: string;
		content?: string;
		localPath?: string;
		sourceLabel?: string;
	}) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireProjectScaffold(scope);
		const sourcePath = this.sourceFile(scope, input.name);
		const sourceTitle = input.sourceLabel?.trim() || input.name.trim();

		if (input.localPath) {
			const destinationPath = sourcePath.replace(
				/\.md$/i,
				path.extname(input.localPath) || ".bin",
			);
			const { absolute } = this.resolvePath(destinationPath);
			const existing = await stat(absolute).catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return undefined;
				}

				throw error;
			});

			if (existing?.isFile()) {
				return {
					ok: true,
					created: false,
					source: {
						ok: true,
						path: destinationPath,
						bytes: existing.size,
						sha256: await sha256File(absolute),
						overwritten: false,
					},
					changedPaths: [],
				};
			}

			const uploaded = await this.uploadFile(input.localPath, destinationPath);
			return {
				ok: true,
				created: true,
				source: uploaded,
				changedPaths: [uploaded.path],
			};
		}

		const body = [
			`# ${sourceTitle}`,
			"",
			input.content?.trim() || "Source reference captured without inline content.",
			"",
		].join("\n");
		const existing = await this.readOptionalText(sourcePath);

		if (existing !== undefined) {
			return {
				ok: true,
				created: false,
				source: await this.readAtlasObject(sourcePath),
				changedPaths: [],
			};
		}

		await this.createMarkdownObject(
			sourcePath,
			{
				id: `source:${scope.client}-${scope.project}-${this.objectSlug(input.name)}`,
				title: sourceTitle,
				sources: input.sourceLabel ? [input.sourceLabel] : undefined,
				relations: ["../_project.md"],
			},
			body,
		);

		return {
			ok: true,
			created: true,
			source: await this.readAtlasObject(sourcePath),
			changedPaths: [sourcePath],
		};
	}

	async getSource(scopeInput: ProjectScope & { name: string }) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const path = this.sourceFile(scope, scopeInput.name);
		const content = await this.readText(path);
		return {
			ok: true,
			path,
			content,
			object: await this.readAtlasObject(path),
		};
	}

	async listSources(scopeInput: ProjectScope) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const listing = await this.list(`${this.projectDirectory(scope)}/sources`);
		return {
			ok: true,
			sources: listing.entries,
		};
	}

	async deleteSource(scopeInput: ProjectScope & { name: string }) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const sourcePath = this.sourceFile(scope, scopeInput.name);
		const deletion = await this.deleteFile(sourcePath, { missingOk: false });
		return {
			ok: true,
			deletion,
			changedPaths: [sourcePath],
		};
	}

	async listKnowledge(scopeInput: ProjectScope & { kind?: string }) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const listing = await this.list(this.projectDirectory(scope));
		const pages = [];

		for (const entry of listing.entries) {
			if (
				entry.type !== "file" ||
				!entry.name.endsWith(".md") ||
				PROJECT_CORE_FILE_NAME_SET.has(entry.name)
			) {
				continue;
			}

			const object = await this.readAtlasObject(entry.path);

			if (!scopeInput.kind || object.type === scopeInput.kind) {
				pages.push(object);
			}
		}

		return {
			ok: true,
			pages,
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
			kind: AtlasKnowledgeKind;
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
		const existing = await this.readOptionalText(knowledgePath);

		if (existing !== undefined) {
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
		await this.writeMarkdownObject(
			knowledgePath,
			{
				id:
					scalar(parsed.frontmatter.id) ??
					`topic:${scope.client}-${scope.project}-${this.objectSlug(input.slug)}`,
				title: input.title?.trim() || parsed.title,
				sources: input.sources ?? parsed.sources,
				relations: input.relations ?? parsed.relations,
			},
			input.body ?? parsed.body,
		);
		const title = input.title?.trim() || parsed.title;
		const kind = scalar(parsed.frontmatter.id)?.split(":", 1)[0] ?? `topic`;
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

	async getState(scopeInput: ProjectScope) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const statePath = this.stateFile(scope);
		return {
			ok: true,
			path: statePath,
			content: await this.readText(statePath),
			object: await this.readAtlasObject(statePath),
		};
	}

	async updateState(
		input: ProjectScope & {
			body?: string;
			summary?: string;
			activeWork?: string[];
			blockers?: string[];
			todos?: StateTask[];
			owners?: string[];
			nextSteps?: string[];
		},
	) {
		const scope = {
			client: this.clientSlug(input.client),
			project: this.projectSlug(input.project),
		};
		await this.requireProjectScaffold(scope);
		const statePath = this.stateFile(scope);
		const { parsed } = await this.requireObject(statePath);
		const sections = [
			`# ${parsed.title.replace(/^Live State - /, "")} State`,
			"",
			...(input.summary ? [input.summary.trim(), ""] : []),
			...stringSection("Active Work", input.activeWork),
			...stringSection("Blockers", input.blockers),
			...(input.todos && input.todos.length > 0
				? ["## Todos", "", ...formatTasks(input.todos), ""]
				: []),
			...stringSection("Owners", input.owners),
			...stringSection("Next Steps", input.nextSteps),
			"## Project",
			"",
			"- [_project](_project.md)",
			"",
		];
		const body = input.body ?? sections.join("\n");

		await this.writeMarkdownObject(
			statePath,
			{
				id: scalar(parsed.frontmatter.id) ?? `state:${scope.client}-${scope.project}`,
				title: parsed.title,
				sources: parsed.sources,
				relations: parsed.relations.length > 0 ? parsed.relations : ["_project.md"],
			},
			body,
		);

		return {
			ok: true,
			state: await this.readAtlasObject(statePath),
			changedPaths: [statePath],
		};
	}

	async getIndex(scopeInput: ProjectScope) {
		const scope = {
			client: this.clientSlug(scopeInput.client),
			project: this.projectSlug(scopeInput.project),
		};
		await this.requireProjectScaffold(scope);
		const indexPath = this.indexFile(scope);
		return {
			ok: true,
			path: indexPath,
			content: await this.readText(indexPath),
			object: await this.readAtlasObject(indexPath),
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
		const body = upsertIndexEntry(
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
		const body = removeIndexEntry(parsed.body, normalizeFilePath(scopeInput.path));
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

					await walk(
						path.join(absoluteDirectory, entry.name),
						path.posix.join(relativeDirectory, entry.name),
					);
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

	async healthCheck() {
		const graph = await this.buildGraph();
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
					graph.byId.get(edge.to) ??
					(edge.targetPath ? graph.byPath.get(edge.targetPath) : undefined);
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
}

export function atlasPathFromQmdDisplayPath(displayPath: string, collectionName: string) {
	if (displayPath.startsWith(`${collectionName}/`)) {
		return displayPath.slice(collectionName.length + 1);
	}

	return displayPath;
}
