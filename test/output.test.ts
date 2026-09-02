import assert from "node:assert";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { limitToolOutput } from "../src/output.js";
import { fetchCache, registerWebFetchTool } from "../src/web-fetch.js";

function assertOutputBudget(text: string): void {
	const bytes = Buffer.byteLength(text, "utf8");
	const lines = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
	assert.ok(bytes <= DEFAULT_MAX_BYTES, `${bytes} bytes exceeds ${DEFAULT_MAX_BYTES}`);
	assert.ok(lines <= DEFAULT_MAX_LINES, `${lines} lines exceeds ${DEFAULT_MAX_LINES}`);
}

function registeredFetchTool(): Pick<ToolDefinition, "execute"> {
	let tool: Pick<ToolDefinition, "execute"> | undefined;
	registerWebFetchTool({
		registerTool(definition) {
			tool = definition;
		},
	} as ExtensionAPI);
	assert.ok(tool);
	return tool;
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

describe("web_fetch output budget", () => {
	for (const { name, text, title, raw, url = "https://example.com/output" } of [
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
		{ name: "raw HTML", text: `<!doctype html>\n${"<p>original HTML</p>\n".repeat(3000)}`, raw: true },
	]) {
		it(`bounds headers, body, and notice for ${name}`, async (t) => {
			const cacheKey = `${url}_${raw ?? false}_auto`;
			fetchCache.set(cacheKey, { result: { text, title }, provider: raw ? "direct" : "tavily" });
			t.after(() => fetchCache.clear());

			const result = await registeredFetchTool().execute(
				"id",
				{ url, raw },
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
			assert.ok(details.fullOutputPath);
			assert.ok(content.text.includes(details.fullOutputPath));
			assert.strictEqual(await readFile(details.fullOutputPath, "utf8"), text);
		});
	}

	it("preserves headers and body when the complete response fits", async (t) => {
		const url = "https://example.com/small";
		const text = "<p>original HTML</p>\n";
		fetchCache.set(`${url}_true_auto`, { result: { text, title: "Page title" }, provider: "direct" });
		t.after(() => fetchCache.clear());

		const result = await registeredFetchTool().execute(
			"id",
			{ url, raw: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		assert.deepStrictEqual(result.content, [
			{
				type: "text",
				text: `**URL:** ${url}\n**Provider:** direct\n**Title:** Page title\n**Mode:** raw\n${text}`,
			},
		]);
		assert.strictEqual((result.details as { fullOutputPath?: string }).fullOutputPath, undefined);
	});
});
