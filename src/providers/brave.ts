import { defineProvider } from "../adapter-api.js";
import type { Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://api.search.brave.com/res/v1/web/search";

interface BraveWebResult {
	title?: string;
	url?: string;
	description?: string;
	page_age?: string;
}

interface BraveSearchResponse {
	web?: {
		results?: BraveWebResult[];
	};
	message?: string;
}

function normalizeResults(raw: BraveWebResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
		publishedAt: r.page_age,
	}));
}

export const braveProvider: Provider = {
	name: "brave",
	label: "Brave",
	envVar: "BRAVE_API_KEY",
	searchHint: "Independent web search index with broad general web coverage.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const url = `${BASE}?q=${encodeURIComponent(query)}&count=${maxResults}`;
		const res = await ctx.request(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				...(ctx.apiKey ? { "X-Subscription-Token": ctx.apiKey } : {}),
			},
		});

		if (!res.ok) {
			throw new Error(`Brave search error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as BraveSearchResponse;
		return { results: normalizeResults(data.web?.results ?? []) };
	},
};

export default defineProvider(braveProvider);
