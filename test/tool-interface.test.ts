import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import registerSearchKit from "../src/index.js";
import { registerWebSearchTool, searchCache } from "../src/web-search.js";

async function registeredTools() {
	const tools = new Map<string, any>();
	await registerSearchKit({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
	} as any);
	return tools;
}

function registeredSearchTool() {
	const tools = new Map<string, any>();
	registerWebSearchTool({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as any);
	return tools.get("web_search");
}

describe("web_search public interface", () => {
	it("exposes vertical search and bounds parallel queries", async () => {
		const tool = (await registeredTools()).get("web_search");
		assert.ok(tool);
		const properties = tool.parameters.properties;
		assert.ok(properties.vertical, "vertical must be callable through the registered tool schema");
		assert.deepStrictEqual(properties.vertical.anyOf?.[0]?.enum ?? properties.vertical.enum, [
			"finance.us_stock",
			"academic.search",
			"security.scan",
			"travel",
		]);
		assert.strictEqual(properties.queries.anyOf?.[0]?.maxItems ?? properties.queries.maxItems, 4);
	});

	it("normalizes legacy fractional result counts before integer-schema validation", async () => {
		const search = (await registeredTools()).get("web_search");
		const prepared = search.prepareArguments({ query: "compatibility", max_results: 3.8 });
		assert.strictEqual(prepared.max_results, 3);
	});

	it("uses an integer result-count schema and documents Pi output limits", async () => {
		const tools = await registeredTools();
		const search = tools.get("web_search");
		const fetch = tools.get("web_fetch");
		const maxResultsSchema =
			search.parameters.properties.max_results.anyOf?.[0] ?? search.parameters.properties.max_results;
		assert.strictEqual(maxResultsSchema.type, "integer");

		const expectedLimits = `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}`;
		assert.ok(search.description.includes(expectedLimits));
		assert.ok(fetch.description.includes(expectedLimits));
	});

	it("uses Tavily for both research and supporting sources", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-search-research-"));
		const configDir = join(agentDir, "extensions", "pi-search");
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalTavilyKey = process.env.TAVILY_API_KEY;
		const responses = [
			new Response(JSON.stringify({ results: [] }), { status: 200 }),
			new Response(JSON.stringify({ answer: "Tavily research report" }), { status: 200 }),
		];
		const fetchMock = mock.method(globalThis, "fetch", () => Promise.resolve(responses.shift()!));

		try {
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "config.json"), JSON.stringify({ defaults: { max_results: 7 } }));
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.TAVILY_API_KEY = "test-tavily-key";
			searchCache.clear();

			const search = registeredSearchTool();
			const maxResultsSchema =
				search.parameters.properties.max_results.anyOf?.[0] ?? search.parameters.properties.max_results;
			assert.strictEqual(maxResultsSchema.default, 7);

			const result = await search.execute("id", { query: "research source consistency", research: true }, undefined);
			assert.strictEqual(result.details.provider, "tavily");
			assert.strictEqual(result.details.research, true);
			assert.match(result.content[0].text, /Tavily research report/);
			assert.match(result.content[0].text, /\*0 results via tavily\*/);

			const requestUrls = fetchMock.mock.calls.map((call) => String(call.arguments[0]));
			assert.deepStrictEqual(requestUrls, ["https://api.tavily.com/search", "https://api.tavily.com/research"]);
			const [, searchRequest] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
			assert.deepStrictEqual(JSON.parse(String(searchRequest.body)), {
				query: "research source consistency",
				max_results: 7,
			});
		} finally {
			fetchMock.mock.restore();
			searchCache.clear();
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
			else process.env.TAVILY_API_KEY = originalTavilyKey;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous research and raw-provider combinations before network access", async () => {
		const tools = await registeredTools();
		const search = tools.get("web_search");
		const fetch = tools.get("web_fetch");
		await assert.rejects(
			search.execute("id", { query: "q", provider: "anysearch", research: true }, undefined),
			/research=true.*Tavily/,
		);
		await assert.rejects(
			search.execute("id", { queries: ["a", "b"], research: true }, undefined),
			/requires exactly one query/,
		);
		await assert.rejects(
			search.execute("id", { query: "q", research: true, vertical: "academic.search" }, undefined),
			/research=true.*vertical search/,
		);
		await assert.rejects(
			fetch.execute("id", { url: "https://example.com", raw: true, provider: "jina" }, undefined),
			/cannot be combined/,
		);
	});

	it("parallel search preserves caller cancellation instead of aggregating it as provider errors", async () => {
		const reason = new Error("parallel search cancelled by caller");
		const controller = new AbortController();
		const fetchMock = mock.method(globalThis, "fetch", () => {
			controller.abort(reason);
			return Promise.reject(reason);
		});

		try {
			const search = (await registeredTools()).get("web_search");
			await assert.rejects(
				search.execute("id", { queries: ["first", "second"], provider: "tavily" }, controller.signal),
				(error) => error === reason,
			);
		} finally {
			fetchMock.mock.restore();
		}
	});

	it("keeps top-level tool metadata provider-neutral", async () => {
		const tools = await registeredTools();
		assert.ok(!tools.get("web_search").description.includes("Exa"));
		assert.ok(!tools.get("web_search").promptSnippet.includes("provider='exa'"));
		assert.ok(!tools.get("web_fetch").description.includes("Firecrawl"));
	});

	it("exports the package entrypoint", async () => {
		const packageModule = await import("../index.ts");
		const tools = new Map<string, any>();
		await packageModule.default({
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		} as any);
		assert.ok(tools.has("web_search"), "package entrypoint registers web_search tool");
		assert.ok(tools.has("web_fetch"), "package entrypoint registers web_fetch tool");
	});
});
