import { defineProvider } from "../adapter-api.js";
import type { Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://serpapi.com/search.json";

interface SerpApiOrganicResult {
	title?: string;
	link?: string;
	snippet?: string;
	date?: string;
}

interface SerpApiResponse {
	error?: string;
	organic_results?: SerpApiOrganicResult[];
}

function normalizeResults(raw: SerpApiOrganicResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.link ?? "",
		snippet: r.snippet ?? "",
		publishedAt: r.date,
	}));
}

export const serpapiProvider: Provider = {
	name: "serpapi",
	label: "SerpApi",
	envVar: "SERPAPI_API_KEY",
	searchHint: "Google Search API returning rich organic search results.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		let url = `${BASE}?q=${encodeURIComponent(query)}&num=${maxResults}&engine=google`;
		if (ctx.apiKey) {
			url += `&api_key=${encodeURIComponent(ctx.apiKey)}`;
		}

		const res = await ctx.request(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
		});

		if (!res.ok) {
			throw new Error(`SerpApi search error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as SerpApiResponse;
		if (data.error) {
			throw new Error(`SerpApi search error: ${data.error}`);
		}

		return { results: normalizeResults(data.organic_results ?? []) };
	},
};

export default defineProvider(serpapiProvider);
