import assert from "node:assert";
import { describe, it } from "node:test";
import { executeFetch, executeSearch } from "../src/execution.js";
import type { FetchResponse, Provider, ProviderContext, SearchResponse } from "../src/providers/types.js";

function mockSearchProvider(
	name: string,
	handler: (query: string, maxResults: number, ctx: ProviderContext) => Promise<SearchResponse>,
	overrides: Partial<Provider> = {},
): Provider {
	return {
		name,
		label: name.toUpperCase(),
		envVar: `${name.toUpperCase()}_API_KEY`,
		searchHint: `${name} search`,
		search: handler,
		...overrides,
	};
}

function mockFetchProvider(
	name: string,
	handler: (url: string, ctx: ProviderContext) => Promise<FetchResponse>,
	overrides: Partial<Provider> = {},
): Provider {
	return {
		name,
		label: name.toUpperCase(),
		envVar: `${name.toUpperCase()}_API_KEY`,
		fetchHint: `${name} fetch`,
		fetch: handler,
		...overrides,
	};
}

describe("unified execution — executeSearch", () => {
	it("preserves input order of providers even when execution resolves out of order", async () => {
		const fast = mockSearchProvider("fast", async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { results: [{ title: "Fast result", url: "https://fast.com", snippet: "fast" }] };
		});
		const slow = mockSearchProvider("slow", async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { results: [{ title: "Slow result", url: "https://slow.com", snippet: "slow" }] };
		});

		// Requested order: slow, then fast
		const result = await executeSearch([slow, fast], "test query", 5, {
			apiKeys: {},
		});

		assert.strictEqual(result.items.length, 2);
		assert.strictEqual(result.items[0].provider, "slow");
		assert.strictEqual(result.items[0].status, "success");
		assert.strictEqual(result.items[1].provider, "fast");
		assert.strictEqual(result.items[1].status, "success");
	});

	it("bounds concurrency to at most 3 providers at a time", async () => {
		let running = 0;
		let maxConcurrent = 0;

		const makeProvider = (name: string) =>
			mockSearchProvider(name, async () => {
				running++;
				maxConcurrent = Math.max(maxConcurrent, running);
				await new Promise((resolve) => setTimeout(resolve, 30));
				running--;
				return { results: [{ title: name, url: `https://${name}.com`, snippet: name }] };
			});

		const providers = [
			makeProvider("p1"),
			makeProvider("p2"),
			makeProvider("p3"),
			makeProvider("p4"),
			makeProvider("p5"),
		];

		const result = await executeSearch(providers, "concurrency test", 5, { apiKeys: {} });
		assert.strictEqual(result.items.length, 5);
		assert.ok(maxConcurrent <= 3, `Max concurrency was ${maxConcurrent}, expected <= 3`);
	});

	it("returns partial success when at least one provider succeeds and one fails", async () => {
		const good = mockSearchProvider("good", async () => ({
			results: [{ title: "Good", url: "https://good.com", snippet: "good" }],
		}));
		const bad = mockSearchProvider("bad", async () => {
			throw new Error("API rate limit exceeded");
		});

		const result = await executeSearch([good, bad], "partial test", 5, { apiKeys: {} });
		assert.strictEqual(result.items.length, 2);

		const goodItem = result.items.find((i) => i.provider === "good");
		assert.strictEqual(goodItem?.status, "success");
		if (goodItem?.status === "success") {
			assert.strictEqual(goodItem.results.length, 1);
		}

		const badItem = result.items.find((i) => i.provider === "bad");
		assert.strictEqual(badItem?.status, "error");
		if (badItem?.status === "error") {
			assert.match(badItem.error, /rate limit/);
		}
	});

	it("throws aggregate error when all providers fail", async () => {
		const bad1 = mockSearchProvider("bad1", async () => {
			throw new Error("connection timeout");
		});
		const bad2 = mockSearchProvider("bad2", async () => {
			throw new Error("invalid api key");
		});

		await assert.rejects(executeSearch([bad1, bad2], "all fail test", 5, { apiKeys: {} }), (err: Error) => {
			assert.match(err.message, /bad1.*timeout/);
			assert.match(err.message, /bad2.*invalid api key/);
			return true;
		});
	});

	it("treats empty search results from all providers as valid success", async () => {
		const empty1 = mockSearchProvider("empty1", async () => ({ results: [] }));
		const empty2 = mockSearchProvider("empty2", async () => ({ results: [] }));

		const result = await executeSearch([empty1, empty2], "no results query", 5, { apiKeys: {} });
		assert.strictEqual(result.items.length, 2);
		assert.strictEqual(result.items[0].status, "success");
		assert.strictEqual(result.items[1].status, "success");
	});

	it("propagates caller cancellation and stops pending tasks", async () => {
		const ac = new AbortController();
		let secondStarted = false;

		const p1 = mockSearchProvider("p1", async (_q, _m, ctx) => {
			ac.abort(new Error("caller cancelled"));
			ctx.signal.throwIfAborted();
			return { results: [] };
		});
		const p2 = mockSearchProvider("p2", async () => {
			secondStarted = true;
			return { results: [] };
		});

		await assert.rejects(
			executeSearch([p1, p2], "cancel test", 5, { apiKeys: {}, signal: ac.signal }),
			/caller cancelled/,
		);
		assert.strictEqual(secondStarted, false);
	});
});

describe("unified execution — executeFetch", () => {
	it("preserves input order and returns partial success", async () => {
		const f1 = mockFetchProvider("f1", async () => ({ text: "F1 content" }));
		const f2 = mockFetchProvider("f2", async () => {
			throw new Error("Blocked by robots.txt");
		});

		const result = await executeFetch([f1, f2], "https://example.com/doc", { apiKeys: {} });
		assert.strictEqual(result.items.length, 2);
		assert.strictEqual(result.items[0].provider, "f1");
		assert.strictEqual(result.items[0].status, "success");
		assert.strictEqual(result.items[1].provider, "f2");
		assert.strictEqual(result.items[1].status, "error");
	});

	it("treats empty text as provider execution failure", async () => {
		const emptyFetch = mockFetchProvider("empty", async () => ({ text: "" }));
		const goodFetch = mockFetchProvider("good", async () => ({ text: "Valid content" }));

		const result = await executeFetch([emptyFetch, goodFetch], "https://example.com/doc", { apiKeys: {} });
		assert.strictEqual(result.items[0].status, "error");
		assert.match((result.items[0] as { error: string }).error, /empty/i);
		assert.strictEqual(result.items[1].status, "success");
	});

	it("throws aggregate error when all fetch providers fail", async () => {
		const f1 = mockFetchProvider("f1", async () => {
			throw new Error("HTTP 403 Forbidden");
		});
		const f2 = mockFetchProvider("f2", async () => {
			throw new Error("HTTP 500 Internal Server Error");
		});

		await assert.rejects(executeFetch([f1, f2], "https://example.com/doc", { apiKeys: {} }), (err: Error) => {
			assert.match(err.message, /f1.*403/);
			assert.match(err.message, /f2.*500/);
			return true;
		});
	});

	it("normalizes and caps search results at maxResults, filtering items without url, collapsing multiline title, and deduplicating URLs", async () => {
		const bloated = mockSearchProvider("bloated", async () => ({
			results: [
				{ title: "No URL 1", snippet: "skip me" } as any,
				{ title: "Javascript protocol", url: "javascript:alert(1)", snippet: "skip me too" },
				{ title: "Data protocol", url: "data:text/html,bad", snippet: "skip me too" },
				{ title: "Hit 1\n  with\tmultiline  ", url: "https://example.com/1", snippet: "s1" },
				{ title: "Duplicate Hit 1", url: "HTTPS://EXAMPLE.COM/1", snippet: "duplicate url" },
				{ title: "No URL 2", url: "", snippet: "skip me too" },
				{ title: "Hit 2", url: "https://example.com/2", snippet: "s2" },
				{ title: "Hit 3", url: "https://example.com/3", snippet: "s3" },
				{ title: "Hit 4", url: "https://example.com/4", snippet: "s4" },
			],
		}));

		const res = await executeSearch([bloated], "query", 2, { apiKeys: {} });
		assert.strictEqual(res.items[0].status, "success");
		if (res.items[0].status === "success") {
			assert.strictEqual(res.items[0].results.length, 2);
			assert.strictEqual(res.items[0].results[0].url, "https://example.com/1");
			assert.strictEqual(res.items[0].results[0].title, "Hit 1 with multiline");
			assert.strictEqual(res.items[0].results[1].url, "https://example.com/2");
		}
	});

	it("races uncooperative hanging adapter against cancellation signal", async () => {
		const hanging = mockSearchProvider("hanging", async () => {
			// Uncooperative adapter that never returns and ignores signal
			return new Promise<SearchResponse>(() => {});
		});

		const ac = new AbortController();
		const executePromise = executeSearch([hanging], "query", 5, { apiKeys: {}, signal: ac.signal });

		setTimeout(() => ac.abort(new Error("caller timeout")), 20);

		await assert.rejects(executePromise, /caller timeout/);
	});

	it("sanitizes HTML, tokens, and bounds length in aggregate errors", async () => {
		const htmlError = mockSearchProvider("html_fail", async () => {
			throw new Error(
				"<html><body><h1>502 Bad Gateway</h1><p>Bearer secret_token_12345 key=AIzaSySecret12345</p></body></html>".repeat(
					20,
				),
			);
		});

		await assert.rejects(executeSearch([htmlError], "query", 5, { apiKeys: {} }), (err: Error) => {
			assert.ok(!err.message.includes("<h1"), "HTML tags should be stripped");
			assert.ok(!err.message.includes("secret_token_12345"), "Tokens should be redacted");
			assert.ok(!err.message.includes("AIzaSySecret12345"), "API key parameters should be redacted");
			assert.ok(err.message.length <= 1000, `Error message too long: ${err.message.length}`);
			return true;
		});
	});
});
