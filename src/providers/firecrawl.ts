import { defineProvider } from "../adapter-api.js";
import type { FetchResponse, Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://api.firecrawl.dev/v2";

interface FirecrawlSearchResult {
	url?: string;
	title?: string;
	description?: string;
	snippet?: string;
	markdown?: string;
}

interface FirecrawlSearchResponse {
	success?: boolean;
	data?:
		| {
				web?: FirecrawlSearchResult[];
				news?: FirecrawlSearchResult[];
		  }
		| FirecrawlSearchResult[];
	error?: string;
}

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: {
		markdown?: string;
		title?: string;
		metadata?: {
			title?: string;
		};
	};
	error?: string;
}

function normalizeSearchResults(raw: FirecrawlSearchResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? r.snippet ?? r.markdown?.slice(0, 300) ?? "",
	}));
}

export const firecrawlProvider: Provider = {
	name: "firecrawl",
	label: "Firecrawl",
	envVar: "FIRECRAWL_API_KEY",
	searchHint: "Web search with crawler-backed indexing.",
	fetchHint: "Headless browser extraction capable of JavaScript execution for dynamic web apps.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const res = await ctx.request(`${BASE}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
			},
			body: JSON.stringify({ query, limit: maxResults }),
		});

		if (!res.ok) {
			throw new Error(`Firecrawl search error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as FirecrawlSearchResponse;
		if (data.error) {
			throw new Error(`Firecrawl search error: ${data.error}`);
		}

		const rawResults = Array.isArray(data.data) ? data.data : (data.data?.web ?? []);
		return { results: normalizeSearchResults(rawResults) };
	},

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		const res = await ctx.request(`${BASE}/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
			},
			body: JSON.stringify({ url, formats: ["markdown"] }),
		});

		if (!res.ok) {
			throw new Error(`Firecrawl scrape error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as FirecrawlScrapeResponse;
		if (data.error) {
			throw new Error(`Firecrawl scrape error: ${data.error}`);
		}

		if (!data.data?.markdown) throw new Error(`Firecrawl: no content for ${url}`);
		return {
			text: data.data.markdown,
			title: data.data.title ?? data.data.metadata?.title,
			contentType: "text/markdown",
		};
	},
};

export default defineProvider(firecrawlProvider);
