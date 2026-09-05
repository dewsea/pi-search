import assert from "node:assert";
import { describe, it } from "node:test";
import { defineProvider, type Provider, validateProviderAdapter } from "../src/adapter-api.js";

function baseSearchProvider(overrides: Partial<Provider> = {}): Provider {
	return {
		name: "search-test",
		label: "Search Test",
		envVar: "SEARCH_TEST_API_KEY",
		searchHint: "search test hint",
		async search() {
			return { results: [] };
		},
		...overrides,
	};
}

function baseFetchProvider(overrides: Partial<Provider> = {}): Provider {
	return {
		name: "fetch-test",
		label: "Fetch Test",
		envVar: "FETCH_TEST_API_KEY",
		fetchHint: "fetch test hint",
		async fetch() {
			return { text: "content" };
		},
		...overrides,
	};
}

describe("validateProviderAdapter — unified Provider runtime checks", () => {
	it("accepts valid search-only, fetch-only, and dual providers", () => {
		const searchOnly = baseSearchProvider();
		assert.doesNotThrow(() => validateProviderAdapter(searchOnly));
		assert.strictEqual(defineProvider(searchOnly), searchOnly);

		const fetchOnly = baseFetchProvider();
		assert.doesNotThrow(() => validateProviderAdapter(fetchOnly));
		assert.strictEqual(defineProvider(fetchOnly), fetchOnly);

		const dual = baseSearchProvider({
			fetchHint: "fetch hint",
			async fetch() {
				return { text: "both" };
			},
		});
		assert.doesNotThrow(() => validateProviderAdapter(dual));
		assert.strictEqual(defineProvider(dual), dual);
	});

	it("accepts optional keyless boolean flag", () => {
		const keylessTrue = baseSearchProvider({ keyless: true });
		assert.doesNotThrow(() => validateProviderAdapter(keylessTrue));

		const keylessFalse = baseSearchProvider({ keyless: false });
		assert.doesNotThrow(() => validateProviderAdapter(keylessFalse));
	});

	it("rejects non-object or null inputs", () => {
		for (const input of [null, undefined, "provider", 123, true]) {
			assert.throws(
				() => validateProviderAdapter(input),
				/Provider adapter must be an object/,
				`${JSON.stringify(input)} must be rejected`,
			);
		}
	});

	it("reports migration error for deprecated v0.1 adapters with create or capabilities", () => {
		const legacyWithCreate = {
			name: "legacy",
			label: "Legacy",
			envVar: "LEGACY_KEY",
			create: () => ({}),
		};
		assert.throws(
			() => validateProviderAdapter(legacyWithCreate),
			/deprecated v0\.1 contract \(create\/capabilities\)/,
		);

		const legacyWithCaps = {
			name: "legacy-caps",
			label: "Legacy Caps",
			envVar: "LEGACY_KEY",
			capabilities: { generalSearch: true },
		};
		assert.throws(
			() => validateProviderAdapter(legacyWithCaps),
			/deprecated v0\.1 contract \(create\/capabilities\)/,
		);
	});

	it("rejects non-string name, label, and envVar values", () => {
		for (const [field, value] of [
			["name", 123],
			["name", ""],
			["name", "   "],
			["label", {}],
			["label", ""],
			["envVar", []],
			["envVar", "   "],
		] as const) {
			assert.throws(
				() => validateProviderAdapter(baseSearchProvider({ [field]: value } as never)),
				/non-empty string/,
				`${field}=${JSON.stringify(value)} must be rejected`,
			);
		}
	});

	it("rejects non-boolean keyless values", () => {
		for (const value of ["true", 1, {}, []]) {
			assert.throws(
				() => validateProviderAdapter(baseSearchProvider({ keyless: value as never })),
				/keyless must be a boolean/,
			);
		}
	});

	it("rejects provider implementing neither search nor fetch", () => {
		assert.throws(
			() =>
				validateProviderAdapter({
					name: "no-methods",
					label: "No Methods",
					envVar: "NO_METHODS_API_KEY",
				}),
			/must implement at least one method: search or fetch/,
		);
	});

	it("rejects non-function search or fetch properties", () => {
		assert.throws(
			() => validateProviderAdapter(baseSearchProvider({ search: "not-a-func" as never })),
			/search must be a function/,
		);
		assert.throws(
			() => validateProviderAdapter(baseFetchProvider({ fetch: 123 as never })),
			/fetch must be a function/,
		);
	});

	it("enforces searchHint rules matching search method presence", () => {
		// Implements search, but missing or empty searchHint
		assert.throws(
			() => validateProviderAdapter(baseSearchProvider({ searchHint: undefined })),
			/implements search but declares no searchHint/,
		);
		assert.throws(
			() => validateProviderAdapter(baseSearchProvider({ searchHint: "   " })),
			/implements search but declares no searchHint/,
		);

		// Does not implement search, but declares searchHint
		assert.throws(
			() => validateProviderAdapter(baseFetchProvider({ searchHint: "unimplemented search hint" })),
			/declares searchHint but does not implement search\(\)/,
		);
	});

	it("enforces fetchHint rules matching fetch method presence", () => {
		// Implements fetch, but missing or empty fetchHint
		assert.throws(
			() => validateProviderAdapter(baseFetchProvider({ fetchHint: undefined })),
			/implements fetch but declares no fetchHint/,
		);
		assert.throws(
			() => validateProviderAdapter(baseFetchProvider({ fetchHint: "" })),
			/implements fetch but declares no fetchHint/,
		);

		// Does not implement fetch, but declares fetchHint
		assert.throws(
			() => validateProviderAdapter(baseSearchProvider({ fetchHint: "unimplemented fetch hint" })),
			/declares fetchHint but does not implement fetch\(\)/,
		);
	});

	it("preserves this binding for class or object method providers", async () => {
		class TestClassProvider implements Provider {
			name = "class-test";
			label = "Class Test";
			envVar = "CLASS_TEST_API_KEY";
			searchHint = "class search";
			private prefix = "result:";

			async search(query: string, _maxResults: number, _ctx: any) {
				return { results: [{ title: `${this.prefix} ${query}`, url: "https://example.com", snippet: "" }] };
			}
		}

		const instance = new TestClassProvider();
		validateProviderAdapter(instance);
		const res = await instance.search("query", 5, {} as never);
		assert.strictEqual(res.results[0].title, "result: query");
	});
});
