#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const workspaceRoot = resolve(process.env.ATLAS_SMOKE_WORKSPACE ?? ".tmp/smoke-local-atlas-workspace");
const port = Number(process.env.ATLAS_SMOKE_PORT ?? 8797);
const mcpUrl = new URL(`http://localhost:${port}/mcp`);
const projectPath = "clients/local-test/projects/behavior-smoke";
const uploadFixturePath = resolve(workspaceRoot, "../smoke-upload.bin");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function textContent(result) {
	const text = result.content?.find((item) => item.type === "text")?.text;
	assert(typeof text === "string", "Expected text content in MCP result.");
	return text;
}

function jsonContent(result) {
	return JSON.parse(textContent(result));
}

async function writeSeedFile(path, content) {
	const absolute = resolve(workspaceRoot, path);
	await mkdir(resolve(absolute, ".."), { recursive: true });
	await writeFile(absolute, content, "utf8");
}

async function waitForHealth() {
	const started = Date.now();

	while (Date.now() - started < 30_000) {
		try {
			const response = await fetch(`http://localhost:${port}/health`);

			if (response.ok) {
				return;
			}
		} catch {
			// Server is still starting.
		}

		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}

	throw new Error("Timed out waiting for local Atlas MCP health endpoint.");
}

await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(workspaceRoot, { recursive: true });
await writeFile(uploadFixturePath, Buffer.from([0, 1, 2, 3, 4, 5]));

const seedFiles = new Map([
	["_atlas.md", "# Local Atlas Smoke\n\nLocal filesystem Atlas workspace.\n"],
	[
		`${projectPath}/_project.md`,
		"# Behavior Smoke\n\nStable project context for local MCP testing.\n",
	],
	[
		`${projectPath}/_state.md`,
		"# State\n\n## Active Work\n\n- [ ] (Unassigned) Confirm local qmd-backed MCP behavior.\n",
	],
	[
		`${projectPath}/_index.md`,
		"# Index\n\n## Core Pages\n\n- [_project.md](_project.md)\n\n## Knowledge Pages\n\n- [Pricing](knowledge/pricing.md)\n",
	],
	[`${projectPath}/_log.md`, "# Log\n\n- Seeded local qmd MCP smoke project.\n"],
	[
		`${projectPath}/knowledge/pricing.md`,
		`---
id: decision:local-pricing-smoke
title: Local Pricing Smoke
updated_at: 2026-05-03T00:00:00Z
owners:
  - person:local-owner
relations:
  supports:
    - strategy:local-enterprise-expansion
    - source:local-kickoff
---

# Local Pricing Smoke

Pricing packaging is the durable decision used to test local Atlas search and trace.
`,
	],
	[
		`${projectPath}/knowledge/strategy.md`,
		`---
id: strategy:local-enterprise-expansion
title: Local Enterprise Expansion
updated_at: 2026-05-03T00:00:00Z
---

# Local Enterprise Expansion

The smoke strategy is supported by the local pricing decision.
`,
	],
	[
		`${projectPath}/sources/kickoff.md`,
		`---
id: source:local-kickoff
title: Local Kickoff Source
updated_at: 2026-05-03T00:00:00Z
---

# Local Kickoff Source

Local smoke source artifact mentioning pricing packaging.
`,
	],
]);

for (const [path, content] of seedFiles) {
	await writeSeedFile(path, content);
}

const server = spawn(
	process.platform === "win32" ? "npm.cmd" : "npm",
	[
		"run",
		"local:http",
		"--",
		"--workspace",
		workspaceRoot,
		"--port",
		String(port),
		"--quiet",
	],
	{
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			ATLAS_QMD_DB: resolve(workspaceRoot, ".atlas/qmd.sqlite"),
		},
	},
);

let stderr = "";
server.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});

try {
	await waitForHealth();

	const client = new Client({ name: "atlas-local-smoke", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(mcpUrl);

	await client.connect(transport);

	try {
		const tools = await client.listTools();
		const toolNames = tools.tools.map((tool) => tool.name).sort();
		const expectedTools = [
			"atlas_apply_patch",
			"atlas_context",
			"atlas_health_check",
			"atlas_search",
			"atlas_status",
			"atlas_trace",
			"atlas_upload_file",
		].sort();

		assert(
			JSON.stringify(toolNames) === JSON.stringify(expectedTools),
			`Expected slim MCP tool surface ${expectedTools.join(", ")} but got ${toolNames.join(", ")}.`,
		);

		const resources = await client.listResources();
		assert(
			resources.resources.some((resource) => resource.uri === "atlas://skill/SKILL.md"),
			"Expected atlas://skill/SKILL.md resource.",
		);
		const skillResource = await client.readResource({
			uri: "atlas://skill/actions/ingest.md",
		});
		const skillText = skillResource.contents.find((item) => "text" in item)?.text ?? "";
		assert(
			skillText.includes("client-orchestrated"),
			"Expected MCP-served ingest workflow to describe client orchestration.",
		);

		const prompts = await client.listPrompts();
		assert(
			prompts.prompts.some((prompt) => prompt.name === "atlas_ingest_workflow"),
			"Expected atlas_ingest_workflow prompt.",
		);
		const ingestPrompt = await client.getPrompt({
			name: "atlas_ingest_workflow",
			arguments: {
				scope: projectPath,
			},
		});
		const promptText = ingestPrompt.messages[0]?.content.type === "text"
			? ingestPrompt.messages[0].content.text
			: "";
		assert(
			promptText.includes("Atlas MCP tool contract") && promptText.includes(projectPath),
			"Expected MCP-served prompt to include the Atlas skill and requested scope.",
		);

		const status = jsonContent(
			await client.callTool({
				name: "atlas_status",
				arguments: {
					refreshIndex: true,
				},
			}),
		);
		assert(status.ok === true, "status should return ok: true.");
		assert(status.refreshedIndex.indexed >= 1, "status refresh should index markdown files.");

		const search = jsonContent(
			await client.callTool({
				name: "atlas_search",
				arguments: {
					query: "pricing packaging",
					mode: "lex",
					limit: 5,
				},
			}),
		);
		assert(search.ok === true, "search should return ok: true.");
		assert(search.results.length > 0, "search should return at least one result.");
		assert(
			search.results.some((result) => result.path.endsWith("knowledge/pricing.md")),
			"search should find the pricing knowledge page.",
		);

		const context = jsonContent(
			await client.callTool({
				name: "atlas_context",
				arguments: {
					path: projectPath,
				},
			}),
		);
		assert(context.ok === true, "atlas_context should return ok: true.");
		assert(context.coreFiles.length === 4, "atlas_context should return all four core files.");

		const fileContext = jsonContent(
			await client.callTool({
				name: "atlas_context",
				arguments: {
					path: `${projectPath}/knowledge/pricing.md`,
				},
			}),
		);
		assert(fileContext.ok === true, "atlas_context should support singular file paths.");
		assert(fileContext.files[0].ok === true, "atlas_context should read the requested file.");
		assert(
			fileContext.files[0].content.includes("Local Pricing Smoke"),
			"atlas_context singular file read should return file content.",
		);

		const upload = jsonContent(
			await client.callTool({
				name: "atlas_upload_file",
				arguments: {
					localPath: uploadFixturePath,
					path: `${projectPath}/sources/raw-upload.bin`,
					indexAfterUpload: false,
				},
			}),
		);
		assert(upload.ok === true, "atlas_upload_file should copy a local file.");
		assert(upload.bytes === 6, "atlas_upload_file should return byte size.");
		assert(
			upload.warnings?.some((warning) => warning.type === "source_upload_requires_knowledge_update"),
			"atlas_upload_file should warn that source uploads still require knowledge updates.",
		);

		const patchInput = [
			"*** Begin Patch",
			`*** Update File: ${projectPath}/_log.md`,
			"@@",
			" # Log",
			" ",
			" - Seeded local qmd MCP smoke project.",
			"+- Patch application works.",
			"*** End Patch",
			"",
		].join("\n");

		const appliedPatch = jsonContent(
			await client.callTool({
				name: "atlas_apply_patch",
				arguments: {
					input: patchInput,
				},
			}),
		);
		assert(appliedPatch.ok === true, "atlas_apply_patch should apply a matching patch.");
		assert(
			appliedPatch.touched.includes(`${projectPath}/_log.md`),
			"atlas_apply_patch should report touched files.",
		);
		const contextAfterPatch = jsonContent(
			await client.callTool({
				name: "atlas_context",
				arguments: {
					paths: [`${projectPath}/_log.md`],
				},
			}),
		);
		const logAfterPatch = contextAfterPatch.files[0].content;
		assert(
			logAfterPatch.includes("Patch application works."),
			"atlas_apply_patch should write files.",
		);

		const trace = jsonContent(
			await client.callTool({
				name: "atlas_trace",
				arguments: {
					idOrPath: "decision:local-pricing-smoke",
					depth: 2,
				},
			}),
		);
		assert(trace.ok === true, "trace should return ok: true.");
		assert(
			trace.edges.some((edge) => edge.to === "strategy:local-enterprise-expansion"),
			"trace should include the supports edge to strategy.",
		);
		assert(
			trace.edges.some((edge) => edge.to === "source:local-kickoff"),
			"trace should include the supports edge to source.",
		);

		const health = jsonContent(
			await client.callTool({
				name: "atlas_health_check",
				arguments: {},
			}),
		);
		assert(health.ok === true, "health_check should not have errors.");

		console.log(
			JSON.stringify(
				{
					ok: true,
					url: mcpUrl.toString(),
					workspaceRoot,
					tools: toolNames,
					indexed: status.refreshedIndex.indexed,
					uploadBytes: upload.bytes,
					searchResults: search.results.length,
					traceEdges: trace.edges.length,
					healthIssues: health.issues.length,
					resources: resources.resources.length,
					prompts: prompts.prompts.length,
				},
				null,
				2,
			),
		);
	} finally {
		await client.close();
	}
} catch (error) {
	console.error(stderr);
	throw error;
} finally {
	server.kill("SIGTERM");
}
