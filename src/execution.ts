// Shared execution helper for pi-search
// Bounded concurrency (3), input order preservation, partial failure aggregation, and timeout/cancellation.

import { type LimitedToolOutput, limitToolOutput } from "./output.js";
import type { FetchResponse, Provider, ProviderContext, SearchResult } from "./providers/types.js";
import { deduplicateResults, fetchWithTimeout } from "./utils.js";

export const MAX_CONCURRENCY = 3;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecutionOptions {
	apiKeys?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

export interface SearchExecutionItemSuccess {
	provider: string;
	status: "success";
	results: SearchResult[];
}

export interface ExecutionItemError {
	provider: string;
	status: "error";
	error: string;
}

export type SearchExecutionItem = SearchExecutionItemSuccess | ExecutionItemError;

export interface SearchExecutionResult {
	items: SearchExecutionItem[];
	limitedOutput: LimitedToolOutput;
}

export interface FetchExecutionItemSuccess {
	provider: string;
	status: "success";
	data: FetchResponse;
}

export type FetchExecutionItem = FetchExecutionItemSuccess | ExecutionItemError;

export interface FetchExecutionResult {
	items: FetchExecutionItem[];
	limitedOutput: LimitedToolOutput;
}

export function createProviderContext(
	provider: Provider,
	apiKey: string | undefined,
	callerSignal?: AbortSignal,
): { ctx: ProviderContext; cleanup: () => void } {
	const timeoutController = new AbortController();
	const timer = setTimeout(() => {
		timeoutController.abort(
			new Error(`Operation timed out after ${DEFAULT_TIMEOUT_MS}ms for provider "${provider.name}"`),
		);
	}, DEFAULT_TIMEOUT_MS);

	const combinedSignal = callerSignal
		? AbortSignal.any([callerSignal, timeoutController.signal])
		: timeoutController.signal;

	const request = async (url: string, options: RequestInit = {}): Promise<Response> => {
		const mergedSignal = options.signal ? AbortSignal.any([options.signal, combinedSignal]) : combinedSignal;

		return fetchWithTimeout(url, { ...options, signal: mergedSignal }, DEFAULT_TIMEOUT_MS);
	};

	const ctx: ProviderContext = {
		apiKey,
		signal: combinedSignal,
		request,
	};

	const cleanup = () => clearTimeout(timer);
	return { ctx, cleanup };
}

export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	signal?.throwIfAborted();

	const worker = async () => {
		while (nextIndex < items.length) {
			signal?.throwIfAborted();
			const index = nextIndex++;
			results[index] = await fn(items[index], index);
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	const settled = await Promise.allSettled(workers);
	const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
	if (rejected) {
		throw rejected.reason;
	}
	return results;
}

function formatSearchResultItem(index: number, result: SearchResult): string {
	const parts: string[] = [];
	const title = result.title.replace(/\s+/g, " ").trim() || result.url;
	parts.push(`${index + 1}. [${title}](${result.url})`);
	if (result.snippet?.trim()) {
		parts.push(`   ${result.snippet.trim()}`);
	}
	if (result.publishedAt) {
		parts.push(`   *Published: ${result.publishedAt}*`);
	}
	return parts.join("\n");
}

function formatSearchOutput(query: string, items: SearchExecutionItem[]): string {
	if (items.length === 1) {
		const item = items[0];
		if (item.status === "success") {
			const count = item.results.length;
			const header = `*${count} result${count === 1 ? "" : "s"} via ${item.provider}*\n\n`;
			if (count === 0) return `${header}No results found for "${query}".`;
			const body = item.results.map((r, i) => formatSearchResultItem(i, r)).join("\n\n");
			return header + body;
		}
	}

	// Multi-provider or single error
	const summaryLines: string[] = ["### Providers Overview:"];
	for (const item of items) {
		if (item.status === "success") {
			summaryLines.push(`- **${item.provider}**: ${item.results.length} result(s)`);
		} else {
			summaryLines.push(`- **${item.provider}**: Failed (${item.error})`);
		}
	}

	const sections: string[] = [summaryLines.join("\n")];
	for (const item of items) {
		if (item.status === "success") {
			sections.push(`## Results from ${item.provider} (${item.results.length})`);
			if (item.results.length === 0) {
				sections.push(`*No results found.*`);
			} else {
				sections.push(item.results.map((r, i) => formatSearchResultItem(i, r)).join("\n\n"));
			}
		}
	}

	return sections.join("\n\n");
}

function formatFetchOutput(url: string, items: FetchExecutionItem[]): string {
	if (items.length === 1) {
		const item = items[0];
		if (item.status === "success") {
			const headerLines: string[] = [`**URL:** ${url}`, `**Provider:** ${item.provider}`];
			if (item.data.title?.trim()) headerLines.push(`**Title:** ${item.data.title.trim()}`);
			if (item.data.contentType?.trim()) headerLines.push(`**Content-Type:** ${item.data.contentType.trim()}`);
			return `${headerLines.join("\n")}\n\n${item.data.text}`;
		}
	}

	const summaryLines: string[] = [`**URL:** ${url}`, "### Providers Overview:"];
	for (const item of items) {
		if (item.status === "success") {
			summaryLines.push(`- **${item.provider}**: Content extracted successfully`);
		} else {
			summaryLines.push(`- **${item.provider}**: Failed (${item.error})`);
		}
	}

	const sections: string[] = [summaryLines.join("\n")];
	for (const item of items) {
		if (item.status === "success") {
			const subHeaders = [`## Content from ${item.provider}`];
			if (item.data.title?.trim()) subHeaders.push(`**Title:** ${item.data.title.trim()}`);
			sections.push(`${subHeaders.join("\n")}\n\n${item.data.text}`);
		}
	}

	return sections.join("\n\n");
}

export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	// Prevent unhandled rejection on the underlying promise if signal aborts
	promise.catch(() => {});
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("Operation aborted"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("Operation aborted"));
		};
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(val) => {
				cleanup();
				resolve(val);
			},
			(err) => {
				cleanup();
				reject(err);
			},
		);
	});
}

export function sanitizeErrorMessage(raw: unknown, maxLength = 250): string {
	if (raw === null || raw === undefined) return "Unknown error";
	let msg = raw instanceof Error ? raw.message : String(raw);

	// Strip HTML tags if any returned by broken upstream servers
	msg = msg.replace(/<[^>]+>/g, " ");

	// Redact potential Bearer tokens or API keys
	msg = msg.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
	msg = msg.replace(/(?:(?:api[-_]?)?key|token|secret)[:=\s]+[A-Za-z0-9._~+/-]+/gi, "key=[REDACTED]");

	// Collapse whitespace
	msg = msg.replace(/\s+/g, " ").trim();

	if (msg.length > maxLength) {
		return `${msg.slice(0, maxLength)}... (truncated)`;
	}
	return msg || "Unknown error";
}

function normalizeProviderSearchResults(raw: unknown, maxResults: number): SearchResult[] {
	if (!raw || typeof raw !== "object") {
		throw new Error("Provider returned invalid non-object response");
	}
	const candidateObj = raw as { results?: unknown };
	if (!Array.isArray(candidateObj.results)) {
		throw new Error("Provider response missing results array");
	}
	const rawResults: SearchResult[] = [];
	for (const item of candidateObj.results) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const url = typeof r.url === "string" ? r.url.trim() : "";
		if (!url || !/^https?:\/\//i.test(url)) continue; // must be a valid HTTP(S) URL
		const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim() : "";
		const snippet = typeof r.snippet === "string" ? r.snippet.trim() : "";
		const score = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : undefined;
		const publishedAt = typeof r.publishedAt === "string" ? r.publishedAt.trim() : undefined;
		rawResults.push({
			url,
			title,
			snippet,
			...(score !== undefined ? { score } : {}),
			...(publishedAt ? { publishedAt } : {}),
		});
	}
	return deduplicateResults(rawResults).slice(0, maxResults);
}

function normalizeProviderFetchResult(raw: unknown): FetchResponse {
	if (!raw || typeof raw !== "object") {
		throw new Error("Provider returned invalid non-object response");
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.text !== "string" || r.text.trim().length === 0) {
		throw new Error("Provider returned empty or invalid text");
	}
	return {
		text: r.text,
		title: typeof r.title === "string" && r.title.trim().length > 0 ? r.title.trim() : undefined,
		contentType:
			typeof r.contentType === "string" && r.contentType.trim().length > 0 ? r.contentType.trim() : undefined,
	};
}

export async function executeSearch(
	providers: Provider[],
	query: string,
	maxResults: number,
	options: ExecutionOptions = {},
): Promise<SearchExecutionResult> {
	options.signal?.throwIfAborted();

	const items = await mapWithConcurrency<Provider, SearchExecutionItem>(
		providers,
		MAX_CONCURRENCY,
		async (provider) => {
			if (!provider.search || typeof provider.search !== "function") {
				return {
					provider: provider.name,
					status: "error",
					error: `Provider "${provider.name}" does not implement search()`,
				};
			}

			const apiKey = options.apiKeys?.[provider.name];
			const { ctx, cleanup } = createProviderContext(provider, apiKey, options.signal);
			try {
				const searchPromise = Promise.resolve(provider.search(query, maxResults, ctx));
				const rawRes = await raceWithSignal(searchPromise, ctx.signal);
				options.signal?.throwIfAborted();
				const normalizedResults = normalizeProviderSearchResults(rawRes, maxResults);
				return {
					provider: provider.name,
					status: "success",
					results: normalizedResults,
				};
			} catch (err) {
				if (options.signal?.aborted) {
					throw options.signal.reason instanceof Error
						? options.signal.reason
						: new Error("Search aborted by caller");
				}
				return {
					provider: provider.name,
					status: "error",
					error: sanitizeErrorMessage(err),
				};
			} finally {
				cleanup();
			}
		},
		options.signal,
	);

	options.signal?.throwIfAborted();

	const successes = items.filter((i) => i.status === "success");
	if (successes.length === 0) {
		const errorMsgs = items
			.map((i) => (i.status === "error" ? `${i.provider}: ${i.error}` : ""))
			.filter(Boolean)
			.join("; ");
		const bounded = errorMsgs.length > 800 ? `${errorMsgs.slice(0, 800)}...` : errorMsgs;
		throw new Error(`All providers failed: ${bounded}`);
	}

	const formattedText = formatSearchOutput(query, items);
	const limitedOutput = await limitToolOutput(formattedText, options.signal);

	return {
		items,
		limitedOutput,
	};
}

export async function executeFetch(
	providers: Provider[],
	url: string,
	options: ExecutionOptions = {},
): Promise<FetchExecutionResult> {
	options.signal?.throwIfAborted();

	const items = await mapWithConcurrency<Provider, FetchExecutionItem>(
		providers,
		MAX_CONCURRENCY,
		async (provider) => {
			if (!provider.fetch || typeof provider.fetch !== "function") {
				return {
					provider: provider.name,
					status: "error",
					error: `Provider "${provider.name}" does not implement fetch()`,
				};
			}

			const apiKey = options.apiKeys?.[provider.name];
			const { ctx, cleanup } = createProviderContext(provider, apiKey, options.signal);
			try {
				const fetchPromise = Promise.resolve(provider.fetch(url, ctx));
				const rawRes = await raceWithSignal(fetchPromise, ctx.signal);
				options.signal?.throwIfAborted();
				const normalizedData = normalizeProviderFetchResult(rawRes);
				return {
					provider: provider.name,
					status: "success",
					data: normalizedData,
				};
			} catch (err) {
				if (options.signal?.aborted) {
					throw options.signal.reason instanceof Error
						? options.signal.reason
						: new Error("Fetch aborted by caller");
				}
				return {
					provider: provider.name,
					status: "error",
					error: sanitizeErrorMessage(err),
				};
			} finally {
				cleanup();
			}
		},
		options.signal,
	);

	options.signal?.throwIfAborted();

	const successes = items.filter((i) => i.status === "success");
	if (successes.length === 0) {
		const errorMsgs = items
			.map((i) => (i.status === "error" ? `${i.provider}: ${i.error}` : ""))
			.filter(Boolean)
			.join("; ");
		const bounded = errorMsgs.length > 800 ? `${errorMsgs.slice(0, 800)}...` : errorMsgs;
		throw new Error(`All providers failed: ${bounded}`);
	}

	const formattedText = formatFetchOutput(url, items);
	const limitedOutput = await limitToolOutput(formattedText, options.signal);

	return {
		items,
		limitedOutput,
	};
}
