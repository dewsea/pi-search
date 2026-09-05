import { defineProvider } from "../adapter-api.js";
import type { FetchResponse, Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://api.exa.ai";
const MAX_SNIPPET_CHARS = 300;

interface ExaRawResult {
	title?: string;
	url?: string;
	text?: string;
	publishedDate?: string;
}

function normalizeResults(raw: ExaRawResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.text ?? "",
		publishedAt: r.publishedDate,
	}));
}

export const exaProvider: Provider = {
	name: "exa",
	label: "Exa",
	envVar: "EXA_API_KEY",
	searchHint: "Neural/semantic search best for academic papers, research blogs, and finding similar websites.",
	fetchHint: "Semantic livecrawl web extraction focused on clean readable text blocks.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const res = await ctx.request(`${BASE}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(ctx.apiKey ? { "x-api-key": ctx.apiKey } : {}),
			},
			body: JSON.stringify({
				query,
				numResults: maxResults,
				contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
			}),
		});
		if (!res.ok) {
			throw new Error(`Exa search error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const data = (await res.json()) as { results?: ExaRawResult[] };
		return { results: normalizeResults(data.results ?? []) };
	},

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		const res = await ctx.request(`${BASE}/contents`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(ctx.apiKey ? { "x-api-key": ctx.apiKey } : {}),
			},
			body: JSON.stringify({
				urls: [url],
				text: true,
			}),
		});
		if (!res.ok) {
			throw new Error(`Exa fetch error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const data = (await res.json()) as { results?: ExaRawResult[] };
		const r = data.results?.[0];
		if (!r?.text || typeof r.text !== "string" || r.text.trim().length === 0) {
			throw new Error(`Exa fetch: no content for ${url}`);
		}
		return { text: r.text, title: r.title, contentType: "text/plain" };
	},
};

export default defineProvider(exaProvider);
