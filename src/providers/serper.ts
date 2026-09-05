import { defineProvider } from "../adapter-api.js";
import type { Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://google.serper.dev";

interface SerperRawResult {
	title?: string;
	link?: string;
	snippet?: string;
	date?: string;
}

function normalizeResults(raw: SerperRawResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.link ?? "",
		snippet: r.snippet ?? "",
		publishedAt: r.date,
	}));
}

export const serperProvider: Provider = {
	name: "serper",
	label: "Serper",
	envVar: "SERPER_API_KEY",
	searchHint: "Direct Google Search wrapper returning organic search results and snippets.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const res = await ctx.request(`${BASE}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(ctx.apiKey ? { "X-API-KEY": ctx.apiKey } : {}),
			},
			body: JSON.stringify({ q: query, num: maxResults }),
		});

		if (!res.ok) {
			throw new Error(`Serper search error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as { organic?: SerperRawResult[] };
		return { results: normalizeResults(data.organic ?? []) };
	},
};

export default defineProvider(serperProvider);
