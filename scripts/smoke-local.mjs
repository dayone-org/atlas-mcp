#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const workspaceRoot = resolve(
	process.env.ATLAS_SMOKE_WORKSPACE ?? ".tmp/smoke-local-atlas-workspace",
);
const port = Number(process.env.ATLAS_SMOKE_PORT ?? 8797);
const mcpUrl = new URL(`http://localhost:${port}/mcp`);
const clientSlug = "local-test";
const projectSlug = "behavior-smoke";
const projectPath = `clients/${clientSlug}/projects/${projectSlug}`;

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

async function expectToolError(client, call, expectedPattern) {
	try {
		const result = await client.callTool(call);

		if (result.isError) {
			const message = textContent(result);
			assert(
				expectedPattern.test(message),
				`Expected tool error to match ${expectedPattern}, got: ${message}`,
			);
			return;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(
			expectedPattern.test(message),
			`Expected tool error to match ${expectedPattern}, got: ${message}`,
		);
		return;
	}

	throw new Error(`Expected ${call.name} to fail.`);
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

const server = spawn(
	process.platform === "win32" ? "npm.cmd" : "npm",
	["run", "local:http", "--", "--workspace", workspaceRoot, "--port", String(port), "--quiet"],
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
			"atlas_context",
			"atlas_core_create",
			"atlas_core_update",
			"atlas_embed",
			"atlas_health_check",
			"atlas_knowledge_create",
			"atlas_knowledge_delete",
			"atlas_knowledge_read",
			"atlas_knowledge_update",
			"atlas_search",
			"atlas_status",
			"atlas_trace",
		].sort();

		assert(
			JSON.stringify(toolNames) === JSON.stringify(expectedTools),
			`Expected slim MCP tool surface ${expectedTools.join(", ")} but got ${toolNames.join(", ")}.`,
		);

		await expectToolError(
			client,
			{
				name: "atlas_knowledge_create",
				arguments: {
					client: clientSlug,
					project: projectSlug,
					slug: "pre-scaffold",
					kind: "conversation",
					title: "Pre Scaffold",
					body: "# Pre Scaffold\n\nThis should not be written before client/project setup.",
				},
			},
			/atlas_core_create/i,
		);

		const createdClient = jsonContent(
			await client.callTool({
				name: "atlas_core_create",
				arguments: {
					role: "client",
					client: clientSlug,
					title: "Local Test",
					body: "DAYONE local smoke-test client.",
				},
			}),
		);
		assert(createdClient.ok === true, "atlas_core_create should create a client.");
		assert(
			createdClient.changedPaths.includes("_atlas.md"),
			"atlas_core_create role=client should update the root atlas file.",
		);

		await expectToolError(
			client,
			{
				name: "atlas_knowledge_create",
				arguments: {
					client: clientSlug,
					project: projectSlug,
					slug: "pre-project",
					kind: "conversation",
					title: "Pre Project",
					body: "# Pre Project\n\nThis should not be written before project setup.",
				},
			},
			/atlas_core_create/i,
		);

		const createdProject = jsonContent(
			await client.callTool({
				name: "atlas_core_create",
				arguments: {
					role: "project",
					client: clientSlug,
					project: projectSlug,
					title: "Behavior Smoke",
					body: "Stable project context for local MCP testing.",
				},
			}),
		);
		assert(createdProject.ok === true, "atlas_core_create should create a project.");
		assert(
			createdProject.changedPaths.includes(`${projectPath}/_project.md`),
			"atlas_core_create role=project should create _project.md.",
		);

		const strategy = jsonContent(
			await client.callTool({
				name: "atlas_knowledge_create",
				arguments: {
					client: clientSlug,
					project: projectSlug,
					slug: "strategy",
					kind: "strategy",
					title: "Local Enterprise Expansion",
					body: "# Local Enterprise Expansion\n\nThe smoke strategy is supported by the local pricing decision.",
				},
			}),
		);
		assert(strategy.ok === true, "atlas_knowledge_create should create strategy knowledge.");
		assert(
			strategy.changedPaths.some((item) => item.endsWith("_index.md")),
			"atlas_knowledge_create should update _index.md.",
		);
		const pricing = jsonContent(
			await client.callTool({
				name: "atlas_knowledge_create",
				arguments: {
					client: clientSlug,
					project: projectSlug,
					slug: "pricing",
					kind: "decision",
					title: "Local Pricing Smoke",
					body: "# Local Pricing Smoke\n\nPricing packaging is the durable decision used to test local Atlas search and trace.",
					sources: ["sources/local-kickoff.md"],
					relations: ["strategy.md"],
				},
			}),
		);
		assert(pricing.ok === true, "atlas_knowledge_create should create decision knowledge.");

		const state = jsonContent(
			await client.callTool({
				name: "atlas_core_update",
				arguments: {
					role: "state",
					client: clientSlug,
					project: projectSlug,
					body: "# Behavior Smoke State\n\nSmoke-test project is active.\n\n## Todos\n\n- [ ] (Unassigned) Confirm local qmd-backed MCP behavior.\n\n## Project\n\n- [_project](_project.md)\n",
				},
			}),
		);
		assert(state.ok === true, "atlas_core_update role=state should update _state.md.");

		const status = jsonContent(
			await client.callTool({
				name: "atlas_status",
				arguments: {},
			}),
		);
		assert(status.ok === true, "status should return ok: true.");
		assert(
			Number.isInteger(status.qmd.totalDocuments),
			"status should report qmd document count.",
		);

		const search = jsonContent(
			await client.callTool({
				name: "atlas_search",
				arguments: {
					query: "pricing packaging",
					client: clientSlug,
					project: projectSlug,
					intent: "Find project pricing decision knowledge.",
					limit: 5,
				},
			}),
		);
		assert(search.ok === true, "search should return ok: true.");
		assert(search.results.length > 0, "search should return at least one result.");
		assert(
			search.results.some((result) => result.path.endsWith("pricing.md")),
			"search should find the pricing knowledge page.",
		);
		assert(
			search.results.every(
				(result) => result.client === clientSlug && result.project === projectSlug,
			),
			"search should include and filter by client/project scope.",
		);
		assert(
			search.results.some(
				(result) =>
					typeof result.context === "string" && result.context.includes("project"),
			),
			"search should return qmd context for results.",
		);

		const knowledgeRead = jsonContent(
			await client.callTool({
				name: "atlas_knowledge_read",
				arguments: {
					client: clientSlug,
					project: projectSlug,
					slug: "pricing",
				},
			}),
		);
		assert(knowledgeRead.ok === true, "atlas_knowledge_read should return ok: true.");
		assert(
			knowledgeRead.content.includes("Pricing packaging"),
			"atlas_knowledge_read should return full page content.",
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
		assert(context.coreFiles.length === 3, "atlas_context should return all active core files.");
		assert(
			context.pages.entries.some((entry) => entry.path.endsWith("pricing.md")),
			"atlas_context should list flat project knowledge pages.",
		);

		const fileContext = jsonContent(
			await client.callTool({
				name: "atlas_context",
				arguments: {
					path: `${projectPath}/pricing.md`,
				},
			}),
		);
		assert(fileContext.ok === true, "atlas_context should support singular file paths.");
		assert(fileContext.files[0].ok === true, "atlas_context should read the requested file.");
		assert(
			fileContext.files[0].content.includes("Local Pricing Smoke"),
			"atlas_context singular file read should return file content.",
		);

		const trace = jsonContent(
			await client.callTool({
				name: "atlas_trace",
				arguments: {
					idOrPath: "decision:local-test-behavior-smoke-pricing",
					depth: 2,
				},
			}),
		);
		assert(trace.ok === true, "trace should return ok: true.");
		assert(
			trace.edges.some((edge) => edge.targetPath?.endsWith("strategy.md")),
			"trace should include the related-file edge to strategy.",
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
					indexUpdate: search.refreshedIndex,
					createdClient: createdClient.core?.path ?? createdClient.client?.path,
					createdProject: createdProject.project.path,
					searchResults: search.results.length,
					traceEdges: trace.edges.length,
					healthIssues: health.issues.length,
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
