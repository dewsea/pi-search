import {
	defineProvider,
	type Provider,
	type ProviderContext,
	type SearchResponse,
	type SearchResult,
} from "@hyav/pi-search";

const SEARCH_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search";

interface DoubaoError {
	Code?: string;
	CodeN?: number;
	Message?: string;
}

interface DoubaoWebResult {
	Title?: string;
	SiteName?: string;
	Url?: string;
	Snippet?: string;
	Summary?: string;
	Content?: string;
	PublishTime?: string;
	RankScore?: number;
	AuthInfoDes?: string;
}

interface DoubaoSearchResponse {
	ResponseMetadata?: {
		RequestId?: string;
		Error?: DoubaoError;
	};
	Result?: {
		ResultCount?: number;
		WebResults?: DoubaoWebResult[];
	};
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function isHttpUrl(value: string | undefined): value is string {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function normalizeResults(raw: DoubaoWebResult[], maxResults: number): SearchResult[] {
	return raw
		.filter((result) => isHttpUrl(result.Url))
		.slice(0, maxResults)
		.map((result) => {
			const metadata = [normalizeText(result.SiteName), normalizeText(result.AuthInfoDes)].filter(Boolean);
			const content = normalizeText(result.Summary || result.Snippet || result.Content);
			const snippet = metadata.length > 0 ? `${metadata.join(" · ")} — ${content}` : content;
			const score =
				typeof result.RankScore === "number" && Number.isFinite(result.RankScore) ? result.RankScore : undefined;

			return {
				title: normalizeText(result.Title) || normalizeText(result.SiteName) || result.Url!,
				url: result.Url!,
				snippet,
				publishedAt: result.PublishTime,
				score,
			};
		});
}

export const doubaoProvider: Provider = {
	name: "doubao",
	label: "Doubao Search",
	envVar: "DOUBAO_SEARCH_API_KEY",
	searchHint:
		"Volcengine Doubao Search is optimized for Chinese-language web search, current Chinese news, domestic websites, and ByteDance ecosystem sources.",

	async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
		if (!ctx.apiKey) throw new Error("Doubao Search requires an API key");

		const normalizedQuery = query.trim();
		if (!normalizedQuery) return { results: [] };

		const res = await ctx.request(SEARCH_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ctx.apiKey}`,
			},
			body: JSON.stringify({
				Query: normalizedQuery.slice(0, 100),
				SearchType: "web",
				Count: Math.min(Math.max(maxResults, 1), 20),
				NeedSummary: true,
				Filter: {
					NeedUrl: true,
				},
			}),
		});

		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 1_000);
			throw new Error(`Doubao Search HTTP ${res.status}: ${detail || res.statusText}`);
		}

		const data = (await res.json()) as DoubaoSearchResponse;
		const apiError = data.ResponseMetadata?.Error;
		if (apiError) {
			const code = apiError.Code ?? apiError.CodeN?.toString() ?? "unknown";
			throw new Error(`Doubao Search API ${code}: ${apiError.Message ?? "unknown error"}`);
		}

		return {
			results: normalizeResults(data.Result?.WebResults ?? [], maxResults),
		};
	},
};

export default defineProvider(doubaoProvider);
