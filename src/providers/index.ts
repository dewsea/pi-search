// Provider registry — built-in adapters register statically at module load;
// user adapters are discovered later from
// <agent dir>/extensions/pi-search/providers/ by src/adapter-loader.ts and may
// override built-ins by name. Built-in provider files (src/providers/*.ts)
// are reference templates for custom adapters.

import { getProviderFactory, getProviderRegistry, registerProvider } from "../adapter-api.js";
import anysearchAdapter from "./anysearch.js";
import jinaAdapter from "./jina.js";
import tavilyAdapter from "./tavily.js";
import type { Provider, ProviderMeta } from "./types.js";

registerProvider(anysearchAdapter, "builtin");
registerProvider(jinaAdapter, "builtin");
registerProvider(tavilyAdapter, "builtin");

export const PROVIDERS: readonly ProviderMeta[] = getProviderRegistry();

export function searchProviderNames(): string[] {
	return PROVIDERS.filter((p) => p.capabilities.generalSearch).map((p) => p.name);
}

export function fetchProviderNames(): string[] {
	return PROVIDERS.filter((p) => p.capabilities.contentExtraction).map((p) => p.name);
}

export function allVerticals(): string[] {
	return PROVIDERS.flatMap((p) => p.verticals ?? []);
}

export function buildSearchChain(): string[] {
	return PROVIDERS.filter((p) => p.capabilities.generalSearch && p.searchFallbackPriority !== undefined)
		.sort((a, b) => a.searchFallbackPriority! - b.searchFallbackPriority!)
		.map((p) => p.name);
}

export function buildFetchChain(): string[] {
	return PROVIDERS.filter((p) => p.capabilities.contentExtraction && p.fetchFallbackPriority !== undefined)
		.sort((a, b) => a.fetchFallbackPriority! - b.fetchFallbackPriority!)
		.map((p) => p.name);
}

export function searchPromptGuidelines(): string[] {
	const lines: string[] = [
		"Use web_search for information beyond your training data — current events, recent docs, live data, academic papers, stock prices, CVEs.",
		"For web_search, omit provider by default so the automatic fallback chain remains available.",
		"For web_search, set provider only when the user explicitly requests a provider or a provider-specific capability is required.",
	];

	for (const meta of PROVIDERS) {
		if (meta.searchHint) {
			lines.push(
				`For web_search, when selecting a provider explicitly, ${meta.label} (provider='${meta.name}'): ${meta.searchHint}`,
			);
		}
	}

	const verts = allVerticals();
	const verticalProviders = PROVIDERS.filter((p) => p.capabilities.verticalSearch && p.verticals?.length);
	if (verticalProviders.length > 0 && verts.length > 0) {
		lines.push("For structured vertical data in web_search, select a vertical-capable provider and pass a vertical.");
		for (const p of verticalProviders) {
			lines.push(
				`For web_search, ${p.label} supports these verticals: ${p.verticals!.map((v) => `'${v}'`).join(", ")}.`,
			);
		}
		lines.push("Example for web_search: provider='anysearch' + vertical='finance.us_stock' for a stock price query.");
	}

	lines.push(
		"For web_search, omit provider for ordinary searches even when a provider seems suitable; this keeps the fallback chain enabled.",
		'After answering with web_search, include a "Sources:" section with markdown hyperlinks: [Title](URL).',
		"Use web_fetch after web_search to read full page content — web_search returns snippets only.",
		"Use {queries:[...]} with 2-4 varied angles in web_search for broader coverage — each query routes independently.",
	);

	return lines;
}

export function fetchPromptGuidelines(): string[] {
	const lines: string[] = [
		"Use web_fetch to read the full content of a URL — use it after web_search when a snippet is too short.",
		"For web_fetch, omit provider by default so the automatic fallback chain remains available.",
		"For web_fetch, set provider only when the user explicitly requests a provider or a provider-specific capability is required.",
	];

	for (const meta of PROVIDERS) {
		if (meta.fetchHint) {
			lines.push(
				`For web_fetch, when selecting a provider explicitly, ${meta.label} (provider='${meta.name}'): ${meta.fetchHint}`,
			);
		}
	}

	lines.push(
		"For web_fetch, omit provider for ordinary extraction even when a provider seems suitable; this keeps the fallback chain enabled.",
		'After reading content with web_fetch, include a "Sources:" section with markdown hyperlinks to the fetched URLs.',
		"Large web_fetch results are truncated — the full-output path is reported in the result, so use the read tool to access it.",
	);

	return lines;
}

export interface ProviderOptions {
	apiKey: string | undefined;
}

export function createProvider(name: string, opts: ProviderOptions): Provider {
	const meta = PROVIDERS.find((p) => p.name === name);
	if (!meta) {
		throw new Error(`Unknown provider: "${name}". Available: ${PROVIDERS.map((p) => p.name).join(", ")}`);
	}

	const keyRequired = meta.apiKeyRequired ?? true;
	if (keyRequired && !opts.apiKey) {
		throw new Error(`${meta.label} requires an API key`);
	}

	const factory = getProviderFactory(name);
	if (!factory) {
		throw new Error(`Implementation factory for provider "${name}" not found`);
	}

	return factory(opts);
}

export function createAvailableProviders(apiKeys: Record<string, string | undefined>): Map<string, Provider> {
	const providers = new Map<string, Provider>();
	for (const meta of PROVIDERS) {
		const key = apiKeys[meta.name];
		const keyRequired = meta.apiKeyRequired ?? true;
		if (!key && keyRequired) continue;
		try {
			providers.set(meta.name, createProvider(meta.name, { apiKey: key }));
		} catch (err) {
			console.error(`Failed to initialize provider "${meta.name}":`, err instanceof Error ? err.message : err);
			// skip providers that fail to initialize
		}
	}
	return providers;
}
