// web_search tool — LLM-driven search with dynamic provider routing
//
// Supports single query (query) and parallel multi-query (queries) modes.
// Each query independently goes through: LLM-specified provider or dynamic
// fallback chain → optional vertical search → optional deep research.

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { StringEnum } from "./adapter-api.js";
import { loadConfig, resolveApiKey, type SearchConfig } from "./config.js";
import { limitToolOutput } from "./output.js";
import {
	allVerticals,
	buildSearchChain,
	createAvailableProviders,
	PROVIDERS,
	searchPromptGuidelines,
	searchProviderNames,
} from "./providers/index.js";
import type { Provider, SearchResponse, SearchResult } from "./providers/types.js";
import { deduplicateResults, SafeMemoryCache } from "./utils.js";

export type SearchCacheEntry =
	| { results: SearchResult[]; provider: string }
	| { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

// Global search cache instance: TTL 5 minutes, capacity 100 entries
export const searchCache = new SafeMemoryCache<SearchCacheEntry>(300000, 100);

const MIN_RESULTS = 1;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
const RESEARCH_PROVIDER = "tavily";

export function resolveMaxResults(requestedMaxResults: number | undefined, config: SearchConfig): number {
	const candidate = requestedMaxResults ?? config.defaults?.max_results ?? DEFAULT_RESULTS;
	if (typeof candidate !== "number" || !Number.isFinite(candidate)) return DEFAULT_RESULTS;
	return Math.min(Math.max(Math.trunc(candidate), MIN_RESULTS), MAX_RESULTS);
}

function formatSearchResults(results: SearchResult[], provider: string): string {
	let out = `*${results.length} results via ${provider}*\n\n`;
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		out += `${i + 1}. **${r.title}**\n`;
		out += `   ${r.url}\n`;
		const meta: string[] = [];
		if (r.publishedAt) meta.push(r.publishedAt.slice(0, 10));
		if (r.score !== undefined) meta.push(`score: ${r.score.toFixed(2)}`);
		if (meta.length > 0) out += `   *${meta.join(" · ")}*\n`;
		const snippet = r.snippet.slice(0, 300);
		if (snippet.trim().length > 0) {
			const suffix =
				r.snippet.length > 300
					? `... (truncated, ${r.snippet.length} chars total — use web_fetch on this URL for full content)`
					: "";
			out += `   ${snippet}${suffix}\n`;
		}
		out += "\n";
	}

	if (results.length > 0) {
		out += `\nnext_steps[1]:\n  Call web_fetch with { url: "${results[0].url}" } to inspect the most relevant source.`;
	} else {
		out += "No matching results were returned.";
	}
	return out.trimEnd();
}

function formatMultiQueryResults(
	allQueries: Array<{ query: string; results: SearchResult[]; provider: string; error?: string }>,
): string {
	let out = "";
	for (const q of allQueries) {
		out += `## "${q.query}"\n`;
		if (q.error) {
			out += `error: ${q.error}`;
		} else {
			out += formatSearchResults(q.results, q.provider);
		}
		out += "\n---\n\n";
	}
	return out.trimEnd();
}

function formatResearchResults(query: string, answer: string, results: SearchResult[], provider: string): string {
	let out = `## Research: "${query}"\n\n${answer}\n\n---\n\n### Supporting Sources\n\n`;
	out += formatSearchResults(results.slice(0, 5), provider);
	return out;
}

function parseVertical(vertical: string): { domain: string; subDomain: string } {
	const dotIdx = vertical.indexOf(".");
	if (dotIdx === -1) return { domain: vertical, subDomain: vertical };
	return { domain: vertical.slice(0, dotIdx), subDomain: vertical };
}

export interface SearchExecuteOpts {
	provider?: string;
	vertical?: string;
}

export function assertResearchAvailable(
	apiKeys: Record<string, string | undefined>,
	providers: Map<string, Provider>,
): void {
	if (!apiKeys[RESEARCH_PROVIDER]) {
		throw new Error("'research=true' requires a Tavily API key (TAVILY_API_KEY or config.json).");
	}
	if (!providers.get(RESEARCH_PROVIDER)?.research) {
		throw new Error("'research=true' requires an available Tavily provider.");
	}
}

export async function executeSearch(
	providers: Map<string, Provider>,
	query: string,
	maxResults: number,
	opts: SearchExecuteOpts,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; provider: string }> {
	signal?.throwIfAborted();
	const cacheKey = JSON.stringify({
		query,
		maxResults,
		provider: opts.provider,
		vertical: opts.vertical,
	});
	const cached = searchCache.get(cacheKey);
	if (cached && "results" in cached) {
		return cached;
	}

	const errors: string[] = [];

	// Build try chain. An explicit provider is a scope, not a hint: fail loud
	// when it is unavailable instead of silently changing the requested service.
	let chain: string[];
	if (opts.provider) {
		const p = providers.get(opts.provider);
		if (!p || !p.capabilities?.generalSearch || typeof p.search !== "function") {
			throw new Error(
				`Requested provider "${opts.provider}" is not available or does not support search. Configure its API key or omit provider.`,
			);
		}
		chain = [opts.provider];
	} else {
		chain = buildSearchChain().filter((name) => {
			const p = providers.get(name);
			return Boolean(p?.capabilities?.generalSearch && typeof p.search === "function");
		});
	}

	if (chain.length === 0) {
		throw new Error(
			"No search providers available. Please configure API keys or add custom provider adapters to <agent-dir>/extensions/pi-search/providers/.",
		);
	}

	let lastEmptyProvider: string | undefined;
	for (const name of chain) {
		signal?.throwIfAborted();
		const p = providers.get(name);
		if (!p?.capabilities.generalSearch || !p.search) continue;

		try {
			// Check if vertical applies
			const meta = PROVIDERS.find((m) => m.name === name);
			const verticalApplies =
				meta?.capabilities.verticalSearch &&
				opts.vertical &&
				p.verticalSearch &&
				meta.verticals?.includes(opts.vertical);

			let resp: SearchResponse;
			if (verticalApplies) {
				const { domain, subDomain } = parseVertical(opts.vertical!);
				resp = await p.verticalSearch!(domain, subDomain, query, maxResults, signal);
			} else {
				resp = await p.search!(query, maxResults, signal);
			}
			signal?.throwIfAborted();

			if (resp.results.length > 0) {
				const finalResult = { results: deduplicateResults(resp.results), provider: name };
				searchCache.set(cacheKey, finalResult);
				return finalResult;
			}
			lastEmptyProvider = name;
			// Empty results — continue to next provider before returning a definitive zero.
		} catch (err) {
			signal?.throwIfAborted();
			errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// If LLM specified a provider, stop here (don't fall back)
		if (opts.provider) break;
	}

	if (lastEmptyProvider) {
		if (errors.length === 0) {
			const finalResult = { results: [] as SearchResult[], provider: lastEmptyProvider };
			searchCache.set(cacheKey, finalResult);
			return finalResult;
		}
		throw new Error(`Search was inconclusive for "${query}":\n${errors.join("\n")}`);
	}

	throw new Error(`All providers failed for "${query}":\n${errors.join("\n")}`);
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
	const providerNames = searchProviderNames();
	const configuredDefaultMaxResults = resolveMaxResults(undefined, loadConfig());
	const parameters = Type.Object({
		query: Type.Optional(
			Type.String({ description: "Single search query. Use 'queries' for multi-angle research." }),
		),
		queries: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Multiple queries searched in parallel, each routed independently. Prefer 2-4 varied angles. Good: ['React vs Vue performance', 'React vs Vue DX', 'React vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison'] (too similar).",
				maxItems: 4,
			}),
		),
		provider: Type.Optional(
			StringEnum(providerNames, {
				description: `Search provider. Omit to use the cost-priority fallback chain (${buildSearchChain().join(" → ")}).`,
			}),
		),
		vertical: Type.Optional(
			StringEnum(allVerticals(), {
				description: "Structured search vertical. Select a vertical-capable provider as well.",
			}),
		),
		max_results: Type.Optional(
			Type.Integer({
				description: `Results per query (${MIN_RESULTS}-${MAX_RESULTS}, default ${configuredDefaultMaxResults}).`,
				minimum: MIN_RESULTS,
				maximum: MAX_RESULTS,
				default: configuredDefaultMaxResults,
			}),
		),
		research: Type.Optional(
			Type.Boolean({
				description:
					"Generate a Tavily research report with Tavily search sources for exactly one query. Requires Tavily; cannot be combined with another explicit provider or vertical search.",
				default: false,
			}),
		),
	});
	type SearchToolParameters = Static<typeof parameters>;

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web with LLM-driven provider selection. Follow the provider and vertical guidance, or omit provider to use the cost-priority fallback chain. Use research for comprehensive multi-source reports and queries (plural) for parallel multi-angle research. Tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the full-output path is returned when truncated.`,
		promptSnippet: "Search the web with provider and vertical routing; follow the web_search provider guidance.",
		get promptGuidelines() {
			return searchPromptGuidelines();
		},
		parameters,
		prepareArguments(args): SearchToolParameters {
			// Pi validates the returned object; these casts only bridge the migration hook's unknown input.
			if (typeof args !== "object" || args === null) return args as SearchToolParameters;
			const input = args as Record<string, unknown>;
			const legacyMaxResults = input.max_results;
			if (
				typeof legacyMaxResults === "number" &&
				Number.isFinite(legacyMaxResults) &&
				!Number.isInteger(legacyMaxResults) &&
				legacyMaxResults >= MIN_RESULTS &&
				legacyMaxResults <= MAX_RESULTS
			) {
				return { ...input, max_results: Math.trunc(legacyMaxResults) } as SearchToolParameters;
			}
			return input as SearchToolParameters;
		},

		async execute(_toolCallId, params, signal, onUpdate) {
			signal?.throwIfAborted();
			const config = loadConfig();
			const maxResults = resolveMaxResults(params.max_results, config);
			const doResearch = params.research ?? false;
			const requestedProvider = params.provider as string | undefined;
			const requestedVertical = params.vertical as string | undefined;

			// Build query list: single query or multi-query
			const queryList = (Array.isArray(params.queries) ? params.queries : [])
				.map((q) => (typeof q === "string" ? q.trim() : ""))
				.filter(Boolean);
			if (queryList.length === 0 && typeof params.query === "string" && params.query.trim()) {
				queryList.push(params.query.trim());
			}

			if (queryList.length === 0) {
				throw new Error("No query provided. Use 'query' or 'queries' parameter.");
			}
			if (doResearch && queryList.length !== 1) {
				throw new Error("'research=true' requires exactly one query.");
			}
			if (doResearch && requestedProvider && requestedProvider !== RESEARCH_PROVIDER) {
				throw new Error("'research=true' uses Tavily and cannot be combined with another explicit provider.");
			}
			if (doResearch && requestedVertical) {
				throw new Error("'research=true' uses Tavily and cannot be combined with vertical search.");
			}
			const searchProvider = doResearch ? RESEARCH_PROVIDER : requestedProvider;

			// For single queries with research enabled, check the dedicated research cache
			let researchCacheKey: string | undefined;
			if (queryList.length === 1 && doResearch) {
				researchCacheKey = JSON.stringify({
					query: queryList[0],
					maxResults,
					provider: searchProvider,
					vertical: requestedVertical,
					research: true,
				});
				const cached = searchCache.get(researchCacheKey);
				if (cached) {
					onUpdate?.({
						content: [{ type: "text", text: "Retrieving cached research report..." }],
						details: { phase: "research", cacheHit: true },
					});
					return cached;
				}
			}

			// Build providers from config
			const apiKeys: Record<string, string | undefined> = {};
			for (const meta of PROVIDERS) {
				apiKeys[meta.name] = resolveApiKey(meta.name, meta.envVar, config);
			}
			const providers = createAvailableProviders(apiKeys);

			if (providers.size === 0) {
				const envVars = PROVIDERS.map((p) => p.envVar).join(", ");
				throw new Error(`No search providers available. Set ${envVars}.`);
			}
			if (doResearch) {
				assertResearchAvailable(apiKeys, providers);
			}

			let responsePayload: any;

			// Multi-query: run in parallel
			if (queryList.length > 1) {
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${queryList.length} queries in parallel...` }],
					details: { phase: "searching", queryCount: queryList.length },
				});

				const results = await Promise.all(
					queryList.map(async (q) => {
						try {
							const r = await executeSearch(
								providers,
								q,
								maxResults,
								{
									provider: searchProvider,
									vertical: requestedVertical,
								},
								signal,
							);
							return { query: q, results: r.results, provider: r.provider };
						} catch (err) {
							signal?.throwIfAborted();
							return {
								query: q,
								results: [] as SearchResult[],
								provider: "error",
								error: err instanceof Error ? err.message : String(err),
							};
						}
					}),
				);
				signal?.throwIfAborted();

				const providers_used = [...new Set(results.filter((r) => !("error" in r)).map((r) => r.provider))];
				const totalResults = results.reduce((sum, r) => sum + r.results.length, 0);
				const errors = results.filter((r) => "error" in r);
				if (errors.length === results.length) {
					throw new Error(
						`All parallel searches failed:\n${errors.map((e) => `${e.query}: ${e.error}`).join("\n")}`,
					);
				}

				responsePayload = {
					content: [{ type: "text", text: formatMultiQueryResults(results) }],
					details: {
						queryCount: queryList.length,
						totalResults,
						providers: providers_used,
						errors: errors.length > 0 ? errors.map((e) => (e as any).error) : undefined,
					},
				};
			} else {
				// Single query
				const query = queryList[0];
				onUpdate?.({
					content: [{ type: "text", text: `Searching: "${query}"...` }],
					details: { phase: "searching" },
				});

				try {
					const { results, provider } = await executeSearch(
						providers,
						query,
						maxResults,
						{
							provider: searchProvider,
							vertical: requestedVertical,
						},
						signal,
					);

					const details: Record<string, unknown> = {
						query,
						provider,
						resultCount: results.length,
					};

					// Deep research and its supporting search results both use Tavily.
					if (doResearch) {
						const tavily = providers.get(RESEARCH_PROVIDER)!;
						onUpdate?.({
							content: [{ type: "text", text: "Generating research report..." }],
							details: { phase: "research" },
						});
						const answer = await tavily.research!(query, signal);
						signal?.throwIfAborted();
						details.research = true;

						const limited = await limitToolOutput(
							formatResearchResults(query, answer, results, provider),
							signal,
						);
						const payload = {
							content: [{ type: "text", text: limited.text }],
							details: {
								...details,
								truncation: limited.truncation,
								fullOutputPath: limited.fullOutputPath,
							},
						};
						if (researchCacheKey) {
							searchCache.set(researchCacheKey, payload);
						}
						return payload;
					}

					const text = formatSearchResults(results, provider);
					responsePayload = { content: [{ type: "text", text }], details };
				} catch (err) {
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const text = responsePayload.content[0]?.text ?? "";
			const limited = await limitToolOutput(text, signal);
			return {
				...responsePayload,
				content: [{ type: "text", text: limited.text }],
				details: {
					...responsePayload.details,
					truncation: limited.truncation,
					fullOutputPath: limited.fullOutputPath,
				},
			};
		},

		renderCall(args, theme) {
			const ql = Array.isArray(args.queries) ? args.queries.filter((q: unknown) => typeof q === "string") : [];
			if (ql.length > 1) {
				return new Text(
					theme.fg("toolTitle", theme.bold("Search ")) + theme.fg("accent", `${ql.length} queries`),
					0,
					0,
				);
			}
			const q = (args.query as string) || ql[0] || "";
			const display = q.length > 60 ? `${q.slice(0, 57)}...` : q;
			return new Text(theme.fg("toolTitle", theme.bold("Search ")) + theme.fg("accent", `"${display}"`), 0, 0);
		},

		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) {
				const d = result.details as { phase?: string; queryCount?: number } | undefined;
				if (d?.queryCount) {
					return new Text(theme.fg("warning", `Searching ${d.queryCount} queries...`), 0, 0);
				}
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			// Handle error state (e.g. all providers failed)
			if (context?.isError) {
				const content = result.content[0];
				const errMsg = content?.type === "text" ? content.text : "Search failed";
				const cleanErrMsg = errMsg.split("\n")[0] || "Search failed";
				return new Text(theme.fg("error", `✗ search failed: ${cleanErrMsg.slice(0, 200)}`), 0, 0);
			}

			const d = result.details as
				| {
						resultCount?: number;
						totalResults?: number;
						provider?: string;
						providers?: string[];
						research?: boolean;
						error?: string;
				  }
				| undefined;
			if (d?.error) return new Text(theme.fg("error", d.error), 0, 0);
			const count = d?.totalResults ?? d?.resultCount ?? 0;
			const provider = d?.providers?.join("+") ?? d?.provider ?? "?";
			const label = d?.research ? `Research: ${count} sources` : `✓ ${count} results via ${provider}`;
			return new Text(theme.fg("success", label), 0, 0);
		},
	});
}
