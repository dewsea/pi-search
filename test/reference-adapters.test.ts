import assert from "node:assert";
import { describe, it } from "node:test";
import deepseekAdapter from "../examples/search-providers/providers/deepseek.js";
import doubaoAdapter from "../examples/search-providers/providers/doubao.js";
import exaAdapter from "../examples/search-providers/providers/exa.js";
import firecrawlAdapter from "../examples/search-providers/providers/firecrawl.js";
import geminiAdapter from "../examples/search-providers/providers/gemini.js";
import iflowAdapter from "../examples/search-providers/providers/iflow.js";
import serperAdapter from "../examples/search-providers/providers/serper.js";
import type { Provider, ProviderAdapter } from "../src/adapter-api.js";
import { validateProviderAdapter } from "../src/adapter-api.js";

const REFERENCE_ADAPTERS: ProviderAdapter[] = [
	deepseekAdapter,
	doubaoAdapter,
	exaAdapter,
	firecrawlAdapter,
	geminiAdapter,
	iflowAdapter,
	serperAdapter,
];

function createReferenceProviders(): Map<string, Provider> {
	return new Map(
		REFERENCE_ADAPTERS.map((adapter) => {
			const provider = adapter.create({ apiKey: "test-key" });
			return [adapter.name, provider];
		}),
	);
}

function textResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("reference provider adapters", () => {
	it("default-export valid, key-required adapters with matching runtime capabilities", () => {
		assert.deepStrictEqual(
			REFERENCE_ADAPTERS.map(({ name }) => name),
			["deepseek", "doubao", "exa", "firecrawl", "gemini", "iflow", "serper"],
		);

		for (const adapter of REFERENCE_ADAPTERS) {
			assert.doesNotThrow(() => validateProviderAdapter(adapter), adapter.name);
			assert.strictEqual(adapter.apiKeyRequired, true, `${adapter.name} must require an API key`);

			const provider = adapter.create({ apiKey: "test-key" });
			assert.strictEqual(provider.name, adapter.name);
			assert.strictEqual(provider.label, adapter.label);
			assert.deepStrictEqual(provider.capabilities, adapter.capabilities);
			assert.strictEqual(
				typeof provider.search === "function",
				adapter.capabilities.generalSearch,
				`${adapter.name} search implementation mismatch`,
			);
			assert.strictEqual(
				typeof provider.fetch === "function",
				adapter.capabilities.contentExtraction,
				`${adapter.name} fetch implementation mismatch`,
			);
		}
	});

	it("normalizes mocked search responses without live provider calls", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });

			if (url === "https://api.deepseek.com/anthropic/v1/messages") {
				return textResponse(
					`${[
						'data: {"type":"content_block_start","content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","title":"DeepSeek result","url":"https://example.com/deepseek","page_age":"today"}]}}',
						"data: [DONE]",
					].join("\n\n")}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (url === "https://open.feedcoopapi.com/search_api/web_search") {
				return textResponse({
					ResponseMetadata: { RequestId: "doubao-request" },
					Result: {
						WebResults: [
							{
								Title: "Doubao result",
								SiteName: "Official source",
								Url: "https://example.com/doubao",
								Summary: "Doubao summary",
								PublishTime: "2026-08-23T12:00:00+08:00",
								RankScore: 0.9,
								AuthInfoDes: "Highly authoritative",
							},
						],
					},
				});
			}
			if (url === "https://api.exa.ai/search") {
				return textResponse({
					results: [
						{
							title: "Exa result",
							url: "https://example.com/exa",
							text: "Exa summary",
							publishedDate: "2026-08-22",
						},
					],
				});
			}
			if (url.startsWith("https://generativelanguage.googleapis.com/")) {
				return textResponse({
					candidates: [
						{
							groundingMetadata: {
								groundingChunks: [{ web: { title: "Gemini result", uri: "https://example.com/gemini" } }],
							},
						},
					],
				});
			}
			if (url === "https://platform.iflow.cn/api/search/webSearch") {
				return textResponse({
					success: true,
					data: {
						organic: [
							{
								title: "iFlow result",
								link: "https://example.com/iflow",
								snippet: "iFlow summary",
								date: "2026-08-21",
							},
						],
					},
				});
			}
			if (url === "https://google.serper.dev/search") {
				return textResponse({
					organic: [
						{
							title: "Serper result",
							link: "https://example.com/serper",
							snippet: "Serper summary",
							date: "2026-08-20",
						},
					],
				});
			}
			throw new Error(`Unexpected mocked search URL: ${url}`);
		};

		try {
			const providers = createReferenceProviders();
			const expected = [
				["deepseek", "DeepSeek result", "https://example.com/deepseek"],
				["doubao", "Doubao result", "https://example.com/doubao"],
				["exa", "Exa result", "https://example.com/exa"],
				["gemini", "Gemini result", "https://example.com/gemini"],
				["iflow", "iFlow result", "https://example.com/iflow"],
				["serper", "Serper result", "https://example.com/serper"],
			] as const;

			for (const [name, title, url] of expected) {
				const response = await providers.get(name)?.search?.("test query", 5);
				assert.strictEqual(response?.results[0]?.title, title, name);
				assert.strictEqual(response?.results[0]?.url, url, name);
			}

			const doubaoCall = calls.find(({ url }) => url === "https://open.feedcoopapi.com/search_api/web_search");
			assert.ok(doubaoCall);
			assert.strictEqual(new Headers(doubaoCall.init?.headers).get("Authorization"), "Bearer test-key");
			assert.deepStrictEqual(JSON.parse(String(doubaoCall.init?.body)), {
				Query: "test query",
				SearchType: "web",
				Count: 5,
				NeedSummary: true,
				Filter: { NeedUrl: true },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("normalizes mocked extraction responses without live provider calls", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "https://api.exa.ai/contents") {
				return textResponse({
					results: [{ title: "Exa page", url: "https://example.com/page", text: "Exa content" }],
				});
			}
			if (url === "https://api.firecrawl.dev/v1/scrape") {
				return textResponse({ success: true, data: { title: "Firecrawl page", markdown: "# Firecrawl" } });
			}
			if (url === "https://platform.iflow.cn/api/search/webFetch") {
				return textResponse({ success: true, data: { title: "iFlow page", content: "# iFlow" } });
			}
			throw new Error(`Unexpected mocked extraction URL: ${url}`);
		};

		try {
			const providers = createReferenceProviders();
			const exa = await providers.get("exa")?.fetch?.("https://example.com/page");
			const firecrawl = await providers.get("firecrawl")?.fetch?.("https://example.com/page");
			const iflow = await providers.get("iflow")?.fetch?.("https://example.com/page");

			assert.deepStrictEqual(exa, { text: "Exa content", title: "Exa page", contentType: "text/plain" });
			assert.deepStrictEqual(firecrawl, {
				text: "# Firecrawl",
				title: "Firecrawl page",
				contentType: "text/markdown",
			});
			assert.deepStrictEqual(iflow, {
				text: "# iFlow",
				title: "iFlow page",
				contentType: "text/markdown",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
