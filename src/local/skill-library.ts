import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_RESOURCE_PREFIX = "atlas://skill/";

const SKILL_RESOURCE_PATHS = [
	"SKILL.md",
	"actions/ingest.md",
	"actions/query.md",
	"actions/lint.md",
	"references/frontmatter.md",
	"references/object-types.md",
	"references/knowledge-pages.md",
	"references/type-conversation.md",
	"references/file-atlas.md",
	"references/file-client.md",
	"references/file-project.md",
	"references/file-state.md",
	"references/file-index.md",
	"references/file-log.md",
	"agents/openai.yaml",
] as const;

type SkillResourcePath = (typeof SKILL_RESOURCE_PATHS)[number];

const ACTION_BY_PROMPT = {
	atlas_ingest_workflow: "actions/ingest.md",
	atlas_query_workflow: "actions/query.md",
	atlas_lint_workflow: "actions/lint.md",
	atlas_memory_health_review: "actions/lint.md",
	atlas_decision_review: "references/frontmatter.md",
} as const;

type SkillPromptName = keyof typeof ACTION_BY_PROMPT;

function titleFromPath(relativePath: string) {
	if (relativePath === "SKILL.md") {
		return "Atlas Skill";
	}

	const parts = relativePath
		.replace(/\.md$|\.yaml$/g, "")
		.split("/");
	const name = parts[parts.length - 1] ?? relativePath;

	return name
		.replace(/-/g, " ")
		.replace(/\b\w/g, (value: string) => value.toUpperCase());
}

function isSafeSkillPath(relativePath: string) {
	return SKILL_RESOURCE_PATHS.includes(relativePath as SkillResourcePath);
}

function resourceUri(relativePath: string) {
	return `${SKILL_RESOURCE_PREFIX}${relativePath}`;
}

function relativePathFromUri(uri: URL) {
	if (uri.protocol !== "atlas:" || uri.hostname !== "skill") {
		throw new Error(`${uri.toString()} is not an Atlas skill resource URI.`);
	}

	const relativePath = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));

	if (!isSafeSkillPath(relativePath)) {
		throw new Error(`${relativePath} is not an exposed Atlas skill resource.`);
	}

	return relativePath;
}

async function exists(input: string) {
	try {
		await access(input);
		return true;
	} catch {
		return false;
	}
}

export class AtlasSkillLibrary {
	readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	static async discover(options: { workspaceRoot: string; explicitRoot?: string }) {
		const moduleDir = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [
			options.explicitRoot,
			process.env.ATLAS_SKILL_DIR,
			path.resolve(process.cwd(), "../atlas-skill/skills/atlas"),
			path.resolve(process.cwd(), "atlas-skill/skills/atlas"),
			path.resolve(moduleDir, "../../../atlas-skill/skills/atlas"),
			path.resolve(options.workspaceRoot, "atlas-skill/skills/atlas"),
			path.resolve(process.env.HOME ?? "", ".agents/skills/atlas"),
		].filter((candidate): candidate is string => Boolean(candidate));

		for (const candidate of candidates) {
			if (await exists(path.join(candidate, "SKILL.md"))) {
				return new AtlasSkillLibrary(candidate);
			}
		}

		return undefined;
	}

	get resources() {
		return SKILL_RESOURCE_PATHS.map((relativePath) => ({
			relativePath,
			uri: resourceUri(relativePath),
			name: `atlas_skill_${relativePath.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase()}`,
			title: titleFromPath(relativePath),
			mimeType: relativePath.endsWith(".yaml") ? "application/yaml" : "text/markdown",
		}));
	}

	resolveResourceUri(uri: URL) {
		return relativePathFromUri(uri);
	}

	async read(relativePath: string) {
		if (!isSafeSkillPath(relativePath)) {
			throw new Error(`${relativePath} is not an exposed Atlas skill resource.`);
		}

		return readFile(path.join(this.root, relativePath), "utf8");
	}

	async resourceSize(relativePath: string) {
		try {
			const info = await stat(path.join(this.root, relativePath));
			return info.size;
		} catch {
			return undefined;
		}
	}

	async readPrompt(promptName: SkillPromptName, scope?: string) {
		const [main, action] = await Promise.all([
			this.read("SKILL.md"),
			this.read(ACTION_BY_PROMPT[promptName]),
		]);

		const extra =
			promptName === "atlas_decision_review"
				? await this.read("references/object-types.md")
				: await this.read("references/frontmatter.md");

		const scopeLine = scope ? `\nTarget scope: ${scope}\n` : "";

		return [
			"You are using the Atlas client-orchestrated workflow served by Atlas MCP.",
			scopeLine,
			"Follow the workflow below. Use Atlas MCP as deterministic tooling, not as a hidden ingest agent.",
			"",
			"# Atlas Skill",
			main,
			"",
			"# Workflow",
			action,
			"",
			"# Reference",
			extra,
		].join("\n");
	}
}

export const ATLAS_SKILL_PROMPTS = Object.keys(ACTION_BY_PROMPT) as SkillPromptName[];
