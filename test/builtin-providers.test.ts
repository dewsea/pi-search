import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { validateProviderAdapter } from "../src/adapter-api.js";
import { createProviderContext, executeFetch } from "../src/execution.js";
import anysearchProvider from "../src/providers/anysearch.js";
import braveProvider from "../src/providers/brave.js";
import exaProvider from "../src/providers/exa.js";
import firecrawlProvider from "../src/providers/firecrawl.js";
import jinaProvider from "../src/providers/jina.js";
import serpapiProvider from "../src/providers/serpapi.js";
import serperProvider from "../src/providers/serper.js";
import tavilyProvider from "../src/providers/tavily.js";
import tinyfishProvider from "../src/providers/tinyfish.js";

function textResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

afterEach(() => {
	mock.restoreAll();
});

describe("9 Built-in Providers validation and fixtures", () => {
	const allBuiltins = [
		tavilyProvider,
		anysearchProvider,
		jinaProvider,
		exaProvider,
		serperProvider,
		firecrawlProvider,
		braveProvider,
		tinyfishProvider,
		serpapiProvider,
	];

	it("validates that all 9 built-in providers pass validateProviderAdapter", () => {
		for (const provider of allBuiltins) {
			assert.doesNotThrow(() => validateProviderAdapter(provider), provider.name);
		}
	});

	it("Tavily: searches with keyless mode or api key, handles extract", async () => {
		let capturedInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(
				textResponse({
					results: [{ title: "Tavily Title", url: "https://tavily.com", content: "snippet", score: 0.99 }],
				}),
			);
		});

		// 1. keyless search
		const { ctx: keylessCtx, cleanup: c1 } = createProviderContext(tavilyProvider, undefined);
		try {
			const res = await tavilyProvider.search!("test", 5, keylessCtx);
			assert.strictEqual(res.results.length, 1);
			assert.strictEqual(res.results[0].title, "Tavily Title");
			assert.strictEqual(new Headers(capturedInit?.headers).get("x-tavily-access-mode"), "keyless");
			assert.strictEqual(new Headers(capturedInit?.headers).get("authorization"), null);
		} finally {
			c1();
		}

		// 2. search with key
		const { ctx: keyCtx, cleanup: c2 } = createProviderContext(tavilyProvider, "tavily-key");
		try {
			await tavilyProvider.search!("test", 5, keyCtx);
			assert.strictEqual(new Headers(capturedInit?.headers).get("authorization"), "Bearer tavily-key");
		} finally {
			c2();
		}
	});

	it("AnySearch: searches with key or anonymous, handles API error envelopes", async () => {
		mock.method(globalThis, "fetch", () =>
			Promise.resolve(
				textResponse({
					code: 0,
					message: "ok",
					data: {
						results: [{ title: "AnySearch Title", url: "https://anysearch.com", content: "content" }],
					},
				}),
			),
		);

		const { ctx, cleanup } = createProviderContext(anysearchProvider, undefined);
		try {
			const res = await anysearchProvider.search!("query", 5, ctx);
			assert.strictEqual(res.results[0].title, "AnySearch Title");
		} finally {
			cleanup();
		}

		// Error envelope
		mock.restoreAll();
		mock.method(globalThis, "fetch", () => Promise.resolve(textResponse({ code: 4001, message: "quota exceeded" })));
		const { ctx: errCtx, cleanup: errCleanup } = createProviderContext(anysearchProvider, "any-key");
		try {
			await assert.rejects(
				() => anysearchProvider.search!("query", 5, errCtx),
				/AnySearch API error: quota exceeded/,
			);
		} finally {
			errCleanup();
		}
	});

	it("AnySearch: fetches content using data.content and data.title (anonymous and with key)", async () => {
		let capturedFetchInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
			capturedFetchInit = init;
			return Promise.resolve(
				textResponse({
					code: 0,
					message: "success",
					request_id: "req-123",
					data: {
						url: "https://example.com/",
						title: "Example Domain",
						content: "Example page content.",
					},
				}),
			);
		});

		// 1. Anonymous fetch
		const { ctx: anonCtx, cleanup: c1 } = createProviderContext(anysearchProvider, undefined);
		try {
			const res = await anysearchProvider.fetch!("https://example.com/", anonCtx);
			assert.strictEqual(res.title, "Example Domain");
			assert.strictEqual(res.text, "Example page content.");
			assert.strictEqual(res.contentType, "text/markdown");
			assert.strictEqual(new Headers(capturedFetchInit?.headers).get("authorization"), null);
			assert.deepStrictEqual(JSON.parse(String(capturedFetchInit?.body)), { url: "https://example.com/" });
		} finally {
			c1();
		}

		// 2. Fetch with API key
		mock.restoreAll();
		mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
			capturedFetchInit = init;
			return Promise.resolve(
				textResponse({
					code: 0,
					message: "success",
					data: {
						url: "https://example.com/keyed",
						title: "Keyed Domain",
						content: "Keyed content.",
					},
				}),
			);
		});
		const { ctx: keyCtx, cleanup: c2 } = createProviderContext(anysearchProvider, "any-key");
		try {
			const res = await anysearchProvider.fetch!("https://example.com/keyed", keyCtx);
			assert.strictEqual(res.title, "Keyed Domain");
			assert.strictEqual(res.text, "Keyed content.");
			assert.strictEqual(new Headers(capturedFetchInit?.headers).get("authorization"), "Bearer any-key");
		} finally {
			c2();
		}
	});

	it("AnySearch: fetch rejects HTTP failure, non-zero code, and missing/blank/invalid content", async () => {
		// HTTP 500 error
		mock.method(globalThis, "fetch", () => Promise.resolve(new Response("Internal Server Error", { status: 500 })));
		const { ctx: httpErrCtx, cleanup: c1 } = createProviderContext(anysearchProvider, undefined);
		try {
			await assert.rejects(
				() => anysearchProvider.fetch!("https://example.com/", httpErrCtx),
				/AnySearch extract error \(500\)/,
			);
		} finally {
			c1();
		}

		// Non-zero business code
		mock.restoreAll();
		mock.method(globalThis, "fetch", () => Promise.resolve(textResponse({ code: 4001, message: "rate limited" })));
		const { ctx: codeErrCtx, cleanup: c2 } = createProviderContext(anysearchProvider, undefined);
		try {
			await assert.rejects(
				() => anysearchProvider.fetch!("https://example.com/", codeErrCtx),
				/AnySearch API error: rate limited/,
			);
		} finally {
			c2();
		}

		// Missing data or content
		for (const badData of [
			undefined,
			{},
			{ content: "" },
			{ content: "   \n\t  " },
			{ content: 12345 },
			{ results: [{ content: "old style should not be parsed" }] },
		]) {
			mock.restoreAll();
			mock.method(globalThis, "fetch", () =>
				Promise.resolve(textResponse({ code: 0, message: "ok", data: badData })),
			);
			const { ctx: badCtx, cleanup: cBad } = createProviderContext(anysearchProvider, undefined);
			try {
				await assert.rejects(
					() => anysearchProvider.fetch!("https://example.com/", badCtx),
					/AnySearch extract: no content for https:\/\/example\.com\//,
				);
			} finally {
				cBad();
			}
		}
	});

	it("AnySearch: mixed with other provider in executeFetch groups success and failure correctly", async () => {
		mock.method(globalThis, "fetch", (url: string) => {
			const str = String(url);
			if (str.includes("anysearch.com")) {
				return Promise.resolve(
					textResponse({
						code: 0,
						message: "success",
						data: {
							title: "AnySearch Doc",
							content: "AnySearch extracted content.",
						},
					}),
				);
			}
			if (str.includes("r.jina.ai")) {
				return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
			}
			return Promise.reject(new Error("unexpected URL"));
		});

		const result = await executeFetch([anysearchProvider, jinaProvider], "https://example.com/item", {
			apiKeys: {},
		});

		assert.strictEqual(result.items.length, 2);
		assert.strictEqual(result.items[0].provider, "anysearch");
		assert.strictEqual(result.items[0].status, "success");
		if (result.items[0].status === "success") {
			assert.strictEqual(result.items[0].data.text, "AnySearch extracted content.");
			assert.strictEqual(result.items[0].data.title, "AnySearch Doc");
		}
		assert.strictEqual(result.items[1].provider, "jina");
		assert.strictEqual(result.items[1].status, "error");
		if (result.items[1].status === "error") {
			assert.match(result.items[1].error, /503/);
		}
	});

	it("Jina: fetches content via json or plain markdown", async () => {
		mock.method(globalThis, "fetch", () =>
			Promise.resolve(
				textResponse({
					code: 200,
					data: { title: "Jina Doc", content: "## Jina Content" },
				}),
			),
		);

		const { ctx, cleanup } = createProviderContext(jinaProvider, undefined);
		try {
			const res = await jinaProvider.fetch!("https://example.com/jina", ctx);
			assert.strictEqual(res.title, "Jina Doc");
			assert.strictEqual(res.text, "## Jina Content");
		} finally {
			cleanup();
		}
	});

	it("Exa: searches and fetches with x-api-key header", async () => {
		let capturedInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(
				textResponse({
					results: [{ title: "Exa Page", url: "https://exa.ai/res", text: "Exa snippet" }],
				}),
			);
		});

		const { ctx, cleanup } = createProviderContext(exaProvider, "exa-secret");
		try {
			const res = await exaProvider.search!("deep tech", 3, ctx);
			assert.strictEqual(res.results[0].title, "Exa Page");
			assert.strictEqual(new Headers(capturedInit?.headers).get("x-api-key"), "exa-secret");
		} finally {
			cleanup();
		}

		// Fetch test
		mock.restoreAll();
		let capturedFetchInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
			capturedFetchInit = init;
			return Promise.resolve(
				textResponse({
					results: [{ title: "Exa Doc", url: "https://example.com/doc", text: "Full doc text" }],
				}),
			);
		});

		const { ctx: fetchCtx, cleanup: fetchCleanup } = createProviderContext(exaProvider, "exa-secret");
		try {
			const res = await exaProvider.fetch!("https://example.com/doc", fetchCtx);
			assert.strictEqual(res.title, "Exa Doc");
			assert.strictEqual(res.text, "Full doc text");
			assert.strictEqual(new Headers(capturedFetchInit?.headers).get("x-api-key"), "exa-secret");
			assert.deepStrictEqual(JSON.parse(String(capturedFetchInit?.body)), {
				urls: ["https://example.com/doc"],
				text: true,
			});
		} finally {
			fetchCleanup();
		}
	});

	it("Serper: passes Google query and parses organic results", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return Promise.resolve(
				textResponse({
					organic: [{ title: "Google Result", link: "https://google.com/item", snippet: "snippet" }],
				}),
			);
		});

		const { ctx, cleanup } = createProviderContext(serperProvider, "serper-secret");
		try {
			const res = await serperProvider.search!("search text", 5, ctx);
			assert.strictEqual(res.results[0].title, "Google Result");
			assert.strictEqual(capturedUrl, "https://google.serper.dev/search");
			assert.strictEqual(new Headers(capturedInit?.headers).get("x-api-key"), "serper-secret");
		} finally {
			cleanup();
		}
	});

	it("Firecrawl v2: parses web search and scrape response envelopes", async () => {
		const capturedUrls: string[] = [];
		const capturedInits: RequestInit[] = [];
		mock.method(globalThis, "fetch", (input: string, init?: RequestInit) => {
			const url = String(input);
			capturedUrls.push(url);
			capturedInits.push(init ?? {});
			if (url.endsWith("/search")) {
				return Promise.resolve(
					textResponse({
						success: true,
						data: { web: [{ url: "https://firecrawl.dev/1", title: "FC 1", description: "FC desc" }] },
					}),
				);
			}
			return Promise.resolve(
				textResponse({
					success: true,
					data: { markdown: "# Firecrawl page", metadata: { title: "FC page" } },
				}),
			);
		});

		const { ctx, cleanup } = createProviderContext(firecrawlProvider, "fc-key");
		try {
			const search = await firecrawlProvider.search!("crawl query", 2, ctx);
			assert.strictEqual(search.results[0].title, "FC 1");
			assert.strictEqual(search.results[0].snippet, "FC desc");
			assert.strictEqual(capturedUrls[0], "https://api.firecrawl.dev/v2/search");
			assert.strictEqual(new Headers(capturedInits[0].headers).get("authorization"), "Bearer fc-key");

			const fetched = await firecrawlProvider.fetch!("https://example.com/page", ctx);
			assert.deepStrictEqual(fetched, {
				text: "# Firecrawl page",
				title: "FC page",
				contentType: "text/markdown",
			});
			assert.strictEqual(capturedUrls[1], "https://api.firecrawl.dev/v2/scrape");
			assert.strictEqual(new Headers(capturedInits[1].headers).get("authorization"), "Bearer fc-key");
		} finally {
			cleanup();
		}
	});

	it("Brave: sends GET request with X-Subscription-Token and parses web results", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return Promise.resolve(
				textResponse({
					web: {
						results: [{ title: "Brave Hit", url: "https://brave.com/hit", description: "brave snippet" }],
					},
				}),
			);
		});

		const { ctx, cleanup } = createProviderContext(braveProvider, "brave-token");
		try {
			const res = await braveProvider.search!("brave search", 5, ctx);
			assert.strictEqual(res.results[0].title, "Brave Hit");
			assert.ok(capturedUrl.includes("q=brave%20search"));
			assert.strictEqual(new Headers(capturedInit?.headers).get("x-subscription-token"), "brave-token");
		} finally {
			cleanup();
		}
	});

	it("TinyFish: handles search, fetch, and errors array in HTTP 200", async () => {
		let capturedSearchUrl = "";
		let capturedSearchInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
			capturedSearchUrl = String(url);
			capturedSearchInit = init;
			return Promise.resolve(
				textResponse({
					results: [{ title: "TinyFish Result", url: "https://tinyfish.ai/1", snippet: "tf" }],
				}),
			);
		});

		const { ctx, cleanup } = createProviderContext(tinyfishProvider, "tf-key");
		try {
			const res = await tinyfishProvider.search!("tinyfish query", 5, ctx);
			assert.strictEqual(res.results[0].title, "TinyFish Result");
			assert.ok(capturedSearchUrl.startsWith("https://api.search.tinyfish.ai?query=tinyfish%20query&limit=5"));
			assert.strictEqual(capturedSearchInit?.method, "GET");
			assert.strictEqual(new Headers(capturedSearchInit?.headers).get("x-api-key"), "tf-key");
		} finally {
			cleanup();
		}

		// Fetch test
		mock.restoreAll();
		let capturedFetchUrl = "";
		let capturedFetchInit: RequestInit | undefined;
		mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
			capturedFetchUrl = String(url);
			capturedFetchInit = init;
			return Promise.resolve(
				textResponse({
					results: [{ url: "https://example.com/tf", title: "TF Title", text: "## TF Content" }],
				}),
			);
		});

		const { ctx: fetchCtx, cleanup: fetchCleanup } = createProviderContext(tinyfishProvider, "tf-key");
		try {
			const res = await tinyfishProvider.fetch!("https://example.com/tf", fetchCtx);
			assert.strictEqual(res.title, "TF Title");
			assert.strictEqual(res.text, "## TF Content");
			assert.strictEqual(capturedFetchUrl, "https://api.fetch.tinyfish.ai");
			assert.strictEqual(capturedFetchInit?.method, "POST");
			assert.strictEqual(new Headers(capturedFetchInit?.headers).get("x-api-key"), "tf-key");
			assert.deepStrictEqual(JSON.parse(String(capturedFetchInit?.body)), {
				urls: ["https://example.com/tf"],
				format: "markdown",
			});
		} finally {
			fetchCleanup();
		}

		// Fetch HTTP 200 with official errors array of objects (e.g. 404 / timeout)
		mock.restoreAll();
		mock.method(globalThis, "fetch", () =>
			Promise.resolve(
				textResponse({
					errors: [{ url: "https://example.com/tf", error: "Page not found", status: 404 }],
				}),
			),
		);
		const { ctx: fetchErrCtx, cleanup: fetchErrCleanup } = createProviderContext(tinyfishProvider, "tf-key");
		try {
			await assert.rejects(
				() => tinyfishProvider.fetch!("https://example.com/tf", fetchErrCtx),
				/TinyFish fetch error: https:\/\/example\.com\/tf: Page not found \(404\)/,
			);
		} finally {
			fetchErrCleanup();
		}

		// Search HTTP 200 with errors array of objects or strings
		mock.restoreAll();
		mock.method(globalThis, "fetch", () =>
			Promise.resolve(
				textResponse({
					errors: [{ error: "Rate limit reached" }],
				}),
			),
		);
		const { ctx: errCtx, cleanup: errCleanup } = createProviderContext(tinyfishProvider, "tf-key");
		try {
			await assert.rejects(
				() => tinyfishProvider.search!("query", 5, errCtx),
				/TinyFish search error: Rate limit reached/,
			);
		} finally {
			errCleanup();
		}
	});

	it("SerpApi: queries google engine with api_key and parses organic results", async () => {
		let capturedUrl = "";
		mock.method(globalThis, "fetch", (url: string) => {
			capturedUrl = String(url);
			return Promise.resolve(
				textResponse({
					organic_results: [{ title: "SerpApi Title", link: "https://serpapi.com/res", snippet: "snippet" }],
				}),
			);
		});

		const { ctx, cleanup } = createProviderContext(serpapiProvider, "serp-secret");
		try {
			const res = await serpapiProvider.search!("serp query", 5, ctx);
			assert.strictEqual(res.results[0].title, "SerpApi Title");
			assert.ok(capturedUrl.includes("engine=google"));
			assert.ok(capturedUrl.includes("api_key=serp-secret"));
		} finally {
			cleanup();
		}
	});
});
