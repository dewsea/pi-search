import assert from "node:assert";
import { describe, it } from "node:test";
import { fetchPromptGuidelines, PROVIDERS, searchPromptGuidelines } from "../src/providers/index.js";

function lines(): string[] {
	return searchPromptGuidelines();
}

function flines(): string[] {
	return fetchPromptGuidelines();
}

describe("search promptGuidelines aggregation", () => {
	it("includes guidelines for all searchHint providers", () => {
		const text = lines().join("\n");
		for (const provider of PROVIDERS.filter((meta) => meta.searchHint)) {
			assert.ok(
				text.includes(provider.label) && text.includes(`provider='${provider.name}'`),
				`missing ${provider.label}`,
			);
		}
	});

	it("explicitly names web_search in every guideline entry", () => {
		for (const guideline of lines()) {
			assert.ok(guideline.trim(), "promptGuidelines should not contain empty rules");
			assert.ok(guideline.includes("web_search"), `rule does not name web_search: ${guideline}`);
		}
	});

	it("excludes pure fetch-only providers from search guidelines", () => {
		const text = lines().join("\n");
		for (const provider of PROVIDERS.filter((meta) => !meta.capabilities.generalSearch)) {
			assert.ok(
				!text.includes(`provider='${provider.name}'`),
				`${provider.label} should not appear in search hints`,
			);
		}
	});

	it("includes introduction and trailing operational rules", () => {
		const text = lines().join("\n");
		assert.ok(text.includes("Use web_search for information beyond your training data"));
		assert.ok(text.includes("For web_search, omit provider for ordinary searches"));
		assert.ok(text.includes("Sources:"));
		assert.ok(text.includes("Use {queries:[...]} with 2-4 varied angles"));
	});
});

describe("fetch promptGuidelines aggregation", () => {
	it("includes guidelines for all fetchHint providers", () => {
		const text = flines().join("\n");
		for (const provider of PROVIDERS.filter((meta) => meta.fetchHint)) {
			assert.ok(
				text.includes(provider.label) && text.includes(`provider='${provider.name}'`),
				`missing ${provider.label}`,
			);
		}
	});

	it("explicitly names web_fetch in every guideline entry", () => {
		for (const guideline of flines()) {
			assert.ok(guideline.trim(), "promptGuidelines should not contain empty rules");
			assert.ok(guideline.includes("web_fetch"), `rule does not name web_fetch: ${guideline}`);
		}
	});

	it("prioritizes automatic fallback over provider-specific routing", () => {
		const searchText = lines().join("\n");
		const fetchText = flines().join("\n");

		assert.ok(searchText.includes("omit provider by default so the automatic fallback chain remains available"));
		assert.ok(searchText.includes("set provider only when the user explicitly requests a provider"));
		assert.ok(fetchText.includes("omit provider by default so the automatic fallback chain remains available"));
		assert.ok(fetchText.includes("set provider only when the user explicitly requests a provider"));
	});

	it("includes introduction and trailing operational rules", () => {
		const text = flines().join("\n");
		assert.ok(text.includes("Use web_fetch to read the full content of a URL"));
		assert.ok(text.includes("For web_fetch, omit provider for ordinary extraction"));
		assert.ok(text.includes("Sources:"));
		assert.ok(text.includes("use the read tool to access it"));
	});
});
