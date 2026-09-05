import { defineProvider } from "../adapter-api.js";
import type { FetchResponse, Provider, ProviderContext, SearchResponse, SearchResult } from "./types.js";

const SEARCH_BASE = "https://api.search.tinyfish.ai";
const FETCH_BASE = "https://api.fetch.tinyfish.ai";

interface TinyFishRawResult {
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	published_at?: string;
}

export interface TinyFishErrorItem {
	url?: string;
	error?: string;
	status?: number | string;
	message?: string;
}

export type TinyFishError = string | TinyFishErrorItem;

export function formatTinyFishErrors(errors: TinyFishError[]): string {
	return errors
		.map((err) => {
			if (typeof err === "string") return err;
			if (err && typeof err === "object") {
				const item = err as TinyFishErrorItem;
				const desc = item.error ?? item.message ?? JSON.stringify(item);
				const statusPart = item.status !== undefined ? ` (${item.status})` : "";
				return item.url ? `${item.url}: ${desc}${statusPart}` : `${desc}${statusPart}`;
			}
			return String(err);
		})
		.join("; ");
}

interface TinyFishSearchResponse {
	results?: TinyFishRawResult[];
	total_results?: number;
	errors?: TinyFishError[];
	error?: string;
}

interface TinyFishFetchResult {
	url?: string;
	title?: string;
	text?: string;
}

interface TinyFishFetchResponse {
	results?: TinyFishFetchResult[];
	errors?: TinyFishError[];
	error?: string;
}

function normalizeResults(raw: TinyFishRawResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippet ?? r.content ?? "",
		publishedAt: r.published_at,
	}));
}

export const tinyfishProvider: Provider = {
	name: "tinyfish",
	label: "TinyFish",
	envVar: "TINYFISH_API_KEY",
	searchHint: "High-speed AI web search engine with clean snippets.",
	fetchHint: "Direct web page markdown extractor.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		const searchUrl = `${SEARCH_BASE}?query=${encodeURIComponent(query)}&limit=${maxResults}`;
		const res = await ctx.request(searchUrl, {
			method: "GET",
			headers: {
				...(ctx.apiKey ? { "X-API-Key": ctx.apiKey } : {}),
			},
		});

		if (!res.ok) {
			throw new Error(`TinyFish search error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as TinyFishSearchResponse;
		if (data.errors?.length) {
			throw new Error(`TinyFish search error: ${formatTinyFishErrors(data.errors)}`);
		}
		if (data.error) {
			throw new Error(`TinyFish search error: ${data.error}`);
		}

		return { results: normalizeResults(data.results ?? []) };
	},

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		const res = await ctx.request(FETCH_BASE, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(ctx.apiKey ? { "X-API-Key": ctx.apiKey } : {}),
			},
			body: JSON.stringify({ urls: [url], format: "markdown" }),
		});

		if (!res.ok) {
			throw new Error(`TinyFish fetch error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const data = (await res.json()) as TinyFishFetchResponse;
		if (data.errors?.length) {
			throw new Error(`TinyFish fetch error: ${formatTinyFishErrors(data.errors)}`);
		}
		if (data.error) {
			throw new Error(`TinyFish fetch error: ${data.error}`);
		}

		const firstResult = data.results?.[0];
		const text = firstResult?.text;
		if (!text || typeof text !== "string" || text.trim().length === 0) {
			throw new Error(`TinyFish: no content for ${url}`);
		}

		return {
			text,
			title: firstResult.title,
			contentType: "text/markdown",
		};
	},
};

export default defineProvider(tinyfishProvider);
