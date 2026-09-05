import { defineProvider } from "../adapter-api.js";
import type { FetchResponse, Provider, ProviderContext } from "./types.js";

interface JinaJsonResponse {
	code?: number;
	status?: number;
	data?: {
		title?: string;
		content?: string;
		description?: string;
	};
}

export const jinaProvider: Provider = {
	name: "jina",
	label: "Jina",
	envVar: "JINA_API_KEY",
	keyless: true,
	fetchHint: "Fast reader converting web pages and PDF files into LLM-friendly Markdown.",

	async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (ctx.apiKey) {
			headers.Authorization = `Bearer ${ctx.apiKey}`;
		}
		const res = await ctx.request(`https://r.jina.ai/${url}`, { headers });
		if (!res.ok) {
			throw new Error(`Jina fetch error (${res.status}): ${await res.text().catch(() => "")}`);
		}

		const raw = await res.text();
		if (!raw.trim()) throw new Error(`Jina fetch: no content for ${url}`);

		// Try parsing structured JSON response
		try {
			const parsed = JSON.parse(raw) as JinaJsonResponse;
			if (parsed.data?.content) {
				return {
					text: parsed.data.content,
					title: parsed.data.title,
					contentType: "text/markdown",
				};
			}
		} catch {
			// Not JSON, fallback to plain markdown text
		}

		return { text: raw, contentType: "text/markdown" };
	},
};

export default defineProvider(jinaProvider);
