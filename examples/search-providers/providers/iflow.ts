import {
	defineProvider,
	type FetchResponse,
	type Provider,
	type ProviderContext,
	type SearchResponse,
	type SearchResult,
} from "@hyav/pi-search";

const BASE = "https://platform.iflow.cn";

interface IflowRawResult {
	title?: string;
	link?: string;
	snippet?: string;
	date?: string;
}

interface IflowSearchResponse {
	success: boolean;
	code?: string;
	message?: string;
	data?: {
		organic?: IflowRawResult[];
	};
}

interface IflowFetchResponse {
	success: boolean;
	code?: string;
	message?: string;
	data?: {
		title?: string;
		content?: string;
		url?: string;
	};
}

function authHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
}

function normalizeResults(raw: IflowRawResult[]): SearchResult[] {
	return raw.map((r) => ({
		title: r.title ?? "",
		url: r.link ?? "",
		snippet: r.snippet ?? "",
		publishedAt: r.date,
	}));
}

export const iflowProvider: Provider = {
	name: "iflow",
	label: "iFlow",
	envVar: "IFLOW_API_KEY",
	searchHint: "Specialized in Chinese local queries, domestic news, and localized content indexing.",
	fetchHint: "Specially optimized for Chinese websites. Intelligently strips commercial promotions and domestic ads.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		if (!ctx.apiKey) throw new Error("iFlow requires an API key");

		const res = await ctx.request(`${BASE}/api/search/webSearch`, {
			method: "POST",
			headers: authHeaders(ctx.apiKey),
			body: JSON.stringify({ keywords: query, num: maxResults }),
		});

		if (!res.ok) {
			throw new Error(`iFlow search error (${res.status}): ${await res.text()}`);
		}

		const data = (await res.json()) as IflowSearchResponse;
		if (!data.success) {
			throw new Error(`iFlow search failed: ${data.message ?? "unknown error"}`);
		}

		return { results: normalizeResults(data.data?.organic ?? []) };
	},

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		if (!ctx.apiKey) throw new Error("iFlow requires an API key");

		const res = await ctx.request(`${BASE}/api/search/webFetch`, {
			method: "POST",
			headers: authHeaders(ctx.apiKey),
			body: JSON.stringify({ url }),
		});

		if (!res.ok) {
			throw new Error(`iFlow fetch error (${res.status}): ${await res.text()}`);
		}

		const data = (await res.json()) as IflowFetchResponse;
		if (!data.success) {
			throw new Error(`iFlow fetch failed for ${url}: ${data.message ?? "unknown error"}`);
		}

		const content = data.data?.content;
		if (content === undefined || content === null) {
			throw new Error(`iFlow fetch: no content returned for ${url}`);
		}

		return {
			text: content,
			title: data.data?.title,
			contentType: "text/markdown",
		};
	},
};

export default defineProvider(iflowProvider);
