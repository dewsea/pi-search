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

export const DEEPSEEK_META = {
	name: "deepseek",
	label: "DeepSeek",
	envVar: "DEEPSEEK_API_KEY",
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
		"Utilizes DeepSeek's native server-side search tool. Useful for retrieving real-time web results directly through the DeepSeek API endpoint.",
	searchFallbackPriority: 40,
} as const satisfies ProviderMeta;

export class DeepseekProvider implements Provider {
	readonly name = DEEPSEEK_META.name;
	readonly label = DEEPSEEK_META.label;
	readonly capabilities = DEEPSEEK_META.capabilities;

	constructor(private readonly apiKey: string) {
		if (!apiKey) {
			throw new Error("DeepSeek requires an API key");
		}
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		const apiEndpoint = "https://api.deepseek.com/anthropic/v1/messages";

		const model = process.env.DEEPSEEK_SEARCH_MODEL || "deepseek-v4-flash";
		const body = {
			model,
			max_tokens: 4096,
			messages: [{ role: "user", content: query }],
			system: "You are an assistant for performing a web search tool use. Do not output tool call syntax.",
			stream: true,
			tools: [
				{
					type: "web_search_20260209",
					name: "web_search",
					max_uses: 8,
				},
			],
		};

		const res = await fetch(apiEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
			signal: withTimeout(signal, 60_000),
		});

		if (!res.ok) {
			let detail = res.statusText;
			try {
				const err = (await res.json()) as { error?: { message?: string } };
				detail = err.error?.message || detail;
			} catch {}
			throw new Error(`DeepSeek API ${res.status}: ${detail}`);
		}

		if (!res.body) {
			throw new Error("No response body from DeepSeek API");
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const results: SearchResult[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data: ")) continue;
				const data = trimmed.slice(6);
				if (data === "[DONE]") continue;

				try {
					const event = JSON.parse(data);
					if (event.type === "content_block_start") {
						const block = event.content_block;
						if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
							for (const entry of block.content) {
								if (entry.type === "web_search_result") {
									results.push({
										title: entry.title || "Untitled",
										url: entry.url || "",
										snippet: entry.page_age ? `Page age: ${entry.page_age}` : "",
									});
								}
							}
						}
					}
				} catch {
					// Ignore incomplete lines
				}
			}
		}

		return { results: results.slice(0, maxResults) };
	}
}

export default defineProvider({
	...DEEPSEEK_META,
	apiKeyRequired: true,
	create: ({ apiKey }) => {
		if (!apiKey) throw new Error("DeepSeek requires an API key");
		return new DeepseekProvider(apiKey);
	},
});
