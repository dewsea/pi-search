import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, resolveApiKey, type SearchConfig } from "../src/config.js";
import { resolveMaxResults } from "../src/web-search.js";

describe("API Key Resolution Logic (resolveApiKey)", () => {
	const mockConfig: SearchConfig = {
		apiKeys: {
			tavily: "config-tavily-key",
			exa: "config-exa-key",
		},
	};

	it("should load API keys from a config.json file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-config-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(
				configPath,
				JSON.stringify({ apiKeys: { tavily: "file-tavily-key", anysearch: "file-anysearch-key" } }),
			);
			const config = loadConfig(configPath);
			assert.deepStrictEqual(config.apiKeys, {
				tavily: "file-tavily-key",
				anysearch: "file-anysearch-key",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should resolve extension config under Pi's agent directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-agent-dir-"));
		const extensionConfigDir = join(dir, "extensions", "pi-search");
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			mkdirSync(extensionConfigDir, { recursive: true });
			writeFileSync(
				join(extensionConfigDir, "config.json"),
				JSON.stringify({ apiKeys: { tavily: "agent-dir-tavily-key" } }),
			);
			process.env.PI_CODING_AGENT_DIR = dir;

			const config = loadConfig();
			assert.strictEqual(config.apiKeys?.tavily, "agent-dir-tavily-key");
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should ignore legacy config paths outside extensions/pi-search", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-legacy-"));
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			for (const legacy of [join(dir, "pi-search"), join(dir, "pi-search-kit")]) {
				mkdirSync(legacy);
				writeFileSync(join(legacy, "config.json"), JSON.stringify({ apiKeys: { tavily: "legacy-key" } }));
			}
			process.env.PI_CODING_AGENT_DIR = dir;

			const config = loadConfig();
			assert.strictEqual(config.apiKeys?.tavily, undefined, "legacy config paths must not be read");
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should load defaults.max_results for web_search", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-config-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(configPath, JSON.stringify({ defaults: { max_results: 8 } }));
			const config = loadConfig(configPath);
			assert.strictEqual(config.defaults?.max_results, 8);
			assert.strictEqual(resolveMaxResults(undefined, config), 8);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should prioritize environment variable over config file value", () => {
		const originalEnv = process.env.TAVILY_API_KEY;
		try {
			process.env.TAVILY_API_KEY = "env-tavily-override";
			const resolved = resolveApiKey("tavily", "TAVILY_API_KEY", mockConfig);
			assert.strictEqual(resolved, "env-tavily-override");
		} finally {
			if (originalEnv === undefined) {
				delete process.env.TAVILY_API_KEY;
			} else {
				process.env.TAVILY_API_KEY = originalEnv;
			}
		}
	});

	it("should fall back to config file when env variable is not set", () => {
		const originalEnv = process.env.EXA_API_KEY;
		try {
			delete process.env.EXA_API_KEY;
			const resolved = resolveApiKey("exa", "EXA_API_KEY", mockConfig);
			assert.strictEqual(resolved, "config-exa-key");
		} finally {
			if (originalEnv !== undefined) {
				process.env.EXA_API_KEY = originalEnv;
			}
		}
	});

	it("should return undefined if neither environment variable nor config value exists", () => {
		const originalEnv = process.env.ANYSEARCH_API_KEY;
		try {
			delete process.env.ANYSEARCH_API_KEY;
			const resolved = resolveApiKey("anysearch", "ANYSEARCH_API_KEY", mockConfig);
			assert.strictEqual(resolved, undefined);
		} finally {
			if (originalEnv !== undefined) {
				process.env.ANYSEARCH_API_KEY = originalEnv;
			}
		}
	});

	it("should ignore empty/whitespace environment variables and fall back to config", () => {
		const originalEnv = process.env.TAVILY_API_KEY;
		try {
			process.env.TAVILY_API_KEY = "   "; // Whitespace env var
			const resolved = resolveApiKey("tavily", "TAVILY_API_KEY", mockConfig);
			assert.strictEqual(resolved, "config-tavily-key");
		} finally {
			if (originalEnv === undefined) {
				delete process.env.TAVILY_API_KEY;
			} else {
				process.env.TAVILY_API_KEY = originalEnv;
			}
		}
	});
});
