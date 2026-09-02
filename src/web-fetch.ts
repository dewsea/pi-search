// web_fetch tool — fetch and extract content from a URL
//
// Routes to the best available provider for content extraction, with SSRF
// protection, large-response spillover, and optional raw HTML mode.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "./adapter-api.js";
import { loadConfig, resolveApiKey } from "./config.js";
import { limitToolOutput } from "./output.js";
import {
	buildFetchChain,
	createAvailableProviders,
	fetchPromptGuidelines,
	fetchProviderNames,
	PROVIDERS,
} from "./providers/index.js";
import type { FetchResponse, Provider } from "./providers/types.js";
import { assertSafeDns, cleanHtmlToMarkdown, fetchWithRetry, SafeMemoryCache, validateHttpUrl } from "./utils.js";

// Global fetch cache instance: TTL 5 minutes, capacity 100 entries
export const fetchCache = new SafeMemoryCache<{ result: FetchResponse; provider: string }>(300000, 100);

export interface FetchExecuteOpts {
	provider?: string;
}

export async function executeFetch(
	providers: Map<string, Provider>,
	url: string,
	opts: FetchExecuteOpts,
	signal?: AbortSignal,
): Promise<{ result: FetchResponse; provider: string }> {
	signal?.throwIfAborted();
	// Remote Providers do not connect from the user's machine, but reject unsafe
	// schemes, credentials, literal non-public addresses, and local-only names.
	// Pass the canonical URL across the Provider boundary to avoid parser differences.
	const providerUrl = validateHttpUrl(url).href;

	const errors: string[] = [];

	// Build try chain
	let chain: string[];
	if (opts.provider) {
		const p = providers.get(opts.provider);
		if (!p || !p.capabilities?.contentExtraction || typeof p.fetch !== "function") {
			throw new Error(
				`Requested provider "${opts.provider}" is not available or does not support content extraction. Configure its API key or omit provider.`,
			);
		}
		// LLM explicit provider — try only it (option A: no fallback)
		chain = [opts.provider];
	} else {
		// No provider specified — cost-priority fallback chain
		chain = buildFetchChain().filter((name) => {
			const p = providers.get(name);
			return Boolean(p?.capabilities?.contentExtraction && typeof p.fetch === "function");
		});
	}

	if (chain.length === 0) {
		throw new Error(
			"No content extraction providers available. Please configure API keys or add custom provider adapters to <agent-dir>/extensions/pi-search/providers/.",
		);
	}

	for (const name of chain) {
		signal?.throwIfAborted();
		const p = providers.get(name);
		if (!p?.capabilities.contentExtraction || !p.fetch) continue;

		try {
			const result = await p.fetch(providerUrl, signal);
			signal?.throwIfAborted();
			return { result, provider: name };
		} catch (err) {
			signal?.throwIfAborted();
			errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// If LLM specified a provider, stop here (don't fall back)
		if (opts.provider) break;
	}

	throw new Error(`All providers failed to fetch ${url}:\n${errors.join("\n")}`);
}

interface FetchDetails {
	url: string;
	provider: string;
	title?: string;
	contentType?: string;
	raw?: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function normalizeDirectResponse(rawText: string, contentType: string, raw: boolean): FetchResponse {
	if (raw) return { text: rawText, contentType: contentType || undefined };

	const trimmed = rawText.trim().toLowerCase();
	if (
		contentType.toLowerCase().includes("text/html") ||
		contentType.toLowerCase().includes("application/xhtml+xml") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<!doctype html")
	) {
		return { text: cleanHtmlToMarkdown(rawText), contentType: "text/markdown" };
	}
	return { text: rawText, contentType: contentType || undefined };
}

export function registerWebFetchTool(pi: ExtensionAPI): void {
	const providerNames = fetchProviderNames();

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch and extract the full content of a URL as clean text/markdown. Follow the provider guidance or omit provider to use the cost-priority fallback chain. Set raw=true for direct raw HTML (do not combine raw with provider). Tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the full-output path is returned when truncated.`,
		promptSnippet: "Fetch and read the full content of a URL — use after web_search to drill into specific pages.",
		get promptGuidelines() {
			return fetchPromptGuidelines();
		},
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch. Must start with http:// or https://." }),
			provider: Type.Optional(
				StringEnum(providerNames, {
					description: `Directly specify the extraction provider. Omit to auto-select via cost-priority fallback chain (${buildFetchChain().join(" → ")}).`,
				}),
			),
			raw: Type.Optional(
				Type.Boolean({
					description: "Return raw HTML via direct HTTP. Cannot be combined with provider. Default: false.",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			signal?.throwIfAborted();
			const url = params.url as string;
			const raw = (params.raw ?? false) as boolean;
			const requestedProvider = params.provider as string | undefined;
			if (raw && requestedProvider) {
				throw new Error("'raw=true' uses direct HTTP and cannot be combined with 'provider'.");
			}

			const cacheKey = `${url}_${raw}_${requestedProvider ?? "auto"}`;
			const cached = fetchCache.get(cacheKey);

			let result: FetchResponse;
			let provider: string;

			if (cached) {
				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${url}... (Cache Hit!)` }],
					details: { url },
				});
				result = cached.result;
				provider = cached.provider;
			} else {
				// Build providers from config
				const config = loadConfig();
				const apiKeys: Record<string, string | undefined> = {};
				for (const meta of PROVIDERS) {
					apiKeys[meta.name] = resolveApiKey(meta.name, meta.envVar, config);
				}
				const providers = createAvailableProviders(apiKeys);

				// Raw mode: skip provider chain, go direct HTTP
				if (raw) {
					onUpdate?.({
						content: [{ type: "text", text: `Fetching ${url} (raw)...` }],
						details: { url },
					});

					try {
						const { ip: safeIp } = await assertSafeDns(url, signal);
						const res = await fetchWithRetry(url, { signal }, 1, safeIp);
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const rawText = await res.text();
						const originalContentType = res.headers.get("content-type") ?? "";
						result = normalizeDirectResponse(rawText, originalContentType, raw);
						provider = "direct";
					} catch (err) {
						signal?.throwIfAborted();
						throw new Error(`Raw fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
					}
				} else {
					onUpdate?.({
						content: [{ type: "text", text: `Fetching ${url}...` }],
						details: { url },
					});

					const fetched = await executeFetch(providers, url, { provider: requestedProvider }, signal);
					result = fetched.result;
					provider = fetched.provider;
				}

				// Fetch succeeded; store in memory cache
				fetchCache.set(cacheKey, { result, provider });
			}

			const header = [`**URL:** ${url}`, `**Provider:** ${provider}`];
			if (result.title) header.push(`**Title:** ${result.title}`);
			if (raw) header.push("**Mode:** raw");
			header.push("");

			// Bound the complete response while keeping saved content (including raw HTML) unchanged.
			const limited = await limitToolOutput(header.join("\n") + result.text, signal, result.text);
			const details: FetchDetails = {
				url,
				provider,
				raw,
				title: result.title,
				contentType: result.contentType,
				truncation: limited.truncation,
				fullOutputPath: limited.fullOutputPath,
			};

			return {
				content: [{ type: "text", text: limited.text }],
				details,
			};
		},

		renderCall(args, theme) {
			const u = args.url as string;
			const raw = args.raw ? " [raw]" : "";
			return new Text(theme.fg("toolTitle", theme.bold("Fetch ")) + theme.fg("accent", u + raw), 0, 0);
		},

		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

			const d = result.details as FetchDetails | undefined;

			// Handle error state (Codex style 200 char limit)
			if (context?.isError) {
				const content = result.content[0];
				const errMsg = content?.type === "text" ? content.text : "Fetch failed";
				const cleanErrMsg = errMsg.split("\n")[0] || "Fetch failed";
				return new Text(theme.fg("error", `✗ fetch failed: ${cleanErrMsg.slice(0, 200)}`), 0, 0);
			}

			// Normal execution single-line summary (title capped to 120 chars)
			let summary = theme.fg("success", `✓ ${d?.provider ?? "fetched"}`);
			if (d?.title) summary += theme.fg("muted", `: ${d.title.slice(0, 120)}`);
			if (d?.truncation?.truncated) summary += theme.fg("warning", " (truncated)");
			if (d?.raw) summary += theme.fg("muted", " raw");

			return new Text(summary, 0, 0);
		},
	});
}
