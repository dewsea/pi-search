// Configuration persistence — <Pi agent dir>/extensions/pi-search/config.json.
//
// Credential priority matches Pi: stored > env > keyless.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export { withFileMutationQueue };

/**
 * Resolve Pi's agent directory without importing Pi's bundled packages.
 * Mirrors Pi's getAgentDir(): `PI_CODING_AGENT_DIR` wins, `~/` expands to the
 * home directory, and the fallback is `~/.pi/agent`.
 */
export function resolveDefaultAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const raw =
		configured !== undefined && configured.trim() !== "" ? configured.trim() : join(homedir(), ".pi", "agent");
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return raw;
}

/** User-managed extension directory: <agent dir>/extensions/pi-search. */
export function getUserConfigDir(): string {
	return join(resolveDefaultAgentDir(), "extensions", "pi-search");
}

export function resolveDefaultConfigPath(): string {
	return join(getUserConfigDir(), "config.json");
}

export interface SearchConfig {
	apiKeys?: Record<string, string>;
	defaults?: {
		max_results?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

const DEFAULT_CONFIG: SearchConfig = {};

export function loadConfig(configPath?: string): SearchConfig {
	const resolvedPath = configPath ?? resolveDefaultConfigPath();
	if (!existsSync(resolvedPath)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(resolvedPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_CONFIG };
		return { ...DEFAULT_CONFIG, ...(parsed as SearchConfig) };
	} catch (err) {
		console.error("Failed to parse config.json:", err instanceof Error ? err.message : err);
		return { ...DEFAULT_CONFIG };
	}
}

export type CredentialStatus = "stored" | "env" | "keyless" | "unconfigured";

export interface ResolvedCredential {
	status: CredentialStatus;
	displayStatus: string;
	apiKey?: string;
}

export function resolveProviderCredential(
	provider: { name: string; envVar: string; keyless?: boolean },
	config: SearchConfig,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
	// 1. stored
	const rawStored = config.apiKeys?.[provider.name];
	if (typeof rawStored === "string") {
		const trimmed = rawStored.trim();
		if (trimmed) {
			return {
				status: "stored",
				displayStatus: "✓ stored",
				apiKey: trimmed,
			};
		}
	}

	// 2. env
	const rawEnv = env[provider.envVar];
	if (typeof rawEnv === "string") {
		const trimmed = rawEnv.trim();
		if (trimmed) {
			return {
				status: "env",
				displayStatus: `✓ env: ${provider.envVar}`,
				apiKey: trimmed,
			};
		}
	}

	// 3. keyless
	if (provider.keyless === true) {
		return {
			status: "keyless",
			displayStatus: "✓ keyless",
		};
	}

	// 4. unconfigured
	return {
		status: "unconfigured",
		displayStatus: "• unconfigured",
	};
}

export function resolveApiKey(
	name: string,
	envVar: string,
	config: SearchConfig,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const cred = resolveProviderCredential({ name, envVar }, config, env);
	return cred.apiKey;
}

export async function updateConfig(
	updater: (config: SearchConfig) => SearchConfig | Promise<SearchConfig>,
	configPath?: string,
): Promise<SearchConfig> {
	const resolvedPath = configPath ?? resolveDefaultConfigPath();
	return withFileMutationQueue(resolvedPath, async () => {
		const dir = dirname(resolvedPath);

		// Ensure directory exists with restricted mode 0700
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		try {
			chmodSync(dir, 0o700);
		} catch {}

		let current: SearchConfig = {};
		if (existsSync(resolvedPath)) {
			try {
				const raw = readFileSync(resolvedPath, "utf-8");
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new Error("Cannot save config: existing config.json is not an object");
				}
				current = parsed as SearchConfig;
			} catch (err) {
				throw new Error(
					`Cannot save config: existing configuration is corrupted (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}

		const updated = await updater(current);

		// Atomic write via temp file with 0600 mode
		const tempPath = join(dir, `.config-${randomUUID()}.tmp`);
		writeFileSync(tempPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
		try {
			chmodSync(tempPath, 0o600);
		} catch {}

		renameSync(tempPath, resolvedPath);
		try {
			chmodSync(resolvedPath, 0o600);
		} catch {}

		return updated;
	});
}

export async function saveApiKey(name: string, apiKey: string | undefined, configPath?: string): Promise<void> {
	await updateConfig((current) => {
		const apiKeys: Record<string, string> = { ...(current.apiKeys ?? {}) };
		if (typeof apiKey === "string" && apiKey.trim()) {
			apiKeys[name] = apiKey.trim();
		} else {
			delete apiKeys[name];
		}
		return {
			...current,
			apiKeys,
		};
	}, configPath);
}
