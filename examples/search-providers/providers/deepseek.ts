import {
	defineProvider,
	type Provider,
	type ProviderContext,
	type SearchResponse,
	type SearchResult,
} from "@hyav/pi-search";

export const deepseekProvider: Provider = {
	name: "deepseek",
	label: "DeepSeek",
	envVar: "DEEPSEEK_API_KEY",
	searchHint: "Utilizes DeepSeek's native server-side search tool for retrieving real-time web results.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		if (!ctx.apiKey) {
			throw new Error("DeepSeek requires an API key");
		}
		const apiEndpoint = "https://api.deepseek.com/anthropic/v1/messages";
		const model = process.env.DEEPSEEK_SEARCH_MODEL || "deepseek-v4-flash";
		const body = {
			model,
			max_tokens: 4096,
			messages: [{ role: "user", content: query }],
			system: "You are an assistant for performing a web search tool use. Do not output tool call syntax.",
			stream: true,
			tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
		};

		const res = await ctx.request(apiEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": ctx.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			let detail = res.statusText;
			try {
				const err = (await res.json()) as { error?: { message?: string } };
				detail = err.error?.message || detail;
			} catch {}
			throw new Error(`DeepSeek API ${res.status}: ${detail}`);
		}

		if (!res.body) throw new Error("No response body from DeepSeek API");

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
				} catch {}
			}
		}

		return { results: results.slice(0, maxResults) };
	},
};

export default defineProvider(deepseekProvider);
