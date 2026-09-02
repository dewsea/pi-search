import assert from "node:assert";
import { before, beforeEach, describe, it } from "node:test";
import type { FetchResponse, Provider, ProviderCapabilities, SearchResponse } from "../src/providers/types.js";
import { executeFetch } from "../src/web-fetch.js";
// We import the extracted execute functions — they don't exist yet (RED).
// Import paths will be confirmed once we extract them.
import { assertResearchAvailable, executeSearch, resolveMaxResults, searchCache } from "../src/web-search.js";

beforeEach(() => {
	searchCache.clear();
});

// mock helpers

const baseCapabilities: ProviderCapabilities = {
	generalSearch: false,
	verticalSearch: false,
	contentExtraction: false,
	crawl: false,
	siteMap: false,
	deepResearch: false,
	batchSearch: false,
	hasMetadata: false,
};

function mockProvider(
	name: string,
	overrides: {
		capabilities?: Partial<ProviderCapabilities>;
		searchResult?: SearchResponse;
		searchError?: Error;
		fetchResult?: FetchResponse;
		fetchError?: Error;
	},
): Provider {
	return {
		name,
		label: name,
		capabilities: { ...baseCapabilities, ...overrides.capabilities },
		search:
			overrides.searchResult != null || overrides.searchError != null
				? async () => {
						if (overrides.searchError) throw overrides.searchError;
						return overrides.searchResult!;
					}
				: undefined,
		fetch:
			overrides.fetchResult != null || overrides.fetchError != null
				? async () => {
						if (overrides.fetchError) throw overrides.fetchError;
						return overrides.fetchResult!;
					}
				: undefined,
	};
}

function providersMap(...providers: Provider[]): Map<string, Provider> {
	const m = new Map<string, Provider>();
	for (const p of providers) m.set(p.name, p);
	return m;
}

describe("web_search research prerequisites", () => {
	it("requires a configured Tavily key", () => {
		const tavily = mockProvider("tavily", { capabilities: { generalSearch: true } });
		assert.throws(
			() => assertResearchAvailable({ tavily: undefined }, providersMap(tavily)),
			/requires a Tavily API key/,
		);
	});

	it("requires a Tavily provider with research support", () => {
		const tavily = mockProvider("tavily", { capabilities: { generalSearch: true } });
		assert.throws(
			() => assertResearchAvailable({ tavily: "configured-key" }, providersMap(tavily)),
			/requires an available Tavily provider/,
		);
	});
});

describe("resolveMaxResults", () => {
	it("uses a configured default only when max_results is omitted", () => {
		assert.strictEqual(resolveMaxResults(undefined, { defaults: { max_results: 7 } }), 7);
		assert.strictEqual(resolveMaxResults(3, { defaults: { max_results: 7 } }), 3);
	});

	it("normalizes invalid configured defaults within the supported range", () => {
		assert.strictEqual(resolveMaxResults(undefined, { defaults: { max_results: 0 } }), 1);
		assert.strictEqual(resolveMaxResults(undefined, { defaults: { max_results: 99 } }), 20);
		assert.strictEqual(resolveMaxResults(undefined, { defaults: { max_results: 3.8 } }), 3);
		assert.strictEqual(resolveMaxResults(undefined, { defaults: { max_results: Number.NaN } }), 5);
	});
});

describe("executeSearch — explicit provider requested", () => {
	const tavily = mockProvider("tavily", {
		capabilities: { generalSearch: true, contentExtraction: true },
		searchResult: { results: [{ title: "t", url: "https://a", snippet: "s" }] },
	});
	const anysearch = mockProvider("anysearch", {
		capabilities: { generalSearch: true, contentExtraction: true },
		searchResult: { results: [{ title: "anysearch", url: "https://b", snippet: "s" }] },
	});

	it("uses explicitly requested provider and returns upon success", async () => {
		const result = await executeSearch(providersMap(tavily, anysearch), "test", 5, {
			provider: "anysearch",
		});
		assert.strictEqual(result.provider, "anysearch");
		assert.strictEqual(result.results[0].title, "anysearch");
	});

	it("fails directly when requested provider fails without falling back to chain", async () => {
		const broken = mockProvider("anysearch", {
			capabilities: { generalSearch: true },
			searchError: new Error("anysearch down"),
		});
		await assert.rejects(
			executeSearch(providersMap(broken, tavily), "test", 5, { provider: "anysearch" }),
			/anysearch down/,
		);
	});
});

describe("executeSearch — fallback chain without explicit provider", () => {
	const emptyProvider = mockProvider("tavily", {
		capabilities: { generalSearch: true },
		searchResult: { results: [] },
	});
	const goodProvider = mockProvider("anysearch", {
		capabilities: { generalSearch: true },
		searchResult: { results: [{ title: "anysearch result", url: "https://x", snippet: "s" }] },
	});

	it("returns first non-empty provider result without invoking fallback", async () => {
		const good = mockProvider("tavily", {
			capabilities: { generalSearch: true },
			searchResult: { results: [{ title: "tav", url: "https://a", snippet: "s" }] },
		});
		const result = await executeSearch(providersMap(good, goodProvider), "test", 5, {});
		assert.strictEqual(result.provider, "tavily");
	});

	it("tries next provider when initial provider returns empty results", async () => {
		const result = await executeSearch(providersMap(emptyProvider, goodProvider), "test", 5, {});
		assert.strictEqual(result.provider, "anysearch");
		assert.strictEqual(result.results[0].title, "anysearch result");
	});

	it("rejects when all chain providers fail", async () => {
		const err1 = mockProvider("tavily", {
			capabilities: { generalSearch: true },
			searchError: new Error("err1"),
		});
		await assert.rejects(executeSearch(providersMap(err1), "test", 5, {}), /All providers failed/);
	});

	it("returns and caches definitive zero results when all providers return empty arrays", async () => {
		let calls = 0;
		const empty: Provider = {
			name: "tavily",
			label: "tavily",
			capabilities: { ...baseCapabilities, generalSearch: true },
			search: async () => {
				calls++;
				return { results: [] };
			},
		};
		const providers = providersMap(empty);

		const first = await executeSearch(providers, "nothing", 5, {});
		const second = await executeSearch(providers, "nothing", 5, {});
		assert.deepStrictEqual(first.results, []);
		assert.strictEqual(first.provider, "tavily");
		assert.deepStrictEqual(second, first);
		assert.strictEqual(calls, 1, "a definitive empty result should be cached");
	});

	it("does not cache an empty result when another provider fails", async () => {
		let emptyCalls = 0;
		let failedCalls = 0;
		const empty: Provider = {
			name: "tavily",
			label: "tavily",
			capabilities: { ...baseCapabilities, generalSearch: true },
			search: async () => {
				emptyCalls++;
				return { results: [] };
			},
		};
		const broken: Provider = {
			name: "anysearch",
			label: "anysearch",
			capabilities: { ...baseCapabilities, generalSearch: true },
			search: async () => {
				failedCalls++;
				throw new Error("temporary anysearch failure");
			},
		};
		const providers = providersMap(empty, broken);

		await assert.rejects(
			executeSearch(providers, "inconclusive", 5, {}),
			/Search was inconclusive.*anysearch: temporary anysearch failure/s,
		);
		await assert.rejects(
			executeSearch(providers, "inconclusive", 5, {}),
			/Search was inconclusive.*anysearch: temporary anysearch failure/s,
		);
		assert.strictEqual(emptyCalls, 2, "an inconclusive result must not be cached");
		assert.strictEqual(failedCalls, 2, "the failed provider must be retried");
	});

	it("propagates caller cancellation without invoking subsequent providers", async () => {
		const controller = new AbortController();
		const reason = new Error("search cancelled by caller");
		let fallbackCalls = 0;
		const cancellingProvider: Provider = {
			name: "tavily",
			label: "tavily",
			capabilities: { ...baseCapabilities, generalSearch: true },
			search: async () => {
				controller.abort(reason);
				throw reason;
			},
		};
		const fallbackProvider: Provider = {
			name: "anysearch",
			label: "anysearch",
			capabilities: { ...baseCapabilities, generalSearch: true },
			search: async () => {
				fallbackCalls++;
				return { results: [{ title: "unexpected", url: "https://x", snippet: "unexpected" }] };
			},
		};

		await assert.rejects(
			executeSearch(providersMap(cancellingProvider, fallbackProvider), "test", 5, {}, controller.signal),
			(error) => error === reason,
		);
		assert.strictEqual(fallbackCalls, 0);
	});
});

describe("executeSearch — vertical parameter", () => {
	it("triggers verticalSearch for vertical-capable providers", async () => {
		const anysearch = mockProvider("anysearch", {
			capabilities: { generalSearch: true, verticalSearch: true },
			searchResult: { results: [{ title: "a", url: "https://x", snippet: "s" }] },
		}) as Provider & { verticalSearch: NonNullable<Provider["verticalSearch"]> };
		anysearch.verticalSearch = async () => ({
			results: [{ title: "vertical result", url: "https://v", snippet: "vs" }],
		});

		const result = await executeSearch(providersMap(anysearch), "AAPL", 5, {
			provider: "anysearch",
			vertical: "finance.us_stock",
		});
		assert.strictEqual(result.results[0].title, "vertical result");
	});

	it("silently ignores vertical parameter for non-vertical providers and runs general search", async () => {
		const tavily = mockProvider("tavily", {
			capabilities: { generalSearch: true },
			searchResult: { results: [{ title: "generic", url: "https://g", snippet: "g" }] },
		});

		const result = await executeSearch(providersMap(tavily), "AAPL", 5, {
			provider: "tavily",
			vertical: "finance.us_stock",
		});
		assert.strictEqual(result.results[0].title, "generic");
	});
});

// fetch execution

const PUBLIC_FETCH_URL = "https://example.com/";

describe("executeFetch — explicit provider requested", () => {
	const tavily = mockProvider("tavily", {
		capabilities: { contentExtraction: true },
		fetchResult: { text: "tavily content", contentType: "text/markdown" },
	});

	it("uses explicitly requested provider and returns upon success", async () => {
		const result = await executeFetch(providersMap(tavily), PUBLIC_FETCH_URL, {
			provider: "tavily",
		});
		assert.strictEqual(result.provider, "tavily");
		assert.strictEqual(result.result.text, "tavily content");
	});

	it("rejects literal private targets in remote provider mode", async () => {
		await assert.rejects(
			executeFetch(providersMap(tavily), "http://127.0.0.1/", { provider: "tavily" }),
			/Blocked non-public IP/,
		);
	});

	it("passes normalized URL to remote provider to avoid cross-parser ambiguity", async () => {
		let receivedUrl = "";
		const capturingProvider: Provider = {
			name: "tavily",
			label: "tavily",
			capabilities: { ...baseCapabilities, contentExtraction: true },
			fetch: async (url) => {
				receivedUrl = url;
				return { text: "content" };
			},
		};

		await executeFetch(providersMap(capturingProvider), String.raw`http://example.com\@127.0.0.1/`, {
			provider: "tavily",
		});
		assert.strictEqual(receivedUrl, "http://example.com/@127.0.0.1/");
	});

	it("fails directly when requested provider fails without falling back to chain", async () => {
		const broken = mockProvider("tavily", {
			capabilities: { contentExtraction: true },
			fetchError: new Error("fetch down"),
		});
		const jina = mockProvider("jina", {
			capabilities: { contentExtraction: true },
			fetchResult: { text: "jina content" },
		});
		await assert.rejects(
			executeFetch(providersMap(broken, jina), PUBLIC_FETCH_URL, { provider: "tavily" }),
			/fetch down/,
		);
	});
});

describe("executeFetch — fallback chain without explicit provider", () => {
	const jina = mockProvider("jina", {
		capabilities: { contentExtraction: true },
		fetchResult: { text: "jina content" },
	});
	const anysearch = mockProvider("anysearch", {
		capabilities: { contentExtraction: true },
		fetchResult: { text: "anysearch content" },
	});

	it("returns first successful provider without invoking fallback", async () => {
		const result = await executeFetch(providersMap(jina, anysearch), PUBLIC_FETCH_URL, {});
		assert.strictEqual(result.provider, "jina");
	});

	it("tries next provider on initial failure", async () => {
		const broken = mockProvider("jina", {
			capabilities: { contentExtraction: true },
			fetchError: new Error("jina err"),
		});
		const result = await executeFetch(providersMap(broken, anysearch), PUBLIC_FETCH_URL, {});
		assert.strictEqual(result.provider, "anysearch");
	});

	it("rejects when all chain providers fail", async () => {
		const err1 = mockProvider("jina", {
			capabilities: { contentExtraction: true },
			fetchError: new Error("err1"),
		});
		await assert.rejects(executeFetch(providersMap(err1), PUBLIC_FETCH_URL, {}), /All providers failed/);
	});

	it("propagates caller cancellation without invoking subsequent providers", async () => {
		const controller = new AbortController();
		const reason = new Error("fetch cancelled by caller");
		let fallbackCalls = 0;
		const cancellingProvider: Provider = {
			name: "tavily",
			label: "tavily",
			capabilities: { ...baseCapabilities, contentExtraction: true },
			fetch: async () => {
				controller.abort(reason);
				throw reason;
			},
		};
		const fallbackProvider: Provider = {
			name: "jina",
			label: "jina",
			capabilities: { ...baseCapabilities, contentExtraction: true },
			fetch: async () => {
				fallbackCalls++;
				return { text: "unexpected" };
			},
		};

		await assert.rejects(
			executeFetch(providersMap(cancellingProvider, fallbackProvider), PUBLIC_FETCH_URL, {}, controller.signal),
			(error) => error === reason,
		);
		assert.strictEqual(fallbackCalls, 0);
	});
});

// regression: this binding

class MockSearchProvider implements Provider {
	readonly capabilities = { ...baseCapabilities, generalSearch: true, contentExtraction: true };
	constructor(
		public readonly name: string,
		public readonly label: string,
	) {}
	async search(): Promise<SearchResponse> {
		return { results: [{ title: this.name, url: "https://x", snippet: this.name }] };
	}
}

describe("executeSearch — this binding regression", () => {
	it("preserves this binding for class-based search methods", async () => {
		const p = new MockSearchProvider("tavily", "Tavily");
		const result = await executeSearch(providersMap(p), "test", 5, { provider: "tavily" });
		assert.strictEqual(result.results[0].title, "tavily");
	});
});

// regression: provider not in map

describe("executeFetch — unavailable explicit provider", () => {
	it("rejects explicitly requested missing provider instead of silent fallback", async () => {
		const jina = mockProvider("jina", {
			capabilities: { contentExtraction: true },
			fetchResult: { text: "fallback must not run" },
		});
		await assert.rejects(
			executeFetch(providersMap(jina), PUBLIC_FETCH_URL, { provider: "missing" }),
			/Requested provider "missing" is not available/,
		);
	});
});

describe("executeSearch — unavailable explicit provider", () => {
	it("rejects explicitly requested missing provider instead of silent fallback", async () => {
		const tavily = mockProvider("tavily", {
			capabilities: { generalSearch: true },
			searchResult: { results: [{ title: "chain", url: "https://c", snippet: "c" }] },
		});
		await assert.rejects(
			executeSearch(providersMap(tavily), "test", 5, { provider: "missing" }),
			/Requested provider "missing" is not available/,
		);
	});
});

describe("executeSearch — query result caching", () => {
	before(() => {
		searchCache.clear();
	});

	it("caches query results and avoids redundant outbound requests", async () => {
		let callCount = 0;
		const customProvider = {
			name: "tavily",
			label: "Tavily",
			capabilities: { ...baseCapabilities, generalSearch: true },
			search: async () => {
				callCount++;
				return { results: [{ title: `result-${callCount}`, url: "https://a", snippet: "s" }] };
			},
		};

		const map = providersMap(customProvider);

		// First call executes and populates cache
		const res1 = await executeSearch(map, "query-1", 5, { provider: "tavily" });
		assert.strictEqual(callCount, 1);
		assert.strictEqual(res1.results[0].title, "result-1");

		// Subsequent call for same query hits cache without incrementing provider calls
		const res2 = await executeSearch(map, "query-1", 5, { provider: "tavily" });
		assert.strictEqual(callCount, 1);
		assert.strictEqual(res2.results[0].title, "result-1");

		// New query penetrates cache and increments provider calls
		const res3 = await executeSearch(map, "query-2", 5, { provider: "tavily" });
		assert.strictEqual(callCount, 2);
		assert.strictEqual(res3.results[0].title, "result-2");
	});

	it("rejects gracefully when no providers exist in the search map", async () => {
		const emptyMap = new Map();
		await assert.rejects(executeSearch(emptyMap, "test", 5, {}), /No search providers available/);
	});

	it("filters out providers without generalSearch capability or search method", async () => {
		const fetchOnly = mockProvider("tavily", {
			capabilities: { generalSearch: false, contentExtraction: true },
		});
		await assert.rejects(executeSearch(providersMap(fetchOnly), "test", 5, {}), /No search providers available/);
		await assert.rejects(
			executeSearch(providersMap(fetchOnly), "test", 5, { provider: "tavily" }),
			/does not support search/,
		);
	});

	it("rejects gracefully when no providers exist in the fetch map", async () => {
		const emptyMap = new Map();
		await assert.rejects(
			executeFetch(emptyMap, "https://example.com", {}, undefined),
			/No content extraction providers available/,
		);
	});

	it("filters out providers without contentExtraction capability or fetch method", async () => {
		const searchOnly = mockProvider("tavily", {
			capabilities: { generalSearch: true, contentExtraction: false },
		});
		await assert.rejects(
			executeFetch(providersMap(searchOnly), "https://example.com", {}, undefined),
			/No content extraction providers available/,
		);
		await assert.rejects(
			executeFetch(providersMap(searchOnly), "https://example.com", { provider: "tavily" }, undefined),
			/does not support content extraction/,
		);
	});
});
