// @hyav/pi-search — unified web search extension for Pi
//
// Registers:
//   search      — search with explicit providers
//   fetch       — fetch and extract content from a URL with explicit providers
//   /search     — configure provider credentials interactively

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadUserAdapters } from "./adapter-loader.js";
import { loadConfig, type SearchConfig } from "./config.js";
import * as providers from "./providers/index.js";
import type { Provider } from "./providers/types.js";
import { registerSearchCommand } from "./search-command.js";
import { buildFetchToolDefinition } from "./web-fetch.js";
import { buildSearchToolDefinition } from "./web-search.js";

export type { ProviderAdapter } from "./adapter-api.js";
export { defineProvider, registerProvider } from "./adapter-api.js";
export type {
	FetchResponse,
	Provider,
	ProviderContext,
	SearchResponse,
	SearchResult,
} from "./providers/types.js";

export function syncActiveToolsState(
	pi: { getActiveTools?: () => string[]; setActiveTools?: (tools: string[]) => void },
	hasSearch: boolean,
	hasFetch: boolean,
	deactivatedByExtension: Set<string>,
): string[] | undefined {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return;
	}
	const active = pi.getActiveTools();
	if (!Array.isArray(active)) return;

	let next = [...active];

	// Handle search active state
	if (!hasSearch) {
		if (next.includes("search")) {
			next = next.filter((t) => t !== "search");
			deactivatedByExtension.add("search");
		}
	} else if (deactivatedByExtension.has("search")) {
		if (!next.includes("search")) {
			next.push("search");
		}
		deactivatedByExtension.delete("search");
	}

	// Handle fetch active state
	if (!hasFetch) {
		if (next.includes("fetch")) {
			next = next.filter((t) => t !== "fetch");
			deactivatedByExtension.add("fetch");
		}
	} else if (deactivatedByExtension.has("fetch")) {
		if (!next.includes("fetch")) {
			next.push("fetch");
		}
		deactivatedByExtension.delete("fetch");
	}

	if (next.length !== active.length || next.some((t, i) => t !== active[i])) {
		pi.setActiveTools(next);
	}
	return next;
}

export interface SearchKitOptions {
	getSearchCandidates?: (config: SearchConfig) => Provider[];
	getFetchCandidates?: (config: SearchConfig) => Provider[];
}

export default async function (pi: ExtensionAPI, options?: SearchKitOptions) {
	await loadUserAdapters();

	const getSearchCandidates = options?.getSearchCandidates ?? providers.getCandidateSearchProviders;
	const getFetchCandidates = options?.getFetchCandidates ?? providers.getCandidateFetchProviders;

	// Tracks tools deactivated by the extension because candidate provider count was zero.
	// This enables restoring them when credentials/candidates become available,
	// while respecting the user's manual choice if the user intentionally deactivated them.
	const deactivatedByExtension = new Set<string>();

	const initialConfig = loadConfig();
	if (getSearchCandidates(initialConfig).length === 0) {
		deactivatedByExtension.add("search");
	}
	if (getFetchCandidates(initialConfig).length === 0) {
		deactivatedByExtension.add("fetch");
	}

	const updateTools = () => {
		const config = loadConfig();
		const searchCandidates = getSearchCandidates(config);
		const fetchCandidates = getFetchCandidates(config);

		if (searchCandidates.length > 0) {
			const searchDef = buildSearchToolDefinition(searchCandidates, config);
			pi.registerTool(searchDef);
		}

		if (fetchCandidates.length > 0) {
			const fetchDef = buildFetchToolDefinition(fetchCandidates, config);
			pi.registerTool(fetchDef);
		}
	};

	const syncActiveTools = () => {
		try {
			const config = loadConfig();
			const hasSearch = getSearchCandidates(config).length > 0;
			const hasFetch = getFetchCandidates(config).length > 0;
			syncActiveToolsState(pi, hasSearch, hasFetch, deactivatedByExtension);
		} catch {
			// Action methods throw during extension load; safely ignore if called outside active runtime
		}
	};

	// Initial registration at extension load (does not invoke active tool actions)
	updateTools();

	// Update active tools on session start when runtime is active
	pi.on?.("session_start", () => {
		updateTools();
		syncActiveTools();
	});

	// Register /search command with live tool update on credential modification
	registerSearchCommand(pi, async () => {
		updateTools();
		syncActiveTools();
	});
}
