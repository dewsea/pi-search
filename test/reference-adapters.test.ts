import assert from "node:assert";
import { describe, it } from "node:test";
import deepseekAdapter from "../examples/providers/deepseek.js";
import doubaoAdapter from "../examples/providers/doubao.js";
import geminiAdapter from "../examples/providers/gemini.js";
import iflowAdapter from "../examples/providers/iflow.js";
import { type Provider, validateProviderAdapter } from "../src/adapter-api.js";
import { createProviderContext } from "../src/execution.js";

const REFERENCE_ADAPTERS: Provider[] = [deepseekAdapter, doubaoAdapter, geminiAdapter, iflowAdapter];

function textResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("reference provider adapters", () => {
	it("default-export valid Provider objects adhering to the unified contract", () => {
		assert.deepStrictEqual(
			REFERENCE_ADAPTERS.map(({ name }) => name),
			["deepseek", "doubao", "gemini", "iflow"],
		);

		for (const adapter of REFERENCE_ADAPTERS) {
			assert.doesNotThrow(() => validateProviderAdapter(adapter), adapter.name);
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
			throw new Error(`Unexpected mocked search URL: ${url}`);
		};

		try {
			const providers = new Map(REFERENCE_ADAPTERS.map((a) => [a.name, a]));
			const expected = [
				["deepseek", "DeepSeek result", "https://example.com/deepseek"],
				["doubao", "Doubao result", "https://example.com/doubao"],
				["gemini", "Gemini result", "https://example.com/gemini"],
				["iflow", "iFlow result", "https://example.com/iflow"],
			] as const;

			for (const [name, title, url] of expected) {
				const provider = providers.get(name)!;
				const { ctx, cleanup } = createProviderContext(provider, "test-key");
				try {
					const response = await provider.search?.("test query", 5, ctx);
					assert.strictEqual(response?.results[0]?.title, title, name);
					assert.strictEqual(response?.results[0]?.url, url, name);
				} finally {
					cleanup();
				}
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
			if (url === "https://platform.iflow.cn/api/search/webFetch") {
				return textResponse({ success: true, data: { title: "iFlow page", content: "# iFlow" } });
			}
			throw new Error(`Unexpected mocked extraction URL: ${url}`);
		};

		try {
			const provider = iflowAdapter;
			const { ctx, cleanup } = createProviderContext(provider, "test-key");
			try {
				const iflow = await provider.fetch?.("https://example.com/page", ctx);
				assert.deepStrictEqual(iflow, {
					text: "# iFlow",
					title: "iFlow page",
					contentType: "text/markdown",
				});
			} finally {
				cleanup();
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
