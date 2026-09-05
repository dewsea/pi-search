import assert from "node:assert";
import { describe, it } from "node:test";
import { fetchPromptGuidelines, PROVIDERS, searchPromptGuidelines } from "../src/providers/index.js";

function lines(): string[] {
	return searchPromptGuidelines(PROVIDERS);
}

function flines(): string[] {
	return fetchPromptGuidelines(PROVIDERS);
}

describe("search promptGuidelines aggregation", () => {
	it("includes guidelines for all searchHint providers in candidates", () => {
		const searchCandidates = PROVIDERS.filter((p) => p.searchHint);
		const text = searchPromptGuidelines(searchCandidates).join("\n");
		for (const provider of searchCandidates) {
			assert.ok(
				text.includes(provider.label) && text.includes(`providers: ["${provider.name}"]`),
				`missing ${provider.label}`,
			);
		}
	});

	it("explicitly names search in every guideline entry", () => {
		for (const guideline of lines()) {
			assert.ok(guideline.trim(), "promptGuidelines should not contain empty rules");
			assert.ok(guideline.includes("search"), `rule does not name search: ${guideline}`);
		}
	});

	it("excludes pure fetch-only providers from search guidelines", () => {
		const searchCandidates = PROVIDERS.filter((p) => typeof p.search === "function");
		const text = searchPromptGuidelines(searchCandidates).join("\n");
		for (const provider of PROVIDERS.filter((p) => typeof p.search !== "function")) {
			assert.ok(
				!text.includes(`providers: ["${provider.name}"]`),
				`${provider.label} should not appear in search hints`,
			);
		}
	});

	it("does not mention deprecated fallback priority, queries, or raw", () => {
		const text = lines().join("\n");
		assert.ok(!text.includes("fallback chain"), "must not mention fallback chain");
		assert.ok(!text.includes("omit provider"), "must not mention omit provider");
		assert.ok(!text.includes("queries"), "must not mention queries");
		assert.ok(!text.includes("research="), "must not mention research");
	});
});

describe("fetch promptGuidelines aggregation", () => {
	it("includes guidelines for all fetchHint providers in candidates", () => {
		const fetchCandidates = PROVIDERS.filter((p) => p.fetchHint);
		const text = fetchPromptGuidelines(fetchCandidates).join("\n");
		for (const provider of fetchCandidates) {
			assert.ok(
				text.includes(provider.label) && text.includes(`providers: ["${provider.name}"]`),
				`missing ${provider.label}`,
			);
		}
	});

	it("explicitly names fetch in every guideline entry", () => {
		for (const guideline of flines()) {
			assert.ok(guideline.trim(), "promptGuidelines should not contain empty rules");
			assert.ok(guideline.includes("fetch"), `rule does not name fetch: ${guideline}`);
		}
	});

	it("does not mention deprecated fallback priority or omit provider", () => {
		const text = flines().join("\n");
		assert.ok(!text.includes("fallback chain"), "must not mention fallback chain");
		assert.ok(!text.includes("omit provider"), "must not mention omit provider");
	});
});
