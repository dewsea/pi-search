// User adapter discovery — file-level plug and play.
//
// Adapter files live in <agent dir>/extensions/pi-search/providers/ and are
// loaded with jiti so plain .ts files work without compilation. Built-ins are
// registered statically first (src/providers/index.ts); user adapters load
// later, so a same-name adapter overrides the built-in. Pi's /reload re-runs
// this loader and cached modules are dropped so edits to existing adapter
// files are re-read from disk.

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
	getRegisteredUserProviderNames,
	type ProviderAdapter,
	registerProvider,
	unregisterProvider,
} from "./adapter-api.js";
import { resolveDefaultAgentDir } from "./config.js";

const ADAPTER_DIRECTORIES = ["providers"] as const;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
/** Jiti-safe module that adapter files reach through the `@hyav/pi-search` alias. */
const publicAdapterApiPath = join(packageRoot, "src", "adapter-api.ts");

export interface AdapterLoaderOptions {
	/** Explicit user adapter root; replaces the agentDir-based default when provided. */
	userRoot?: string;
}

/** Default user adapter root: <agent dir>/extensions/pi-search. */
export function resolveUserAdapterRoot(userRoot?: string): string {
	return userRoot ?? join(resolveDefaultAgentDir(), "extensions", "pi-search");
}

/**
 * Jiti's module cache is Node's global `require.cache`, so a reload would
 * otherwise reuse previously loaded adapter modules without reading the disk.
 * Drop every cached module under the adapter root before each load so edits
 * to existing adapter files take effect on `/reload`.
 */
function clearAdapterModuleCache(roots: string[]): void {
	const require = createRequire(import.meta.url);
	for (const key of Object.keys(require.cache)) {
		if (roots.some((root) => key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) {
			delete require.cache[key];
		}
	}
}

function isAdapterFile(name: string): boolean {
	if (name.endsWith(".d.ts")) return false;
	if (name.startsWith("index.") || name.startsWith("types.")) return false;
	if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) return false;
	if (name.endsWith(".test.js") || name.endsWith(".spec.js")) return false;
	return extname(name) === ".ts" || extname(name) === ".js";
}

async function discoverAdapterPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for (const directory of ADAPTER_DIRECTORIES) {
		let entries: Dirent[];
		try {
			entries = await readdir(join(root, directory), { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (entry.isFile() && isAdapterFile(entry.name)) paths.push(join(root, directory, entry.name));
		}
	}
	return paths.sort();
}

/**
 * Load and register user adapters; per-file failures are logged and skipped.
 * User adapters that were registered by a previous load but are no longer
 * present (deleted files or files that now fail to load) are unregistered, so
 * a `/reload` reconciles the registry with the adapter directory; built-in
 * providers are never touched.
 */
export async function loadUserAdapters(options: AdapterLoaderOptions = {}): Promise<void> {
	const userRoot = resolveUserAdapterRoot(options.userRoot);
	clearAdapterModuleCache([userRoot]);
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		tryNative: false,
		alias: { "@hyav/pi-search": publicAdapterApiPath },
	});
	const previousUserNames = getRegisteredUserProviderNames();
	const loadedNames = new Set<string>();
	for (const path of await discoverAdapterPaths(userRoot)) {
		try {
			const adapter = (await jiti.import(path, { default: true })) as unknown;
			if (adapter === null || typeof adapter !== "object") {
				throw new TypeError("default export must be a Provider object");
			}
			registerProvider(adapter as ProviderAdapter, "user");
			loadedNames.add((adapter as ProviderAdapter).name);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[pi-search] failed to load adapter ${JSON.stringify(path)}: ${message}`);
		}
	}
	for (const name of previousUserNames) {
		if (!loadedNames.has(name)) unregisterProvider(name);
	}
}
