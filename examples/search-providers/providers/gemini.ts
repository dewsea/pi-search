import {
	defineProvider,
	type Provider,
	type ProviderContext,
	type SearchResponse,
	type SearchResult,
} from "@hyav/pi-search";

export const geminiProvider: Provider = {
	name: "gemini",
	label: "Gemini",
	envVar: "GEMINI_API_KEY",
	searchHint:
		"Powered by Google's official Search Grounding. Delivers authoritative, real-time facts directly from Google's search index.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		if (!ctx.apiKey) {
			throw new Error("Gemini requires an API key");
		}
		const model = process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash";
		const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ctx.apiKey}`;

		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await ctx.request(apiEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			throw new Error(`Gemini search API error (${res.status}): ${await res.text()}`);
		}

		const data = (await res.json()) as any;
		const candidate = data.candidates?.[0];
		const chunks = candidate?.groundingMetadata?.groundingChunks || [];

		const results: SearchResult[] = chunks.map((chunk: any) => ({
			title: chunk.web?.title || "",
			url: chunk.web?.uri || "",
			snippet: "",
		}));

		return { results: results.slice(0, maxResults) };
	},
};

export default defineProvider(geminiProvider);
