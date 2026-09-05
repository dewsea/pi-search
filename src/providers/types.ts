// Provider interface — unified Provider contract for search + fetch

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
	score?: number;
}

export interface SearchResponse {
	results: SearchResult[];
}

export interface FetchResponse {
	text: string;
	title?: string;
	contentType?: string;
}

export interface ProviderContext {
	apiKey?: string;
	signal: AbortSignal;
	request(url: string, options?: RequestInit): Promise<Response>;
}

export interface Provider {
	name: string;
	label: string;
	envVar: string;
	keyless?: boolean;
	searchHint?: string;
	fetchHint?: string;
	search?(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse>;
	fetch?(url: string, ctx: ProviderContext): Promise<FetchResponse>;
}

export type ProviderAdapter = Provider;
