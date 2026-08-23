import {
	defineProvider,
	type FetchResponse,
	type Provider,
	type ProviderMeta,
	type SearchResponse,
	type SearchResult,
} from "@hyav/pi-search";

function withTimeout(signal: AbortSignal | undefined, timeoutMs = 30_000): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// iFlow REST API client
//
// Endpoints:
//   POST https://platform.iflow.cn/api/search/webSearch  — web search
//   POST https://platform.iflow.cn/api/search/webFetch   — content extraction
//
// Documentation: https://platform.iflow.cn

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

export const IFLOW_META = {
	name: "iflow",
	label: "iFlow",
	envVar: "IFLOW_API_KEY",
	capabilities: {
		generalSearch: true,
		verticalSearch: false,
		contentExtraction: true,
		crawl: false,
		siteMap: false,
		deepResearch: false,
		batchSearch: false,
		hasMetadata: false,
	},
	searchHint:
		"Specialized in Chinese local queries, domestic news, and localized content indexing. Snippets are highly condensed and filtered for Chinese LLM input.",
	fetchHint:
		"Specially optimized for Chinese websites. Intelligently strips commercial promotions, domestic ads, and irrelevant structural boilerplate typical of Chinese portals.",
	searchFallbackPriority: 28,
	fetchFallbackPriority: 35,
} as const satisfies ProviderMeta;

export class IflowProvider implements Provider {
	readonly name = IFLOW_META.name;
	readonly label = IFLOW_META.label;
	readonly capabilities = IFLOW_META.capabilities;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		const res = await fetch(`${BASE}/api/search/webSearch`, {
			method: "POST",
			headers: authHeaders(this.apiKey),
			body: JSON.stringify({ keywords: query, num: maxResults }),
			signal: withTimeout(signal),
		});

		if (!res.ok) {
			throw new Error(`iFlow search error (${res.status}): ${await res.text()}`);
		}

		const data = (await res.json()) as IflowSearchResponse;
		if (!data.success) {
			throw new Error(`iFlow search failed: ${data.message ?? "unknown error"}`);
		}

		return { results: normalizeResults(data.data?.organic ?? []) };
	}

	async fetch(url: string, signal?: AbortSignal): Promise<FetchResponse> {
		const res = await fetch(`${BASE}/api/search/webFetch`, {
			method: "POST",
			headers: authHeaders(this.apiKey),
			body: JSON.stringify({ url }),
			signal: withTimeout(signal),
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
	}
}

export default defineProvider({
	...IFLOW_META,
	apiKeyRequired: true,
	create: ({ apiKey }) => {
		if (!apiKey) throw new Error("iFlow requires an API key");
		return new IflowProvider(apiKey);
	},
});
