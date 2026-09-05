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
//     searchHint: "...",
//     fetchHint: "...",
//     async search(query, maxResults, ctx) { ... },
//     async fetch(url, ctx) { ... },
//   });

import type { TUnsafe } from "typebox";
import type { Provider } from "./providers/types.js";

export type {
	FetchResponse,
	Provider,
	ProviderAdapter,
	ProviderContext,
	SearchResponse,
	SearchResult,
} from "./providers/types.js";

const PROVIDERS_MUTABLE: Provider[] = [];
/** Registration source per provider name; only user registrations can be unregistered. */
const PROVIDER_SOURCES = new Map<string, "builtin" | "user">();
/** Built-in adapters, retained so unregistering a user override restores them. */
const BUILTIN_PROVIDERS = new Map<string, Provider>();

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function safeName(adapter: unknown): string {
	if (
		adapter &&
		typeof adapter === "object" &&
		"name" in adapter &&
		isNonEmptyString((adapter as { name: unknown }).name)
	) {
		return (adapter as { name: string }).name;
	}
	return "<unnamed>";
}

/** Read-only view of the registered provider metadata. */
export function getProviderRegistry(): readonly Provider[] {
	return PROVIDERS_MUTABLE;
}

/**
 * Validate adapter metadata consistency; throws on invalid declarations.
 * Adapters can be plain .js/.ts files or objects without defineProvider(),
 * so every documented field is checked at runtime.
 */
export function validateProviderAdapter(adapter: unknown): asserts adapter is Provider {
	if (!adapter || typeof adapter !== "object") {
		throw new TypeError("Provider adapter must be an object");
	}

	const raw = adapter as Record<string, unknown>;

	// Check for deprecated v0.1 contract (create/capabilities)
	if ("create" in raw || "capabilities" in raw) {
		throw new Error(
			`Provider adapter "${safeName(adapter)}" uses deprecated v0.1 contract (create/capabilities); please migrate to the unified Provider interface with direct search/fetch methods`,
		);
	}

	if (!isNonEmptyString(raw.name)) {
		throw new Error("Provider adapter name must be a non-empty string");
	}
	const displayName = raw.name;

	if (!isNonEmptyString(raw.label)) {
		throw new Error(`Provider adapter "${displayName}" label must be a non-empty string`);
	}

	if (!isNonEmptyString(raw.envVar)) {
		throw new Error(`Provider adapter "${displayName}" envVar must be a non-empty string`);
	}

	if (raw.keyless !== undefined && typeof raw.keyless !== "boolean") {
		throw new Error(`Provider adapter "${displayName}" keyless must be a boolean`);
	}

	const hasSearch = typeof raw.search === "function";
	const hasFetch = typeof raw.fetch === "function";

	if (raw.search !== undefined && !hasSearch) {
		throw new Error(`Provider adapter "${displayName}" search must be a function`);
	}
	if (raw.fetch !== undefined && !hasFetch) {
		throw new Error(`Provider adapter "${displayName}" fetch must be a function`);
	}

	if (!hasSearch && !hasFetch) {
		throw new Error(`Provider adapter "${displayName}" must implement at least one method: search or fetch`);
	}

	if (hasSearch) {
		if (!isNonEmptyString(raw.searchHint)) {
			throw new Error(`Provider adapter "${displayName}" implements search but declares no searchHint`);
		}
	} else if (raw.searchHint !== undefined) {
		throw new Error(`Provider adapter "${displayName}" declares searchHint but does not implement search()`);
	}

	if (hasFetch) {
		if (!isNonEmptyString(raw.fetchHint)) {
			throw new Error(`Provider adapter "${displayName}" implements fetch but declares no fetchHint`);
		}
	} else if (raw.fetchHint !== undefined) {
		throw new Error(`Provider adapter "${displayName}" declares fetchHint but does not implement fetch()`);
	}
}

/**
 * Declare a provider adapter. Pure: validates and returns the adapter; the
 * loader (or a programmatic caller) registers it with registerProvider().
 */
export function defineProvider(adapter: Provider): Provider {
	validateProviderAdapter(adapter);
	return adapter;
}

/**
 * Register a provider adapter. Built-ins register first at module load;
 * user adapters load later, so a same-name adapter overrides the earlier registration.
 * A user registration can be removed again with unregisterProvider(); built-ins cannot.
 */
export function registerProvider(adapter: Provider, source: "builtin" | "user" = "user"): void {
	validateProviderAdapter(adapter);
	if (source === "builtin") {
		BUILTIN_PROVIDERS.set(adapter.name, adapter);
	}
	registerInternal(adapter, source, true);
}

function registerInternal(adapter: Provider, source: "builtin" | "user", warnOnReplace: boolean): void {
	const index = PROVIDERS_MUTABLE.findIndex((m) => m.name === adapter.name);
	if (index >= 0) {
		if (warnOnReplace) {
			console.warn(`[pi-search] provider "${adapter.name}" re-registered; the latest registration wins`);
		}
		PROVIDERS_MUTABLE[index] = adapter;
	} else {
		PROVIDERS_MUTABLE.push(adapter);
	}
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
