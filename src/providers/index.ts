// Provider registry — built-in adapters register statically at module load;
// user adapters are discovered later from
// <agent dir>/extensions/pi-search/providers/ by src/adapter-loader.ts and may
// override built-ins by name.

import { getProviderRegistry, registerProvider } from "../adapter-api.js";
import { resolveProviderCredential, type SearchConfig } from "../config.js";
import anysearchAdapter from "./anysearch.js";
import braveAdapter from "./brave.js";
import exaAdapter from "./exa.js";
import firecrawlAdapter from "./firecrawl.js";
import jinaAdapter from "./jina.js";
import serpapiAdapter from "./serpapi.js";
import serperAdapter from "./serper.js";
import tavilyAdapter from "./tavily.js";
import tinyfishAdapter from "./tinyfish.js";
import type { Provider } from "./types.js";

// Register all 9 built-in providers statically
registerProvider(tavilyAdapter, "builtin");
registerProvider(anysearchAdapter, "builtin");
registerProvider(jinaAdapter, "builtin");
registerProvider(exaAdapter, "builtin");
registerProvider(serperAdapter, "builtin");
registerProvider(firecrawlAdapter, "builtin");
registerProvider(braveAdapter, "builtin");
registerProvider(tinyfishAdapter, "builtin");
registerProvider(serpapiAdapter, "builtin");

export const PROVIDERS: readonly Provider[] = getProviderRegistry();

export function getCandidateSearchProviders(config: SearchConfig, env: NodeJS.ProcessEnv = process.env): Provider[] {
	return getProviderRegistry().filter((p) => {
		if (typeof p.search !== "function") return false;
		const cred = resolveProviderCredential(p, config, env);
		return cred.status !== "unconfigured";
	});
}

export function getCandidateFetchProviders(config: SearchConfig, env: NodeJS.ProcessEnv = process.env): Provider[] {
	return getProviderRegistry().filter((p) => {
		if (typeof p.fetch !== "function") return false;
		const cred = resolveProviderCredential(p, config, env);
		return cred.status !== "unconfigured";
	});
}

export function searchPromptGuidelines(candidates: readonly Provider[]): string[] {
	const lines: string[] = [
		"For search, specify providers: string[] explicitly naming one or more providers from the available list.",
		"For search, choose a single suitable provider for ordinary search tasks. Select multiple providers when comparison, broader coverage, or cross-verification is needed.",
		"For search, select providers based on their capabilities and result characteristics; no single provider is best for all tasks.",
		"For search, note that Serper and SerpApi both use Google Search and should not be treated as independent search indexes.",
		"For search, each result preserves its provider source. When answering, cite sources with markdown hyperlinks: [Title](URL).",
	];

	for (const p of candidates) {
		if (p.searchHint) {
			lines.push(`For search, ${p.label} (providers: ["${p.name}"]): ${p.searchHint}`);
		}
	}

	return lines;
}

export function fetchPromptGuidelines(candidates: readonly Provider[]): string[] {
	const lines: string[] = [
		"For fetch, specify providers: string[] explicitly naming one or more providers from the available list.",
		"For fetch, choose a single suitable provider for ordinary extraction tasks. Select multiple providers when comparing extraction quality or ensuring completeness.",
		"For fetch, use fetch to read the full content of relevant URLs identified during search.",
	];

	for (const p of candidates) {
		if (p.fetchHint) {
			lines.push(`For fetch, ${p.label} (providers: ["${p.name}"]): ${p.fetchHint}`);
		}
	}

	lines.push(
		"For fetch, large results are truncated — the full-output path is reported in the result, so use the read tool to access it.",
	);

	return lines;
}
