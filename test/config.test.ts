import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, resolveProviderCredential, type SearchConfig, saveApiKey, updateConfig } from "../src/config.js";

describe("Credential Resolution Logic (stored > env > keyless)", () => {
	const mockConfig: SearchConfig = {
		apiKeys: {
			tavily: "config-tavily-key",
			exa: "config-exa-key",
		},
	};

	it("prioritizes stored key over environment variable (stored > env)", () => {
		const env = { TAVILY_API_KEY: "env-tavily-key" };
		const cred = resolveProviderCredential({ name: "tavily", envVar: "TAVILY_API_KEY" }, mockConfig, env);
		assert.strictEqual(cred.status, "stored");
		assert.strictEqual(cred.displayStatus, "✓ stored");
		assert.strictEqual(cred.apiKey, "config-tavily-key");
	});

	it("falls back to environment variable when stored key is not set", () => {
		const env = { BRAVE_API_KEY: "env-brave-key" };
		const cred = resolveProviderCredential({ name: "brave", envVar: "BRAVE_API_KEY" }, mockConfig, env);
		assert.strictEqual(cred.status, "env");
		assert.strictEqual(cred.displayStatus, "✓ env: BRAVE_API_KEY");
		assert.strictEqual(cred.apiKey, "env-brave-key");
	});

	it("falls back to keyless when neither stored nor env is present and provider is keyless", () => {
		const cred = resolveProviderCredential({ name: "jina", envVar: "JINA_API_KEY", keyless: true }, mockConfig, {});
		assert.strictEqual(cred.status, "keyless");
		assert.strictEqual(cred.displayStatus, "✓ keyless");
		assert.strictEqual(cred.apiKey, undefined);
	});

	it("reports unconfigured when key is required but neither stored nor env is set", () => {
		const cred = resolveProviderCredential(
			{ name: "serper", envVar: "SERPER_API_KEY", keyless: false },
			mockConfig,
			{},
		);
		assert.strictEqual(cred.status, "unconfigured");
		assert.strictEqual(cred.displayStatus, "• unconfigured");
		assert.strictEqual(cred.apiKey, undefined);
	});

	it("ignores whitespace-only stored or env values", () => {
		const configWithEmpty: SearchConfig = { apiKeys: { exa: "   " } };
		const envWithEmpty = { EXA_API_KEY: "   " };
		const cred = resolveProviderCredential(
			{ name: "exa", envVar: "EXA_API_KEY", keyless: false },
			configWithEmpty,
			envWithEmpty,
		);
		assert.strictEqual(cred.status, "unconfigured");
	});

	it("handles non-string apiKey values safely without crashing", () => {
		const corruptConfig = { apiKeys: { exa: 12345 } } as unknown as SearchConfig;
		const cred = resolveProviderCredential({ name: "exa", envVar: "EXA_API_KEY" }, corruptConfig, {});
		assert.strictEqual(cred.status, "unconfigured");
	});

	it("loadConfig returns default config when file contains an array", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-array-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(configPath, JSON.stringify(["not", "an", "object"]));
			const loaded = loadConfig(configPath);
			assert.deepStrictEqual(loaded, {});
			assert.strictEqual(Array.isArray(loaded), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Config persistence and safe atomic writing", () => {
	it("saves apiKey with atomic write and 0600 mode, preserving existing fields", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-save-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(
				configPath,
				JSON.stringify({
					apiKeys: { existing: "key-1" },
					defaults: { max_results: 8 },
					customSetting: true,
				}),
			);

			await saveApiKey("exa", "new-exa-key", configPath);

			const updated = loadConfig(configPath);
			assert.strictEqual(updated.apiKeys?.existing, "key-1");
			assert.strictEqual(updated.apiKeys?.exa, "new-exa-key");
			assert.strictEqual(updated.defaults?.max_results, 8);
			assert.strictEqual(updated.customSetting, true);

			const mode = statSync(configPath).mode & 0o777;
			assert.strictEqual(mode, 0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes key when empty or undefined is passed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-delete-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(configPath, JSON.stringify({ apiKeys: { to_delete: "val", keep: "val2" } }));

			await saveApiKey("to_delete", undefined, configPath);

			const updated = loadConfig(configPath);
			assert.strictEqual(updated.apiKeys?.to_delete, undefined);
			assert.strictEqual(updated.apiKeys?.keep, "val2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite corrupted config file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-corrupted-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(configPath, "{ not valid json ... ");

			await assert.rejects(() => saveApiKey("exa", "key", configPath), /corrupted/);

			// Check file content was not overwritten
			assert.strictEqual(readFileSync(configPath, "utf-8"), "{ not valid json ... ");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updateConfig atomically reads and updates configuration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-search-update-"));
		const configPath = join(dir, "config.json");
		try {
			writeFileSync(configPath, JSON.stringify({ defaults: { max_results: 5 } }));

			const updated = await updateConfig((cfg) => {
				return {
					...cfg,
					defaults: { ...cfg.defaults, max_results: 10 },
					custom: "test",
				};
			}, configPath);

			assert.strictEqual(updated.defaults?.max_results, 10);
			assert.strictEqual(updated.custom, "test");

			const onDisk = loadConfig(configPath);
			assert.strictEqual(onDisk.defaults?.max_results, 10);
			assert.strictEqual(onDisk.custom, "test");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
