import { defineProvider } from "../adapter-api.js";
import type { FetchResponse, Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://api.tavily.com";

interface TavilyRawResult {
	title?: string;
	url?: string;
	content?: string;
	score?: number;
}

interface TavilyExtractResult {
	url?: string;
	raw_content?: string;
	title?: string;
}

interface TavilyExtractResponse {
	results?: TavilyExtractResult[];
	failed_results?: Array<{ url?: string; error?: string }>;
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else {
		headers["X-Tavily-Access-Mode"] = "keyless";
	}
	return headers;
}

function normalizeResults(raw: TavilyRawResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
		score: r.score,
	}));
}

export const tavilyProvider: Provider = {
	name: "tavily",
	label: "Tavily",
	envVar: "TAVILY_API_KEY",
	keyless: true,
	searchHint: "Optimized for general AI agent retrieval, fact search, programming Q&A, and technical documentation.",
	fetchHint: "Fast markdown content extraction stripping web noise like headers, footers, and ads.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const res = await ctx.request(`${BASE}/search`, {
			method: "POST",
			headers: authHeaders(ctx.apiKey),
			body: JSON.stringify({ query, max_results: maxResults }),
		});
		if (!res.ok) {
			throw new Error(`Tavily search error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const data = (await res.json()) as { results?: TavilyRawResult[] };
		return { results: normalizeResults(data.results ?? []) };
	},

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		const res = await ctx.request(`${BASE}/extract`, {
			method: "POST",
			headers: authHeaders(ctx.apiKey),
			body: JSON.stringify({ urls: [url] }),
		});
		if (!res.ok) {
			throw new Error(`Tavily extract error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const data = (await res.json()) as TavilyExtractResponse;
		if (data.failed_results?.length) {
			const f = data.failed_results[0];
			throw new Error(`Tavily extract failed for ${f?.url ?? url}: ${f?.error ?? "unknown"}`);
		}
		const r = data.results?.[0];
		if (!r?.raw_content) throw new Error(`Tavily extract: no content for ${url}`);
		return { text: r.raw_content, title: r.title, contentType: "text/markdown" };
	},
};

export default defineProvider(tavilyProvider);
