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

// Exa REST API client
//
// Endpoints:
//   POST https://api.exa.ai/search    — web search
//   POST https://api.exa.ai/contents  — content extraction

const BASE = "https://api.exa.ai";
const MAX_SNIPPET_CHARS = 300;
const MAX_FETCH_CHARS = 50000;

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

export const EXA_META = {
	name: "exa",
	label: "Exa",
	envVar: "EXA_API_KEY",
	capabilities: {
		generalSearch: true,
		verticalSearch: false,
		contentExtraction: true,
		crawl: false,
		siteMap: false,
		deepResearch: false,
		batchSearch: false,
		hasMetadata: true,
	},
	searchHint:
		"Uses neural/semantic embeddings to find pages based on meaning rather than exact keywords. Strongest for academic papers (via title or DOI), high-quality research blogs, and finding similar websites.",
	fetchHint:
		"Leverages semantic-aware Livecrawl. Focuses on extracting semantically readable blocks from complex layouts, making it highly readable for LLM context.",
	searchFallbackPriority: 20,
	fetchFallbackPriority: 20,
} as const satisfies ProviderMeta;

export class ExaProvider implements Provider {
	readonly name = EXA_META.name;
	readonly label = EXA_META.label;
	readonly capabilities = EXA_META.capabilities;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		const res = await fetch(`${BASE}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
			},
			body: JSON.stringify({
				query,
				numResults: maxResults,
				contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
			}),
			signal: withTimeout(signal),
		});
		if (!res.ok) {
			throw new Error(`Exa search error (${res.status}): ${await res.text()}`);
		}
		const data = (await res.json()) as { results?: ExaRawResult[] };
		return { results: normalizeResults(data.results ?? []) };
	}

	async fetch(url: string, signal?: AbortSignal): Promise<FetchResponse> {
		const res = await fetch(`${BASE}/contents`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
			},
			body: JSON.stringify({
				ids: [url],
				text: { maxCharacters: MAX_FETCH_CHARS },
			}),
			signal: withTimeout(signal),
		});
		if (!res.ok) {
			throw new Error(`Exa fetch error (${res.status}): ${await res.text()}`);
		}
		const data = (await res.json()) as { results?: ExaRawResult[] };
		const r = data.results?.[0];
		if (!r?.text) throw new Error(`Exa fetch: no content for ${url}`);
		return { text: r.text, title: r.title, contentType: "text/plain" };
	}
}

export default defineProvider({
	...EXA_META,
	apiKeyRequired: true,
	create: ({ apiKey }) => {
		if (!apiKey) throw new Error("Exa requires an API key");
		return new ExaProvider(apiKey);
	},
});
