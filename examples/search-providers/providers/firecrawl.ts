import { defineProvider, type FetchResponse, type Provider, type ProviderMeta } from "@hyav/pi-search";

function withTimeout(signal: AbortSignal | undefined, timeoutMs = 30_000): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// Firecrawl REST API client — fetch only (full headless Chromium)
//
// Endpoint:
//   POST https://api.firecrawl.dev/v1/scrape  — content extraction

const BASE = "https://api.firecrawl.dev";

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: {
		markdown?: string;
		title?: string;
	};
}

export const FIRECRAWL_META = {
	name: "firecrawl",
	label: "Firecrawl",
	envVar: "FIRECRAWL_API_KEY",
	capabilities: {
		generalSearch: false,
		verticalSearch: false,
		contentExtraction: true,
		crawl: false,
		siteMap: false,
		deepResearch: false,
		batchSearch: false,
		hasMetadata: false,
	},
	// No searchHint — fetch-only provider
	fetchHint:
		"Headless browser scraper powered by Playwright. Performs full client-side JavaScript rendering and is capable of bypassing Cloudflare blocks. Suitable for Single Page Applications (SPAs) and highly dynamic websites at the cost of higher latency.",
	// No verticals
	// No searchFallbackPriority — excluded from search chain
	fetchFallbackPriority: 30,
} as const satisfies ProviderMeta;

export class FirecrawlProvider implements Provider {
	readonly name = FIRECRAWL_META.name;
	readonly label = FIRECRAWL_META.label;
	readonly capabilities = FIRECRAWL_META.capabilities;

	constructor(private readonly apiKey: string) {}

	async fetch(url: string, signal?: AbortSignal): Promise<FetchResponse> {
		const res = await fetch(`${BASE}/v1/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ url, formats: ["markdown"] }),
			signal: withTimeout(signal, 60_000),
		});
		if (!res.ok) {
			throw new Error(`Firecrawl error (${res.status}): ${await res.text().catch(() => "")}`);
		}
		const data = (await res.json()) as FirecrawlScrapeResponse;
		if (!data.data?.markdown) throw new Error(`Firecrawl: no content for ${url}`);
		return { text: data.data.markdown, title: data.data.title, contentType: "text/markdown" };
	}
}

export default defineProvider({
	...FIRECRAWL_META,
	apiKeyRequired: true,
	create: ({ apiKey }) => {
		if (!apiKey) throw new Error("Firecrawl requires an API key");
		return new FirecrawlProvider(apiKey);
	},
});
