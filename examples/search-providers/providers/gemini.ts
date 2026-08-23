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

export const GEMINI_META = {
	name: "gemini",
	label: "Gemini",
	envVar: "GEMINI_API_KEY",
	capabilities: {
		generalSearch: true,
		verticalSearch: false,
		contentExtraction: false,
		crawl: false,
		siteMap: false,
		deepResearch: false,
		batchSearch: false,
		hasMetadata: true,
	},
	searchHint:
		"Powered by Google's official Search Grounding. Delivers authoritative, real-time localized queries, and highly reliable facts directly from Google's comprehensive search index.",
	searchFallbackPriority: 30,
} as const satisfies ProviderMeta;

async function resolveRedirect(url: string, signal?: AbortSignal): Promise<string | null> {
	let redirectUrl: URL;
	try {
		redirectUrl = new URL(url);
	} catch {
		return null;
	}

	// Only contact Google's known grounding redirect host. The redirect target
	// is returned as metadata and is not fetched here.
	if (redirectUrl.protocol !== "https:" || redirectUrl.hostname !== "vertexaisearch.cloud.google.com") {
		return null;
	}

	try {
		const res = await fetch(redirectUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: withTimeout(signal, 2_000),
		});
		const location = res.headers.get("location");
		if (!location) return null;

		const target = new URL(location, redirectUrl);
		if (
			(target.protocol !== "http:" && target.protocol !== "https:") ||
			target.username ||
			target.password ||
			!target.hostname
		) {
			return null;
		}
		return target.href;
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

export class GeminiProvider implements Provider {
	readonly name = GEMINI_META.name;
	readonly label = GEMINI_META.label;
	readonly capabilities = GEMINI_META.capabilities;

	constructor(private readonly apiKey: string) {
		if (!apiKey) {
			throw new Error("Gemini requires an API key");
		}
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		signal?.throwIfAborted();
		// Model deprecation timeline (https://ai.google.dev/gemini-api/docs/deprecations):
		// - gemini-2.5-flash shuts down on 2026-10-16 (official replacement: gemini-3.6-flash).
		// - Free tier: only the Gemini 2.5 family includes Google Search grounding (500 RPD);
		//   Gemini 3 models have NO search grounding quota on the free tier (requests with the
		//   google_search tool fail with 429), grounding is paid-tier only (5,000 prompts/month
		//   free, then $14 / 1,000 queries).
		// Keep gemini-2.5-flash as default while it is the only free-tier model with grounding.
		// To migrate (paid tier or after shutdown), set GEMINI_SEARCH_MODEL=gemini-3.6-flash;
		// cheaper options: gemini-3.5-flash-lite / gemini-3.1-flash-lite.
		const model = process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash";
		const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(apiEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: withTimeout(signal),
		});

		if (!res.ok) {
			throw new Error(`Gemini search API error (${res.status}): ${await res.text()}`);
		}

		const data = (await res.json()) as any;
		signal?.throwIfAborted();
		const candidate = data.candidates?.[0];
		const chunks = candidate?.groundingMetadata?.groundingChunks || [];

		const results: SearchResult[] = await Promise.all(
			chunks.map(async (chunk: any) => {
				const title = chunk.web?.title || "";
				let url = chunk.web?.uri || "";

				if (url?.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
					try {
						const resolved = await resolveRedirect(url, signal);
						if (resolved) {
							url = resolved;
						}
					} catch {
						signal?.throwIfAborted();
						// Timeout or error: gracefully fallback to the original Google redirect URL
					}
				}

				return {
					title,
					url,
					snippet: "",
				};
			}),
		);
		signal?.throwIfAborted();

		return { results: results.slice(0, maxResults) };
	}
}

export default defineProvider({
	...GEMINI_META,
	apiKeyRequired: true,
	create: ({ apiKey }) => {
		if (!apiKey) throw new Error("Gemini requires an API key");
		return new GeminiProvider(apiKey);
	},
});
