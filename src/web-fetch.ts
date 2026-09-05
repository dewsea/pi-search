// fetch tool — explicit provider web extraction with bounded concurrency and aggregation

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
import { executeFetch } from "./execution.js";
import { fetchPromptGuidelines, getCandidateFetchProviders } from "./providers/index.js";
import type { Provider } from "./providers/types.js";
import { validateHttpUrl } from "./utils.js";

const RENDER_PREVIEW_LINES = 20;

interface FetchRenderItem {
	provider: string;
	status: "success" | "error" | string;
	title?: string;
	contentType?: string;
	error?: string;
}

interface FetchRenderDetails {
	items?: FetchRenderItem[];
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

export function buildFetchToolDefinition(candidates: Provider[], _config: SearchConfig) {
	const candidateNames = candidates.map((p) => p.name);

	const FetchParameters = Type.Object({
		url: Type.String({ description: "Target HTTP(S) URL to extract content from" }),
		providers: Type.Array(StringEnum(candidateNames, { description: "Provider name" }), {
			minItems: 1,
			description: "List of provider names to fetch with",
		}),
	});

	type FetchParams = Static<typeof FetchParameters>;

	return {
		name: "fetch",
		label: "Fetch",
		description: `Fetch and extract content from a URL using specified providers. Complete output is bounded to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch and extract web page content using one or more providers",
		promptGuidelines: fetchPromptGuidelines(candidates),
		parameters: FetchParameters,

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
			}
			return args;
		},

		async execute(
			_id: string,
			params: FetchParams & Record<string, unknown>,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: unknown,
		) {
			// Reject removed legacy parameters before network access
			if ("raw" in params && params.raw !== undefined) {
				throw new Error("The 'raw' parameter has been removed in pi-search v0.2.");
			}

			const rawUrl = params.url;
			if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
				throw new Error("url must be a non-empty string");
			}
			const validated = validateHttpUrl(rawUrl.trim());
			const normalizedUrl = validated.toString();

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
			const availableCandidates = getCandidateFetchProviders(currentConfig);
			const candidateMap = new Map(availableCandidates.map((p) => [p.name, p]));

			const selectedProviders: Provider[] = [];
			for (const name of requestedProviders) {
				const provider = candidateMap.get(name);
				if (!provider) {
					throw new Error(
						`Provider "${name}" is not registered, unconfigured, or does not support fetch. Available: ${[...candidateMap.keys()].join(", ") || "none"}`,
					);
				}
				selectedProviders.push(provider);
			}

			// Build resolved apiKeys map
			const apiKeys: Record<string, string | undefined> = {};
			for (const p of selectedProviders) {
				const cred = resolveProviderCredential(p, currentConfig);
				apiKeys[p.name] = cred.apiKey;
			}

			const result = await executeFetch(selectedProviders, normalizedUrl, { apiKeys, signal });

			const sanitizedItems = result.items.map((item) =>
				item.status === "success"
					? {
							provider: item.provider,
							status: "success" as const,
							title: item.data.title,
							contentType: item.data.contentType,
						}
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
			const url = compactText(args?.url, 120);
			const providers = compactText(getProviderNames(args).join(", "), 48);
			let text = theme.fg("toolTitle", theme.bold("Fetch"));
			if (url) text += ` ${theme.fg("accent", url)}`;
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
			if (isPartial) return renderResultText(theme.fg("warning", "Fetching..."), duration, theme);

			const output = getTextContent(result);
			if (context.isError) {
				const error = compactText(output.split(/\r?\n/, 1)[0] || "Fetch failed", 200);
				return renderResultText(theme.fg("error", `✗ Fetch failed: ${error}`), duration, theme);
			}

			const details = result.details as FetchRenderDetails | undefined;
			if (!Array.isArray(details?.items)) {
				return renderResultText(renderFallbackOutput(result, expanded, theme), duration, theme);
			}

			const parts = details.items.map((item) => {
				const provider = compactText(item.provider, 40) || "provider";
				if (item.status === "success") {
					const title = compactText(item.title, 100);
					const suffix = title || "OK";
					return `${theme.fg("success", "✓")} ${theme.fg("accent", `${provider}:`)} ${theme.fg("muted", suffix)}`;
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

export function registerWebFetchTool(pi: ExtensionAPI): void {
	const config = loadConfig();
	const candidates = getCandidateFetchProviders(config);
	if (candidates.length === 0) return;

	const definition = buildFetchToolDefinition(candidates, config);
	pi.registerTool(definition);
}
