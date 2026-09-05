import assert from "node:assert";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionContext,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { registerProvider, unregisterProvider } from "../src/adapter-api.js";
import { limitToolOutput } from "../src/output.js";
import type { Provider } from "../src/providers/types.js";
import { buildFetchToolDefinition } from "../src/web-fetch.js";

function assertOutputBudget(text: string): void {
	const bytes = Buffer.byteLength(text, "utf8");
	const lines = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
	assert.ok(bytes <= DEFAULT_MAX_BYTES, `${bytes} bytes exceeds ${DEFAULT_MAX_BYTES}`);
	assert.ok(lines <= DEFAULT_MAX_LINES, `${lines} lines exceeds ${DEFAULT_MAX_LINES}`);
}

describe("tool output budget", () => {
	it("propagates cancellation before writing oversized output", async () => {
		const controller = new AbortController();
		const reason = new Error("output cancelled by caller");
		controller.abort(reason);

		await assert.rejects(limitToolOutput("x".repeat(60 * 1024), controller.signal), (error) => error === reason);
	});

	for (const full of [
		"",
		"short output\n",
		"x".repeat(DEFAULT_MAX_BYTES),
		Array(DEFAULT_MAX_LINES).fill("line").join("\n"),
		"line\n".repeat(DEFAULT_MAX_LINES),
	]) {
		it(`preserves output within the limits (${Buffer.byteLength(full)} bytes)`, async () => {
			assert.deepStrictEqual(await limitToolOutput(full), { text: full });
		});
	}

	for (const { name, full } of [
		{ name: "an oversized first line", full: "x".repeat(60 * 1024) },
		{
			name: "the line limit",
			full: Array(DEFAULT_MAX_LINES + 1)
				.fill("line")
				.join("\n"),
		},
		{ name: "the byte limit", full: `${"x".repeat(1023)}\n`.repeat(51) },
		{ name: "UTF-8 byte limits", full: `${"\u4e2d".repeat(341)}\n`.repeat(51) },
	]) {
		it(`includes the truncation notice within the budget for ${name}`, async (t) => {
			const limited = await limitToolOutput(full);
			assert.ok(limited.fullOutputPath);
			t.after(() => rm(dirname(limited.fullOutputPath!), { recursive: true, force: true }));

			assertOutputBudget(limited.text);
			assert.ok(limited.truncation?.truncated);
			assert.ok(limited.text.includes(limited.fullOutputPath));
			assert.match(limited.text, /Full output:/);
			assert.strictEqual(await readFile(limited.fullOutputPath, "utf8"), full);
			assert.strictEqual((await stat(limited.fullOutputPath)).mode & 0o777, 0o600);
		});
	}
});

describe("fetch output budget", () => {
	let currentMockResult: { text: string; title?: string } = { text: "body", title: "Page title" };
	const mockProvider: Provider = {
		name: "test-fetcher",
		label: "Test Fetcher",
		envVar: "TEST_FETCHER_API_KEY",
		keyless: true,
		fetchHint: "mock hint",
		async fetch(_url, _ctx) {
			return currentMockResult;
		},
	};

	before(() => {
		registerProvider(mockProvider, "user");
	});

	after(() => {
		unregisterProvider("test-fetcher");
	});

	for (const { name, text, title, url = "https://example.com/output" } of [
		{ name: "a body at the byte limit", text: "x".repeat(DEFAULT_MAX_BYTES) },
		{ name: "a body at the line limit", text: Array(DEFAULT_MAX_LINES).fill("line").join("\n") },
		{ name: "an oversized body", text: `${"x".repeat(1023)}\n`.repeat(51) },
		{ name: "an oversized title", text: "body", title: "t".repeat(DEFAULT_MAX_BYTES) },
		{ name: "a multiline title", text: "body", title: "title\n".repeat(DEFAULT_MAX_LINES) },
		{
			name: "an oversized URL",
			text: "body",
			url: `https://example.com/${"u".repeat(DEFAULT_MAX_BYTES)}`,
		},
	]) {
		it(`bounds headers, body, and notice for ${name}`, async (t) => {
			currentMockResult = { text, title };

			const tool = buildFetchToolDefinition([mockProvider], {});
			const result = await tool.execute(
				"id",
				{ url, providers: ["test-fetcher"] },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			const details = result.details as { fullOutputPath?: string; truncation?: TruncationResult };
			if (details.fullOutputPath) {
				t.after(() => rm(dirname(details.fullOutputPath!), { recursive: true, force: true }));
			}

			const content = result.content[0];
			assert.strictEqual(content?.type, "text");
			if (content?.type !== "text") throw new Error("Expected text output");
			assertOutputBudget(content.text);
			assert.ok(details.truncation?.truncated);
			const fullOutputPath = details.fullOutputPath;
			assert.ok(fullOutputPath);
			assert.ok(content.text.includes(fullOutputPath));
			const saved = await readFile(fullOutputPath, "utf8");
			assert.ok(saved.includes(text));
		});
	}

	it("preserves headers and body when the complete response fits", async () => {
		const url = "https://example.com/small";
		const text = "<p>original HTML</p>\n";
		currentMockResult = { text, title: "Page title" };

		const tool = buildFetchToolDefinition([mockProvider], {});
		const result = await tool.execute(
			"id",
			{ url, providers: ["test-fetcher"] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		assert.strictEqual(
			result.content[0]?.text,
			`**URL:** ${url}\n**Provider:** test-fetcher\n**Title:** Page title\n\n${text}`,
		);
		assert.strictEqual((result.details as { fullOutputPath?: string }).fullOutputPath, undefined);
	});
});
