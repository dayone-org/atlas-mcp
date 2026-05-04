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
type: decision
title: Local Pricing Smoke
status: active
scope: project
owners:
  - person:local-owner
confidence: high
created_at: 2026-05-03T00:00:00Z
updated_at: 2026-05-03T00:00:00Z
relations:
  supports:
    - strategy:local-enterprise-expansion
evidence:
  - id: evidence:local-kickoff
    source: source:local-kickoff
    claim: "Pricing packaging was confirmed as the smoke-test decision."
    support: supports
    confidence: high
metacognition:
  evidence_strength: strong
  reasoning_status: reviewed
  agent_guidance:
    safe_to_answer: true
    safe_to_act: false
    escalation_reason: "Smoke fixture intentionally blocks autonomous action."
---

# Local Pricing Smoke

Pricing packaging is the durable decision used to test local Atlas search and trace.
`,
	],
	[
		`${projectPath}/knowledge/strategy.md`,
		`---
id: strategy:local-enterprise-expansion
type: strategy
title: Local Enterprise Expansion
status: active
created_at: 2026-05-03T00:00:00Z
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
type: source
title: Local Kickoff Source
status: active
created_at: 2026-05-03T00:00:00Z
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

		for (const expected of [
			"atlas_apply_patch",
			"atlas_health_check",
			"atlas_index",
			"atlas_list",
			"atlas_context",
			"atlas_propose_patch",
			"atlas_read",
			"atlas_read_many",
			"atlas_search",
			"atlas_status",
			"atlas_trace",
			"atlas_write_source",
		]) {
			assert(toolNames.includes(expected), `Expected MCP tool ${expected}.`);
		}

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

		const index = jsonContent(
			await client.callTool({
				name: "atlas_index",
				arguments: {},
			}),
		);
		assert(index.ok === true, "index should return ok: true.");
		assert(index.update.indexed >= 1, "index should index markdown files.");

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

			const patchInput = [
				"*** Begin Patch",
				`*** Update File: ${projectPath}/_log.md`,
				"@@",
				" # Log",
				" ",
				" - Seeded local qmd MCP smoke project.",
				"+- Proposed patch validation works.",
				"*** End Patch",
				"",
			].join("\n");

			const proposedPatch = jsonContent(
				await client.callTool({
					name: "atlas_propose_patch",
					arguments: {
						input: patchInput,
					},
				}),
			);
		assert(proposedPatch.ok === true, "atlas_propose_patch should validate a matching patch.");
		assert(
			proposedPatch.touched.includes(`${projectPath}/_log.md`),
			"atlas_propose_patch should report touched files.",
		);
		const logAfterProposal = textContent(
			await client.callTool({
				name: "atlas_read",
				arguments: {
					path: `${projectPath}/_log.md`,
				},
			}),
		);
		assert(
			!logAfterProposal.includes("Proposed patch validation works."),
			"atlas_propose_patch must not write files.",
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
			"trace should include the evidence edge to source.",
		);

		const health = jsonContent(
			await client.callTool({
				name: "atlas_health_check",
				arguments: {},
			}),
		);
		assert(health.ok === true, "health_check should not have errors.");
		assert(
			health.issues.some((issue) => issue.type === "agent_action_requires_review"),
			"health_check should surface safe_to_act=false guidance.",
		);

		console.log(
			JSON.stringify(
				{
					ok: true,
					url: mcpUrl.toString(),
					workspaceRoot,
					tools: toolNames,
					indexed: index.update.indexed,
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
