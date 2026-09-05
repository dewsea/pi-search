import { defineProvider } from "../adapter-api.js";
import type { FetchResponse, Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const BASE = "https://api.anysearch.com";

interface AnysearchRawResult {
	title?: string;
	url?: string;
	description?: string;
	content?: string;
	raw_content?: string;
	score?: number;
	quality_score?: number;
	published_at?: string;
}

interface AnysearchSearchEnvelope {
	code: number;
	message: string;
	data?: {
		results?: AnysearchRawResult[];
	};
}

interface AnysearchExtractEnvelope {
	code: number;
	message: string;
	request_id?: string;
	data?: {
		url?: string;
		title?: string;
		content?: string;
	};
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

function normalizeResults(raw: AnysearchRawResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: (r.content && r.content.length > 10 ? r.content : r.description) ?? "",
		score: r.quality_score ?? r.score,
		publishedAt: r.published_at,
	}));
}

export const anysearchProvider: Provider = {
	name: "anysearch",
	label: "AnySearch",
	envVar: "ANYSEARCH_API_KEY",
	keyless: true,
	searchHint: "General search engine indexing public web pages with quick factual lookups.",
	fetchHint: "Extracts main page article text and basic metadata.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const res = await ctx.request(`${BASE}/v1/search`, {
			method: "POST",
			headers: authHeaders(ctx.apiKey),
			body: JSON.stringify({ query, max_results: maxResults }),
		});
		if (!res.ok) {
			throw new Error(`AnySearch search error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const envelope = (await res.json()) as AnysearchSearchEnvelope;
		if (envelope.code !== 0) {
			throw new Error(`AnySearch API error: ${envelope.message}`);
		}
		return { results: normalizeResults(envelope.data?.results ?? []) };
	},

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		const res = await ctx.request(`${BASE}/v1/extract`, {
			method: "POST",
			headers: authHeaders(ctx.apiKey),
			body: JSON.stringify({ url }),
		});
		if (!res.ok) {
			throw new Error(`AnySearch extract error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const envelope = (await res.json()) as AnysearchExtractEnvelope;
		if (envelope.code !== 0) {
			throw new Error(`AnySearch API error: ${envelope.message}`);
		}
		const content = envelope.data?.content;
		if (typeof content !== "string" || content.trim().length === 0) {
			throw new Error(`AnySearch extract: no content for ${url}`);
		}
		const title =
			typeof envelope.data?.title === "string" && envelope.data.title.trim().length > 0
				? envelope.data.title.trim()
				: undefined;
		return {
			text: content,
			title,
			contentType: "text/markdown",
		};
	},
};

export default defineProvider(anysearchProvider);
