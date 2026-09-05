import "./setup.js";
import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import registerSearchKit, { syncActiveToolsState } from "../src/index.js";
import * as providers from "../src/providers/index.js";
import tavilyProvider from "../src/providers/tavily.js";
import { MaskedInput, MaskedInputComponent } from "../src/search-command.js";
import { buildSearchToolDefinition } from "../src/web-search.js";

async function setupTools(env: Record<string, string> = { TAVILY_API_KEY: "test-tavily-key" }) {
	const originalEnv = { ...process.env };
	Object.assign(process.env, env);
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = originalEnv.PI_CODING_AGENT_DIR;
	}
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	try {
		await registerSearchKit({
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, def: any) {
				commands.set(name, def);
			},
		} as any);
		return { tools, commands };
	} finally {
		process.env = originalEnv;
	}
}

describe("search and fetch public interface", () => {
	it("normalizes provider argument and fractional result counts in prepareArguments", async () => {
		const { tools } = await setupTools();
		const search = tools.get("search");
		const fetch = tools.get("fetch");

		// Search argument preparation
		const prepSearch = search.prepareArguments({ query: "test", provider: "tavily", max_results: 3.8 });
		assert.deepStrictEqual(prepSearch.providers, ["tavily"]);
		assert.strictEqual(prepSearch.provider, undefined);
		assert.strictEqual(prepSearch.max_results, 3);

		// Fetch argument preparation
		const prepFetch = fetch.prepareArguments({ url: "https://example.com", provider: "jina" });
		assert.deepStrictEqual(prepFetch.providers, ["jina"]);
		assert.strictEqual(prepFetch.provider, undefined);

		// Reject ambiguous arguments
		assert.throws(
			() => search.prepareArguments({ query: "test", provider: "tavily", providers: ["tavily"] }),
			/cannot specify both 'provider' and 'providers'/,
		);
		assert.throws(
			() => fetch.prepareArguments({ url: "https://example.com", provider: "jina", providers: ["jina"] }),
			/cannot specify both 'provider' and 'providers'/,
		);
	});

	it("uses correct parameter schemas and documents Pi output limits", async () => {
		const { tools } = await setupTools();
		const search = tools.get("search");
		const fetch = tools.get("fetch");

		assert.ok(search);
		assert.ok(fetch);

		const searchProps = search.parameters.properties;
		assert.strictEqual(searchProps.query.type, "string");
		assert.strictEqual(searchProps.providers.type, "array");
		assert.ok(searchProps.providers.items);
		const maxResultsSchema = searchProps.max_results.anyOf?.[0] ?? searchProps.max_results;
		assert.strictEqual(maxResultsSchema.type, "integer");

		const fetchProps = fetch.parameters.properties;
		assert.strictEqual(fetchProps.url.type, "string");
		assert.strictEqual(fetchProps.providers.type, "array");

		const expectedLimits = `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}`;
		assert.ok(search.description.includes(expectedLimits));
		assert.ok(fetch.description.includes(expectedLimits));
	});

	it("renders compact themed tool rows with spacing and duration details", async () => {
		const { tools } = await setupTools();
		const search = tools.get("search");
		const fetch = tools.get("fetch");
		const usedColors: string[] = [];
		const theme = {
			fg(color: string, text: string) {
				usedColors.push(color);
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
		const plainLines = (component: any) =>
			component.render(120).map((line: string) => stripVTControlCharacters(line).trimEnd());

		const searchContext = { isError: false, executionStarted: true, state: {} };
		const searchCall = search.renderCall({ query: "pi tui", providers: ["tavily"] }, theme, searchContext);
		assert.deepStrictEqual(plainLines(searchCall), ['Search "pi tui" via tavily']);

		const searchResult = search.renderResult(
			{
				content: [{ type: "text", text: "result one\nresult two" }],
				details: {
					items: [
						{ provider: "tavily", status: "success", count: 5 },
						{ provider: "brave", status: "success", count: 5 },
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			searchContext,
		);
		const searchResultLines = plainLines(searchResult);
		assert.equal(searchResultLines.length, 5);
		assert.deepStrictEqual(searchResultLines.slice(0, 4), ["", "✓ tavily: 5 result(s)", "✓ brave: 5 result(s)", ""]);
		assert.match(searchResultLines[4], /^Took \d+\.\d+s$/);
		assert.ok(usedColors.includes("toolTitle"));
		assert.ok(usedColors.includes("accent"));
		assert.ok(usedColors.includes("success"));
		assert.ok(usedColors.includes("muted"));

		const expandedSearch = search.renderResult(
			{
				content: [{ type: "text", text: "result one\nresult two" }],
				details: {
					items: [
						{ provider: "tavily", status: "success", count: 5 },
						{ provider: "brave", status: "success", count: 5 },
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			searchContext,
		);
		const expandedSearchLines = plainLines(expandedSearch);
		assert.equal(expandedSearchLines.length, 7);
		assert.deepStrictEqual(expandedSearchLines.slice(0, 6), [
			"",
			"✓ tavily: 5 result(s)",
			"✓ brave: 5 result(s)",
			"result one",
			"result two",
			"",
		]);
		assert.match(expandedSearchLines[6], /^Took \d+\.\d+s$/);

		const fetchContext = { isError: false, executionStarted: true, state: {} };
		const fetchCall = fetch.renderCall({ url: "https://example.com/docs", providers: ["jina"] }, theme, fetchContext);
		assert.deepStrictEqual(plainLines(fetchCall), ["Fetch https://example.com/docs via jina"]);

		const fetchResult = fetch.renderResult(
			{
				content: [{ type: "text", text: "page body" }],
				details: { items: [{ provider: "jina", status: "success", title: "Example docs" }] },
			},
			{ expanded: false, isPartial: false },
			theme,
			fetchContext,
		);
		const fetchResultLines = plainLines(fetchResult);
		assert.equal(fetchResultLines.length, 4);
		assert.deepStrictEqual(fetchResultLines.slice(0, 3), ["", "✓ jina: Example docs", ""]);
		assert.match(fetchResultLines[3], /^Took \d+\.\d+s$/);

		const partialContext = { isError: false, executionStarted: true, state: {} };
		search.renderCall({ query: "pi tui", providers: ["tavily"] }, theme, partialContext);
		const partialResult = search.renderResult(
			{ content: [{ type: "text", text: "Searching..." }] },
			{ expanded: false, isPartial: true },
			theme,
			partialContext,
		);
		const partialLines = plainLines(partialResult);
		assert.deepStrictEqual(partialLines.slice(0, 3), ["", "Searching...", ""]);
		assert.match(partialLines[3], /^Elapsed \d+\.\d+s$/);

		const errorContext = { isError: true, executionStarted: true, state: {} };
		search.renderCall({ query: "pi tui", providers: ["tavily"] }, theme, errorContext);
		const errorResult = search.renderResult(
			{ content: [{ type: "text", text: "All providers failed: unavailable" }] },
			{ expanded: false, isPartial: false },
			theme,
			errorContext,
		);
		const errorLines = plainLines(errorResult);
		assert.deepStrictEqual(errorLines.slice(0, 3), ["", "✗ Search failed: All providers failed: unavailable", ""]);
		assert.match(errorLines[3], /^Took \d+\.\d+s$/);
	});

	it("rejects removed legacy parameters before network access", async () => {
		const { tools } = await setupTools();
		const search = tools.get("search");
		const fetch = tools.get("fetch");

		await assert.rejects(
			search.execute("id", { query: "q", providers: ["tavily"], vertical: "academic.search" }),
			/parameter 'vertical' has been removed/,
		);
		await assert.rejects(
			search.execute("id", { query: "q", providers: ["tavily"], queries: ["a", "b"] }),
			/parameter 'queries' has been removed/,
		);
		await assert.rejects(
			search.execute("id", { query: "q", providers: ["tavily"], research: true }),
			/parameter 'research' has been removed/,
		);
		await assert.rejects(
			fetch.execute("id", { url: "https://example.com", providers: ["jina"], raw: true }),
			/parameter has been removed/,
		);
	});

	it("validates providers list before network access", async () => {
		const { tools } = await setupTools();
		const search = tools.get("search");

		// Empty providers
		await assert.rejects(search.execute("id", { query: "q", providers: [] }), /providers must be a non-empty array/);

		// Duplicate providers
		await assert.rejects(
			search.execute("id", { query: "q", providers: ["tavily", "tavily"] }),
			/Duplicate provider in providers list/,
		);

		// Unconfigured / invalid provider
		await assert.rejects(
			search.execute("id", { query: "q", providers: ["nonexistent"] }),
			/Provider "nonexistent" is not registered/,
		);
	});

	it("parallel execution preserves caller cancellation instead of aggregating as provider errors", async () => {
		const reason = new Error("Search cancelled by caller");
		const controller = new AbortController();
		const fetchMock = mock.method(globalThis, "fetch", () => {
			controller.abort(reason);
			return Promise.reject(reason);
		});

		try {
			const originalKey = process.env.TAVILY_API_KEY;
			process.env.TAVILY_API_KEY = "test-tavily-key";
			try {
				const tool = buildSearchToolDefinition([tavilyProvider], {});
				await assert.rejects(
					tool.execute("id", { query: "test", providers: ["tavily"] }, controller.signal),
					(error) => error === reason,
				);
			} finally {
				if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
				else process.env.TAVILY_API_KEY = originalKey;
			}
		} finally {
			fetchMock.mock.restore();
		}
	});

	it("keeps top-level tool metadata provider-neutral", async () => {
		const { tools } = await setupTools();
		assert.ok(!tools.get("search").description.includes("Exa"));
		assert.ok(!tools.get("search").promptSnippet.includes("provider='exa'"));
		assert.ok(!tools.get("fetch").description.includes("Firecrawl"));
	});

	it("exports the package entrypoint and registers /search command", async () => {
		const packageModule = await import("../index.ts");
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		const originalKey = process.env.TAVILY_API_KEY;
		process.env.TAVILY_API_KEY = "test-tavily-key";

		try {
			assert.strictEqual(typeof packageModule.defineProvider, "function");
			assert.strictEqual(typeof packageModule.registerProvider, "function");

			await packageModule.default({
				registerTool(tool: any) {
					tools.set(tool.name, tool);
				},
				registerCommand(name: string, def: any) {
					commands.set(name, def);
				},
			} as any);

			assert.ok(tools.has("search"), "package entrypoint registers search tool");
			assert.ok(tools.has("fetch"), "package entrypoint registers fetch tool");
			assert.ok(!tools.has("web_search"), "package entrypoint does not register legacy web_search tool");
			assert.ok(!tools.has("web_fetch"), "package entrypoint does not register legacy web_fetch tool");
			assert.ok(commands.has("search"), "package entrypoint registers search command");
		} finally {
			if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
			else process.env.TAVILY_API_KEY = originalKey;
		}
	});

	it("sanitizes details.items to prevent session history bloat", async () => {
		const { tools } = await setupTools();
		const search = tools.get("search");
		const fetch = tools.get("fetch");

		mock.method(globalThis, "fetch", (_url: string) => {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						results: [
							{
								title: "Tavily Title",
								url: "https://example.com",
								content: "Snippet content",
								raw_content: "Huge body ".repeat(500),
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		});

		try {
			const searchRes = await search.execute("id", { query: "q", providers: ["tavily"] });
			assert.strictEqual(searchRes.details.items.length, 1);
			assert.deepStrictEqual(searchRes.details.items[0], {
				provider: "tavily",
				status: "success",
				count: 1,
			});
			assert.strictEqual((searchRes.details.items[0] as any).results, undefined);

			const fetchRes = await fetch.execute("id", { url: "https://example.com", providers: ["tavily"] });
			assert.strictEqual(fetchRes.details.items.length, 1);
			assert.deepStrictEqual(fetchRes.details.items[0], {
				provider: "tavily",
				status: "success",
				title: "Tavily Title",
				contentType: "text/markdown",
			});
			assert.strictEqual((fetchRes.details.items[0] as any).data, undefined);
		} finally {
			mock.restoreAll();
		}
	});

	it("/search safely refuses unmasked key input in non-TUI mode", async () => {
		const { commands } = await setupTools();
		const searchCmd = commands.get("search");

		let notifiedMsg = "";
		let notifiedLevel = "";
		const fakeCtx = {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async (title: string, options: string[]) => {
					if (title.includes("Search & Fetch Providers")) return options[0];
					if (title.includes("Configure")) return "Set API Key";
					return "Cancel";
				},
				notify: (msg: string, level: string) => {
					notifiedMsg = msg;
					notifiedLevel = level;
				},
			},
		};

		await searchCmd.handler("", fakeCtx);
		assert.match(notifiedMsg, /Masked input requires interactive TUI mode/);
		assert.strictEqual(notifiedLevel, "warning");
	});

	it("MaskedInput masks typed characters with asterisks and supports submission/cancellation", () => {
		const input = new MaskedInput();
		input.handleInput("secret-api-key");
		assert.strictEqual(input.getValue(), "secret-api-key");

		const rendered = input.render(30).join("\n");
		assert.ok(!rendered.includes("secret-api-key"), "Plaintext key must not be rendered");
		assert.ok(rendered.includes("**************"), "Must render asterisks for characters");

		let submitted: string | undefined;
		const mockKb = {
			matches: (data: string, action: string) => action === "tui.select.confirm" && data === "\n",
		};
		const comp = new MaskedInputComponent("Enter key:", mockKb as any, (val) => {
			submitted = val;
		});
		comp.handleInput("k");
		comp.handleInput("e");
		comp.handleInput("y");
		comp.handleInput("\n");
		assert.strictEqual(submitted, "key");
	});

	it("lifecycle: manages active tools when candidate providers drop to zero and restores them when credentials are provided", async () => {
		const originalSearchCandidates = providers.getCandidateSearchProviders({});
		const originalFetchCandidates = providers.getCandidateFetchProviders({});

		let activeTools = ["read", "write", "search", "fetch"];
		const registeredTools = new Map<string, any>();
		const registeredCommands = new Map<string, any>();
		const eventListeners = new Map<string, Array<() => void>>();

		const fakePi = {
			registerTool: (tool: any) => registeredTools.set(tool.name, tool),
			registerCommand: (name: string, def: any) => registeredCommands.set(name, def),
			getActiveTools: () => [...activeTools],
			setActiveTools: (tools: string[]) => {
				activeTools = [...tools];
			},
			on: (event: string, handler: () => void) => {
				const list = eventListeners.get(event) ?? [];
				list.push(handler);
				eventListeners.set(event, list);
			},
		};

		let currentSearchCandidates = originalSearchCandidates;
		const currentFetchCandidates = originalFetchCandidates;

		await registerSearchKit(fakePi as any, {
			getSearchCandidates: () => currentSearchCandidates,
			getFetchCandidates: () => currentFetchCandidates,
		});
		assert.ok(registeredTools.has("search"));
		assert.ok(registeredTools.has("fetch"));
		assert.ok(!registeredTools.has("web_search"));
		assert.ok(!registeredTools.has("web_fetch"));

		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "search", "fetch"]);

		// Search candidates drop to zero
		currentSearchCandidates = [];
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "fetch"]);

		// Credentials restored / added -> search must be restored
		currentSearchCandidates = [originalSearchCandidates[0]];
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "fetch", "search"]);
	});

	it("lifecycle: preserves user manual deactivation and does not automatically re-enable it", async () => {
		const originalSearchCandidates = providers.getCandidateSearchProviders({});
		const originalFetchCandidates = providers.getCandidateFetchProviders({});

		let activeTools = ["read", "write", "search", "fetch"];
		const registeredTools = new Map<string, any>();
		const registeredCommands = new Map<string, any>();
		const eventListeners = new Map<string, Array<() => void>>();

		const fakePi = {
			registerTool: (tool: any) => registeredTools.set(tool.name, tool),
			registerCommand: (name: string, def: any) => registeredCommands.set(name, def),
			getActiveTools: () => [...activeTools],
			setActiveTools: (tools: string[]) => {
				activeTools = [...tools];
			},
			on: (event: string, handler: () => void) => {
				const list = eventListeners.get(event) ?? [];
				list.push(handler);
				eventListeners.set(event, list);
			},
		};

		let currentSearchCandidates = originalSearchCandidates;
		const currentFetchCandidates = originalFetchCandidates;

		await registerSearchKit(fakePi as any, {
			getSearchCandidates: () => currentSearchCandidates,
			getFetchCandidates: () => currentFetchCandidates,
		});
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "search", "fetch"]);

		// User explicitly deactivates search via /tools
		activeTools = ["read", "write", "fetch"];

		// Session start or provider refresh occurs
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		// search must remain inactive
		assert.deepStrictEqual(activeTools, ["read", "write", "fetch"]);

		// Candidate drop and recovery
		currentSearchCandidates = [];
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "fetch"]);

		currentSearchCandidates = originalSearchCandidates;
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		// Still must not re-enable user-deactivated tool
		assert.deepStrictEqual(activeTools, ["read", "write", "fetch"]);
	});

	it("lifecycle: manages fetch drop and restore independently from search", async () => {
		const originalSearchCandidates = providers.getCandidateSearchProviders({});
		const originalFetchCandidates = providers.getCandidateFetchProviders({});

		let activeTools = ["read", "write", "search", "fetch"];
		const registeredTools = new Map<string, any>();
		const registeredCommands = new Map<string, any>();
		const eventListeners = new Map<string, Array<() => void>>();

		const fakePi = {
			registerTool: (tool: any) => registeredTools.set(tool.name, tool),
			registerCommand: (name: string, def: any) => registeredCommands.set(name, def),
			getActiveTools: () => [...activeTools],
			setActiveTools: (tools: string[]) => {
				activeTools = [...tools];
			},
			on: (event: string, handler: () => void) => {
				const list = eventListeners.get(event) ?? [];
				list.push(handler);
				eventListeners.set(event, list);
			},
		};

		const currentSearchCandidates = originalSearchCandidates;
		let currentFetchCandidates = originalFetchCandidates;

		await registerSearchKit(fakePi as any, {
			getSearchCandidates: () => currentSearchCandidates,
			getFetchCandidates: () => currentFetchCandidates,
		});
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "search", "fetch"]);

		// Fetch candidates drop to zero
		currentFetchCandidates = [];
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "search"]);

		// Fetch candidates restored
		currentFetchCandidates = originalFetchCandidates;
		for (const handler of eventListeners.get("session_start") ?? []) {
			handler();
		}
		assert.deepStrictEqual(activeTools, ["read", "write", "search", "fetch"]);
	});
});

describe("syncActiveToolsState direct unit tests", () => {
	it("returns undefined safely when pi does not provide action methods", () => {
		const deactivated = new Set<string>();
		assert.strictEqual(syncActiveToolsState({}, true, true, deactivated), undefined);
		assert.strictEqual(
			syncActiveToolsState({ getActiveTools: () => null as any }, true, true, deactivated),
			undefined,
		);
	});

	it("removes tools and tracks extension deactivation when candidates are zero", () => {
		let active = ["read", "write", "search", "fetch"];
		const mockPi = {
			getActiveTools: () => [...active],
			setActiveTools: (tools: string[]) => {
				active = [...tools];
			},
		};
		const deactivated = new Set<string>();

		// Both drop to zero
		const result = syncActiveToolsState(mockPi, false, false, deactivated);
		assert.deepStrictEqual(result, ["read", "write"]);
		assert.deepStrictEqual(active, ["read", "write"]);
		assert.ok(deactivated.has("search"));
		assert.ok(deactivated.has("fetch"));

		// Subsequent call with zero candidates is a no-op (no setActiveTools called)
		let setCalled = false;
		const noopPi = {
			getActiveTools: () => [...active],
			setActiveTools: () => {
				setCalled = true;
			},
		};
		syncActiveToolsState(noopPi, false, false, deactivated);
		assert.strictEqual(setCalled, false);

		// Restoring candidates re-enables tools and clears tracking
		syncActiveToolsState(mockPi, true, true, deactivated);
		assert.deepStrictEqual(active, ["read", "write", "search", "fetch"]);
		assert.strictEqual(deactivated.size, 0);
	});

	it("respects user manual deactivation and does not restore user-disabled tools", () => {
		let active = ["read", "write", "fetch"]; // User explicitly turned off search
		const mockPi = {
			getActiveTools: () => [...active],
			setActiveTools: (tools: string[]) => {
				active = [...tools];
			},
		};
		const deactivated = new Set<string>(); // Not deactivated by extension

		// Candidate refresh with search available
		syncActiveToolsState(mockPi, true, true, deactivated);
		assert.deepStrictEqual(active, ["read", "write", "fetch"]);
		assert.strictEqual(deactivated.has("search"), false);

		// Candidate drops to zero
		syncActiveToolsState(mockPi, false, true, deactivated);
		assert.deepStrictEqual(active, ["read", "write", "fetch"]);
		// Since search was already absent, it was not deactivated by extension
		assert.strictEqual(deactivated.has("search"), false);

		// Candidate recovers
		syncActiveToolsState(mockPi, true, true, deactivated);
		// Still not restored!
		assert.deepStrictEqual(active, ["read", "write", "fetch"]);
	});
});
