// Public adapter API for pi-search.
//
// User adapter files dropped into <agent dir>/extensions/pi-search/providers/
// import defineProvider and the shared types from this module through the
// "@hyav/pi-search" alias (see src/adapter-loader.ts). Built-in providers in
// src/providers/ are reference templates with this exact shape.
//
// Adapter file shape:
//
//   import { defineProvider } from "@hyav/pi-search";
//   export default defineProvider({
//     name: "my-provider",
//     label: "My Provider",
//     envVar: "MY_PROVIDER_API_KEY",
//     capabilities: { generalSearch: true, verticalSearch: false, /* ... */ },
//     searchHint: "...",
//     fetchHint: "...",
//     searchFallbackPriority: 20,
//     fetchFallbackPriority: 20,
//     apiKeyRequired: false,
//     create: ({ apiKey }) => new MyProvider(apiKey),
//   });

import type { TUnsafe } from "typebox";
import type { Provider, ProviderMeta } from "./providers/types.js";

export type {
	CrawlResult,
	FetchResponse,
	Provider,
	ProviderCapabilities,
	ProviderMeta,
	SearchResponse,
	SearchResult,
} from "./providers/types.js";

/** A provider adapter: metadata plus a factory that creates the runtime instance. */
export interface ProviderAdapter extends ProviderMeta {
	create(opts: { apiKey: string | undefined }): Provider;
}

const PROVIDERS_MUTABLE: ProviderMeta[] = [];
const PROVIDER_FACTORIES = new Map<string, (opts: { apiKey: string | undefined }) => Provider>();
/** Registration source per provider name; only user registrations can be unregistered. */
const PROVIDER_SOURCES = new Map<string, "builtin" | "user">();
/** Built-in adapters, retained so unregistering a user override restores them. */
const BUILTIN_PROVIDERS = new Map<string, ProviderAdapter>();

const CAPABILITY_KEYS = [
	"generalSearch",
	"verticalSearch",
	"contentExtraction",
	"crawl",
	"siteMap",
	"deepResearch",
	"batchSearch",
	"hasMetadata",
] as const;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function safeName(adapter: ProviderAdapter): string {
	return isNonEmptyString(adapter.name) ? adapter.name : "<unnamed>";
}

/** Read-only view of the registered provider metadata. */
export function getProviderRegistry(): readonly ProviderMeta[] {
	return PROVIDERS_MUTABLE;
}

/** Look up the factory for a registered provider name. */
export function getProviderFactory(name: string): ((opts: { apiKey: string | undefined }) => Provider) | undefined {
	return PROVIDER_FACTORIES.get(name);
}

/**
 * Validate adapter metadata consistency; throws on invalid declarations.
 * Adapters can be plain .js files, so every documented field is checked at
 * runtime: strings must be non-empty, capability flags and apiKeyRequired
 * must be booleans, and fallback priorities must be finite numbers.
 */
export function validateProviderAdapter(adapter: ProviderAdapter): void {
	if (!adapter || typeof adapter !== "object") {
		throw new Error("Provider adapter must be an object");
	}
	const displayName = safeName(adapter);
	if (!isNonEmptyString(adapter.name)) {
		throw new Error("Provider adapter name must be a non-empty string");
	}
	if (!isNonEmptyString(adapter.label)) {
		throw new Error(`Provider adapter "${displayName}" label must be a non-empty string`);
	}
	if (!isNonEmptyString(adapter.envVar)) {
		throw new Error(`Provider adapter "${displayName}" envVar must be a non-empty string`);
	}
	if (!adapter.capabilities || typeof adapter.capabilities !== "object") {
		throw new Error(`Provider adapter "${displayName}" must declare capabilities`);
	}
	if (typeof adapter.create !== "function") {
		throw new Error(`Provider adapter "${displayName}" must provide a create() factory`);
	}
	const caps = adapter.capabilities;
	for (const key of CAPABILITY_KEYS) {
		if (typeof caps[key] !== "boolean") {
			throw new Error(`Provider "${displayName}" capabilities.${key} must be a boolean`);
		}
	}
	if (adapter.searchHint !== undefined && !isNonEmptyString(adapter.searchHint)) {
		throw new Error(`Provider "${displayName}" searchHint must be a non-empty string`);
	}
	if (adapter.fetchHint !== undefined && !isNonEmptyString(adapter.fetchHint)) {
		throw new Error(`Provider "${displayName}" fetchHint must be a non-empty string`);
	}
	if (
		adapter.searchFallbackPriority !== undefined &&
		(typeof adapter.searchFallbackPriority !== "number" || !Number.isFinite(adapter.searchFallbackPriority))
	) {
		throw new Error(`Provider "${displayName}" searchFallbackPriority must be a finite number`);
	}
	if (
		adapter.fetchFallbackPriority !== undefined &&
		(typeof adapter.fetchFallbackPriority !== "number" || !Number.isFinite(adapter.fetchFallbackPriority))
	) {
		throw new Error(`Provider "${displayName}" fetchFallbackPriority must be a finite number`);
	}
	if (adapter.verticals !== undefined) {
		if (!Array.isArray(adapter.verticals) || adapter.verticals.some((v) => !isNonEmptyString(v))) {
			throw new Error(`Provider "${displayName}" verticals must be an array of non-empty strings`);
		}
	}
	if (adapter.apiKeyRequired !== undefined && typeof adapter.apiKeyRequired !== "boolean") {
		throw new Error(`Provider "${displayName}" apiKeyRequired must be a boolean`);
	}
	if (caps.generalSearch) {
		if (!adapter.searchHint) throw new Error(`Provider "${displayName}" declares generalSearch but no searchHint`);
		if (adapter.searchFallbackPriority === undefined) {
			throw new Error(`Provider "${displayName}" declares generalSearch but no searchFallbackPriority`);
		}
	}
	if (caps.contentExtraction) {
		if (!adapter.fetchHint) throw new Error(`Provider "${displayName}" declares contentExtraction but no fetchHint`);
		if (adapter.fetchFallbackPriority === undefined) {
			throw new Error(`Provider "${displayName}" declares contentExtraction but no fetchFallbackPriority`);
		}
	}
	if (!caps.generalSearch && adapter.searchHint !== undefined) {
		throw new Error(`Provider "${displayName}" declares searchHint but generalSearch=false`);
	}
	if (!caps.generalSearch && adapter.searchFallbackPriority !== undefined) {
		throw new Error(`Provider "${displayName}" declares searchFallbackPriority but generalSearch=false`);
	}
	if (adapter.verticals?.length && !caps.verticalSearch) {
		throw new Error(`Provider "${displayName}" declares verticals but verticalSearch=false`);
	}
}

/**
 * Declare a provider adapter. Pure: validates and returns the adapter; the
 * loader (or a programmatic caller) registers it with registerProvider().
 */
export function defineProvider(adapter: ProviderAdapter): ProviderAdapter {
	validateProviderAdapter(adapter);
	return adapter;
}

/**
 * Register a provider adapter. Built-ins register first at module load
 * (src/providers/index.ts); user adapters load later from
 * <agent dir>/extensions/pi-search/providers/, so a same-name adapter
 * overrides the earlier registration. A user registration can be removed
 * again with unregisterProvider(); built-in registrations cannot.
 */
export function registerProvider(adapter: ProviderAdapter, source: "builtin" | "user" = "user"): void {
	validateProviderAdapter(adapter);
	if (source === "builtin") {
		BUILTIN_PROVIDERS.set(adapter.name, adapter);
	}
	registerInternal(adapter, source, true);
}

function registerInternal(adapter: ProviderAdapter, source: "builtin" | "user", warnOnReplace: boolean): void {
	const index = PROVIDERS_MUTABLE.findIndex((m) => m.name === adapter.name);
	if (index >= 0) {
		if (warnOnReplace) {
			console.warn(`[pi-search] provider "${adapter.name}" re-registered; the latest registration wins`);
		}
		PROVIDERS_MUTABLE[index] = adapter;
	} else {
		PROVIDERS_MUTABLE.push(adapter);
	}
	PROVIDER_FACTORIES.set(adapter.name, adapter.create);
	PROVIDER_SOURCES.set(adapter.name, source);
}

/**
 * Remove a user-registered provider. Built-in providers are never removed; a
 * user adapter that overrode a built-in gives the built-in registration back.
 */
export function unregisterProvider(name: string): void {
	if (PROVIDER_SOURCES.get(name) !== "user") return;
	const builtin = BUILTIN_PROVIDERS.get(name);
	if (builtin) {
		registerInternal(builtin, "builtin", false);
		return;
	}
	PROVIDER_SOURCES.delete(name);
	PROVIDER_FACTORIES.delete(name);
	const index = PROVIDERS_MUTABLE.findIndex((m) => m.name === name);
	if (index >= 0) PROVIDERS_MUTABLE.splice(index, 1);
}

/** Names of currently registered user adapters (used for reload diffing). */
export function getRegisteredUserProviderNames(): string[] {
	const names: string[] = [];
	for (const [name, source] of PROVIDER_SOURCES) {
		if (source === "user") names.push(name);
	}
	return names;
}

/**
 * String enum schema helper compatible with providers that do not support
 * anyOf/const patterns. Constructs TypeBox's unsafe schema shape without a
 * runtime import so the user-adapter Jiti loader stays independent of Pi's
 * virtual core modules.
 */
export function StringEnum(values: readonly string[], options?: { description?: string; default?: string }): TUnsafe {
	const schema = {
		"~unsafe": null,
		type: "string",
		enum: [...values],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	};
	Object.defineProperty(schema, "~unsafe", {
		configurable: true,
		writable: true,
		enumerable: false,
		value: null,
	});
	return schema;
}
