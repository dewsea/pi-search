import {
	defineProvider,
	type Provider,
	type ProviderMeta,
	type SearchResponse,
	type SearchResult,
} from "@hyav/pi-search";

function withTimeout(signal: AbortSignal | undefined, timeoutMs = 30_000): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// Serper REST API client (Google Search API)
//
// Endpoint:
//   POST https://google.serper.dev/search
//
// Documentation: https://serper.dev

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

export const SERPER_META = {
	name: "serper",
	label: "Serper",
	envVar: "SERPER_API_KEY",
	capabilities: {
		generalSearch: true,
		verticalSearch: false,
		contentExtraction: false,
		crawl: false,
		siteMap: false,
		deepResearch: false,
		batchSearch: false,
		hasMetadata: false,
	},
	searchHint:
		"Direct organic Google Search API wrapper. Returns raw Google snippets, search results, and news lookups with minimal latency.",
	searchFallbackPriority: 25,
} as const satisfies ProviderMeta;

export class SerperProvider implements Provider {
	readonly name = SERPER_META.name;
	readonly label = SERPER_META.label;
	readonly capabilities = SERPER_META.capabilities;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		const res = await fetch(`${BASE}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": this.apiKey,
			},
			body: JSON.stringify({ q: query, num: maxResults }),
			signal: withTimeout(signal),
		});

		if (!res.ok) {
			throw new Error(`Serper search error (${res.status}): ${await res.text()}`);
		}

		const data = (await res.json()) as { organic?: SerperRawResult[] };
		return { results: normalizeResults(data.organic ?? []) };
	}
}

export default defineProvider({
	...SERPER_META,
	apiKeyRequired: true,
	create: ({ apiKey }) => {
		if (!apiKey) throw new Error("Serper requires an API key");
		return new SerperProvider(apiKey);
	},
});
