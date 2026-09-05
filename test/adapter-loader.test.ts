import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadUserAdapters, resolveUserAdapterRoot } from "../src/adapter-loader.js";
import { PROVIDERS } from "../src/providers/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function writeAdapterBody(providerName: string, label: string): string {
	return [
		`import { defineProvider } from ${JSON.stringify(`${packageRoot}/src/adapter-api.ts`)};`,
		`export default defineProvider({`,
		`	name: ${JSON.stringify(providerName)},`,
		`	label: ${JSON.stringify(label)},`,
		`	envVar: "CUSTOM_API_KEY",`,
		`	searchHint: "Test search hint",`,
		`	fetchHint: "Test fetch hint",`,
		`	async search(query, maxResults, ctx) { return { results: [] }; },`,
		`	async fetch(url, ctx) { return { title: "Test", text: "body" }; },`,
		`});`,
	].join("\n");
}

function writeAdapter(root: string, name: string, providerName: string, label: string): string {
	const dir = join(root, "providers");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, writeAdapterBody(providerName, label), "utf8");
	return path;
}

describe("resolveUserAdapterRoot", () => {
	it("defaults to <agent dir>/extensions/pi-search", () => {
		const original = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
			assert.strictEqual(resolveUserAdapterRoot(), join("/tmp/pi-agent", "extensions", "pi-search"));
		} finally {
			if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = original;
		}
	});

	it("honors an explicit userRoot", () => {
		assert.strictEqual(resolveUserAdapterRoot("/custom"), "/custom");
	});
});

describe("loadUserAdapters", () => {
	it("discovers and registers adapter files from the user root", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			writeAdapter(root, "custom.ts", "custom-test", "Custom Test");
			await loadUserAdapters({ userRoot: root });

			const meta = PROVIDERS.find((m) => m.name === "custom-test");
			assert.ok(meta, "custom adapter should be registered");
			assert.strictEqual(meta.label, "Custom Test");
			assert.strictEqual(typeof meta.search, "function");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores test/spec/index/types files", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			writeAdapter(root, "custom.ts", "custom-test-2", "Custom Test 2");
			writeAdapter(root, "custom.test.ts", "should-not-load", "Should Not Load");
			writeAdapter(root, "index.ts", "should-not-load-index", "Should Not Load Index");
			writeAdapter(root, "types.ts", "should-not-load-types", "Should Not Load Types");
			await loadUserAdapters({ userRoot: root });

			assert.ok(PROVIDERS.some((m) => m.name === "custom-test-2"));
			assert.ok(!PROVIDERS.some((m) => m.name === "should-not-load"));
			assert.ok(!PROVIDERS.some((m) => m.name === "should-not-load-index"));
			assert.ok(!PROVIDERS.some((m) => m.name === "should-not-load-types"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("logs and skips a broken adapter without stopping other files", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			writeAdapter(root, "good.ts", "custom-test-3", "Custom Test 3");
			writeFileSync(join(root, "providers", "broken.ts"), "export default 42;\n", "utf8");

			await assert.doesNotReject(loadUserAdapters({ userRoot: root }));
			assert.ok(
				PROVIDERS.some((m) => m.name === "custom-test-3"),
				"good adapter should still load",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a same-name user adapter overrides the built-in provider", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			writeAdapter(root, "override.ts", "tavily", "Custom Tavily Override");
			await loadUserAdapters({ userRoot: root });

			const meta = PROVIDERS.find((m) => m.name === "tavily");
			assert.ok(meta);
			assert.strictEqual(meta.label, "Custom Tavily Override");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reload after deleting a user adapter removes it from the registry", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			const path = writeAdapter(root, "custom.ts", "custom-test-4", "Custom Test 4");
			await loadUserAdapters({ userRoot: root });
			assert.ok(PROVIDERS.some((m) => m.name === "custom-test-4"));

			rmSync(path);
			await loadUserAdapters({ userRoot: root });
			assert.ok(
				!PROVIDERS.some((m) => m.name === "custom-test-4"),
				"deleted user adapter must disappear after reload",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reload after deleting an override restores the built-in provider", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			const path = writeAdapter(root, "override.ts", "tavily", "Temporary Override");
			await loadUserAdapters({ userRoot: root });
			assert.strictEqual(PROVIDERS.find((m) => m.name === "tavily")?.label, "Temporary Override");

			rmSync(path);
			await loadUserAdapters({ userRoot: root });
			const meta = PROVIDERS.find((m) => m.name === "tavily");
			assert.ok(meta);
			assert.strictEqual(meta.label, "Tavily", "built-in registration must be restored");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reload after editing an adapter file re-reads it from disk", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-search-adapters-"));
		try {
			const path = writeAdapter(root, "custom.ts", "custom-test-5", "First Label");
			await loadUserAdapters({ userRoot: root });
			assert.strictEqual(PROVIDERS.find((m) => m.name === "custom-test-5")?.label, "First Label");

			const edited = writeFileSync(path, writeAdapterBody("custom-test-5", "Second Label"), "utf8");
			void edited;
			await loadUserAdapters({ userRoot: root });
			assert.strictEqual(
				PROVIDERS.find((m) => m.name === "custom-test-5")?.label,
				"Second Label",
				"edited adapter must be re-read on reload",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
