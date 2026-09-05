// search tool — explicit provider search with bounded concurrency and aggregation

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	keyHint,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { StringEnum } from "./adapter-api.js";
import { loadConfig, resolveProviderCredential, type SearchConfig } from "./config.js";
import { executeSearch } from "./execution.js";
import { getCandidateSearchProviders, searchPromptGuidelines } from "./providers/index.js";
import type { Provider } from "./providers/types.js";

const MIN_RESULTS = 1;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
const RENDER_PREVIEW_LINES = 20;

interface SearchRenderItem {
	provider: string;
	status: "success" | "error" | string;
	count?: number;
	results?: unknown[];
	error?: string;
}

interface SearchRenderDetails {
	items?: SearchRenderItem[];
	truncation?: { truncated?: boolean };
	fullOutputPath?: string;
}

interface RenderableToolResult {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

interface ToolRenderState {
	startedAt?: number;
	endedAt?: number;
}

interface ToolRenderContext {
	isError?: boolean;
	executionStarted?: boolean;
	state?: ToolRenderState;
}

function compactText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	const normalized = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getProviderNames(args: any): string[] {
	const values = Array.isArray(args?.providers)
		? args.providers
		: typeof args?.provider === "string"
			? [args.provider]
			: [];
	return values.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0);
}

function getTextContent(result: RenderableToolResult): string {
	return result.content?.find((content) => content.type === "text" && typeof content.text === "string")?.text ?? "";
}

function markExecutionStart(context: ToolRenderContext | undefined): void {
	const state = context?.state;
	if (context?.executionStarted && state && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

function getDurationLabel(context: ToolRenderContext | undefined, isPartial: boolean): string | undefined {
	const state = context?.state;
	if (state?.startedAt === undefined) return undefined;

	const isComplete = !isPartial || context?.isError === true;
	if (isComplete) state.endedAt ??= Date.now();
	const endTime = state.endedAt ?? Date.now();
	const label = isPartial && context?.isError !== true ? "Elapsed" : "Took";
	const seconds = Math.max(0, endTime - state.startedAt) / 1000;
	return `${label} ${seconds.toFixed(1)}s`;
}

function appendExpandedOutput(text: string, output: string, expanded: boolean, theme: Theme): string {
	if (!expanded || !output.trim()) return text;

	const lines = output.split(/\r?\n/);
	const displayLines = lines.slice(0, RENDER_PREVIEW_LINES);
	const preview = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	const remaining = lines.length - displayLines.length;
	return remaining > 0
		? `${text}\n${preview}\n${theme.fg("muted", `... (${remaining} more lines)`)}`
		: `${text}\n${preview}`;
}

function renderResultText(text: string, duration: string | undefined, theme: Theme): Text {
	if (!text) return new Text(duration ? `\n${theme.fg("muted", duration)}` : "", 0, 0);
	const durationLine = duration ? `\n\n${theme.fg("muted", duration)}` : "";
	return new Text(`\n${text}${durationLine}`, 0, 0);
}

function renderFallbackOutput(result: RenderableToolResult, expanded: boolean, theme: Theme): string {
	const output = getTextContent(result);
	if (!output) return "";

	const lines = output.split(/\r?\n/);
	const displayLines = lines.slice(0, expanded ? RENDER_PREVIEW_LINES : 10);
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	const remaining = lines.length - displayLines.length;
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

export function resolveMaxResults(requestedMaxResults: number | undefined, config: SearchConfig): number {
	const candidate = requestedMaxResults ?? config.defaults?.max_results ?? DEFAULT_RESULTS;
	if (typeof candidate !== "number" || !Number.isFinite(candidate)) return DEFAULT_RESULTS;
	return Math.min(Math.max(Math.trunc(candidate), MIN_RESULTS), MAX_RESULTS);
}

export function buildSearchToolDefinition(candidates: Provider[], config: SearchConfig) {
	const candidateNames = candidates.map((p) => p.name);
	const defaultMaxResults = resolveMaxResults(undefined, config);

	const SearchParameters = Type.Object({
		query: Type.String({ description: "Search query text (non-empty)" }),
		providers: Type.Array(StringEnum(candidateNames, { description: "Provider name" }), {
			minItems: 1,
			description: "List of provider names to search with",
		}),
		max_results: Type.Optional(
			Type.Integer({
				minimum: MIN_RESULTS,
				maximum: MAX_RESULTS,
				default: defaultMaxResults,
				description: `Maximum results per provider (${MIN_RESULTS}-${MAX_RESULTS}, default: ${defaultMaxResults})`,
			}),
		),
	});

	type SearchParams = Static<typeof SearchParameters>;

	return {
		name: "search",
		label: "Search",
		description: `Search the web using specified providers. Complete output is bounded to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the web using one or more providers",
		promptGuidelines: searchPromptGuidelines(candidates),
		parameters: SearchParameters,

		prepareArguments(args: any) {
			if (args && typeof args === "object") {
				if ("provider" in args && args.provider !== undefined) {
					if ("providers" in args && args.providers !== undefined) {
						throw new Error("Ambiguous arguments: cannot specify both 'provider' and 'providers'");
					}
					if (typeof args.provider === "string") {
						args.providers = [args.provider];
						delete args.provider;
					}
				}
				if (typeof args.max_results === "number") {
					args.max_results = Math.trunc(args.max_results);
				}
			}
			return args;
		},

		async execute(
			_id: string,
			params: SearchParams & Record<string, unknown>,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: unknown,
		) {
			// Reject removed legacy parameters before any network access
			for (const key of ["queries", "research", "vertical", "raw"]) {
				if (key in params && params[key] !== undefined) {
					throw new Error(
						`The parameter '${key}' has been removed in pi-search v0.2. Please use 'query' and specify 'providers'.`,
					);
				}
			}

			const rawQuery = params.query;
			if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
				throw new Error("query must be a non-empty string");
			}
			const query = rawQuery.trim();

			const requestedProviders = (params.providers ?? []) as string[];
			if (!Array.isArray(requestedProviders) || requestedProviders.length === 0) {
				throw new Error("providers must be a non-empty array of provider names");
			}

			// Check duplicates
			const seen = new Set<string>();
			for (const name of requestedProviders) {
				if (typeof name !== "string" || !name.trim()) {
					throw new Error("Each provider in providers must be a non-empty string");
				}
				if (seen.has(name)) {
					throw new Error(`Duplicate provider in providers list: "${name}"`);
				}
				seen.add(name);
			}

			// Validate entire provider list against candidates before any network call
			const currentConfig = loadConfig();
			const availableCandidates = getCandidateSearchProviders(currentConfig);
			const candidateMap = new Map(availableCandidates.map((p) => [p.name, p]));

			const selectedProviders: Provider[] = [];
			for (const name of requestedProviders) {
				const provider = candidateMap.get(name);
				if (!provider) {
					throw new Error(
						`Provider "${name}" is not registered, unconfigured, or does not support search. Available: ${[...candidateMap.keys()].join(", ") || "none"}`,
					);
				}
				selectedProviders.push(provider);
			}

			const maxResults = resolveMaxResults(params.max_results, currentConfig);

			// Build resolved apiKeys map
			const apiKeys: Record<string, string | undefined> = {};
			for (const p of selectedProviders) {
				const cred = resolveProviderCredential(p, currentConfig);
				apiKeys[p.name] = cred.apiKey;
			}

			const result = await executeSearch(selectedProviders, query, maxResults, { apiKeys, signal });

			const sanitizedItems = result.items.map((item) =>
				item.status === "success"
					? { provider: item.provider, status: "success" as const, count: item.results.length }
					: { provider: item.provider, status: "error" as const, error: item.error },
			);

			return {
				content: [{ type: "text" as const, text: result.limitedOutput.text }],
				details: {
					providers: requestedProviders,
					items: sanitizedItems,
					truncation: result.limitedOutput.truncation,
					fullOutputPath: result.limitedOutput.fullOutputPath,
				},
			};
		},

		renderCall(args: any, theme: Theme, context?: ToolRenderContext) {
			markExecutionStart(context);
			const query = compactText(args?.query, 72);
			const providers = compactText(getProviderNames(args).join(", "), 48);
			let text = theme.fg("toolTitle", theme.bold("Search"));
			if (query) text += ` ${theme.fg("accent", JSON.stringify(query))}`;
			if (providers) text += theme.fg("dim", ` via ${providers}`);
			return new Text(text, 0, 0);
		},

		renderResult(
			result: RenderableToolResult,
			{ expanded, isPartial }: ToolRenderResultOptions,
			theme: Theme,
			context: ToolRenderContext,
		) {
			const duration = getDurationLabel(context, isPartial);
			if (isPartial) return renderResultText(theme.fg("warning", "Searching..."), duration, theme);

			const output = getTextContent(result);
			if (context.isError) {
				const error = compactText(output.split(/\r?\n/, 1)[0] || "Search failed", 200);
				return renderResultText(theme.fg("error", `✗ Search failed: ${error}`), duration, theme);
			}

			const details = result.details as SearchRenderDetails | undefined;
			if (!Array.isArray(details?.items)) {
				return renderResultText(renderFallbackOutput(result, expanded, theme), duration, theme);
			}

			const parts = details.items.map((item) => {
				const provider = compactText(item.provider, 40) || "provider";
				if (item.status === "success") {
					const count = item.count ?? item.results?.length ?? 0;
					return `${theme.fg("success", "✓")} ${theme.fg("accent", `${provider}:`)} ${theme.fg("muted", `${count} result(s)`)}`;
				}
				const error = compactText(item.error || "failed", 200);
				return `${theme.fg("error", "✗")} ${theme.fg("accent", `${provider}:`)} ${theme.fg("muted", error)}`;
			});
			let text = parts.join("\n") || theme.fg("dim", "No provider results");

			if (details.truncation?.truncated) {
				text += ` ${theme.fg("warning", "[truncated]")}`;
			}
			text = appendExpandedOutput(text, output, expanded, theme);
			if (expanded && details.fullOutputPath) {
				text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return renderResultText(text, duration, theme);
		},
	};
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
	const config = loadConfig();
	const candidates = getCandidateSearchProviders(config);
	if (candidates.length === 0) return;

	const definition = buildSearchToolDefinition(candidates, config);
	pi.registerTool(definition);
}
