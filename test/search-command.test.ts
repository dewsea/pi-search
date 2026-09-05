import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { loadConfig, resolveDefaultConfigPath, saveApiKey } from "../src/config.js";
import "../src/providers/index.js";
import {
	createProviderSelector as createSelector,
	MaskedInputComponent,
	registerSearchCommand,
} from "../src/search-command.js";

const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

function createProviderSelector(
	choices: Parameters<typeof createSelector>[0],
	theme: Theme,
	done: (name: string | undefined) => void,
) {
	return createSelector(choices, theme, done, keybindings);
}

const colors: Record<string, string> = {
	accent: "\x1b[36m",
	text: "\x1b[37m",
	muted: "\x1b[90m",
	dim: "\x1b[38;5;240m",
	border: "\x1b[34m",
};
const theme = {
	fg: (color: string, text: string) => `${colors[color]}${text}\x1b[39m`,
	bold: (text: string) => text,
} as Theme;

const choices: Parameters<typeof createProviderSelector>[0] = [
	{ value: "tavily", label: "Tavily", status: "env", displayStatus: "\u2713 env: TAVILY_API_KEY" },
	{ value: "exa", label: "Exa", status: "stored", displayStatus: "\u2713 stored" },
	{ value: "jina", label: "Jina", status: "keyless", displayStatus: "\u2713 keyless" },
	{ value: "brave", label: "Brave", status: "unconfigured", displayStatus: "\u2022 unconfigured" },
];

function plainRows(component: Component, width = 80): string[] {
	return component.render(width).map(stripVTControlCharacters);
}

function registeredCommand() {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	registerSearchCommand({
		registerCommand(name, command) {
			assert.equal(name, "search");
			handler = command.handler;
		},
	} as ExtensionAPI);
	assert.ok(handler);
	return handler;
}

describe("provider selector presentation", () => {
	it("shows compact names and separately colored credential states, including selected rows", () => {
		const component = createProviderSelector(choices, theme, () => {});
		const rows = component.render(80);
		const plain = rows.map(stripVTControlCharacters).join("\n");
		assert.ok(plain.includes("Tavily"));
		assert.ok(!plain.includes("(tavily)"));
		assert.ok(!plain.includes("(exa)"));
		assert.ok(!plain.includes("Cancel"));
		for (const choice of choices) {
			const row = rows.find((line) => stripVTControlCharacters(line).includes(choice.displayStatus));
			assert.ok(row);
			const color = choice.status === "unconfigured" ? colors.dim : colors.muted;
			assert.ok(row.includes(`${color}${choice.displayStatus}`));
		}
		for (let i = 0; i < 3; i++) component.handleInput?.("\x1b[B");
		const selectedUnconfigured = component.render(80).find((line) => line.includes("Brave"));
		assert.ok(selectedUnconfigured?.includes(`${colors.dim}\u2022 unconfigured`));
	});

	it("aligns status text and stays within narrow terminal widths", () => {
		const component = createProviderSelector(choices, theme, () => {});
		const rows = plainRows(component).filter((line) => /Tavily|Exa|Jina|Brave/.test(line));
		const statusColumns = rows.map((line) =>
			line.indexOf("\u2713") >= 0 ? line.indexOf("\u2713") : line.indexOf("\u2022"),
		);
		assert.equal(new Set(statusColumns).size, 1);
		for (const width of [20, 40, 80]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `Line exceeds ${width} columns`);
			}
		}
	});

	it("selects by provider ID and preserves keyboard navigation", () => {
		let selected: string | undefined;
		const component = createProviderSelector(choices, theme, (name) => {
			selected = name;
		});
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\n");
		assert.equal(selected, "exa");
	});

	it("shows a filter input and propagates focus for the terminal cursor", () => {
		const component = createProviderSelector(choices, theme, () => {});
		const rows = plainRows(component);
		assert.equal(rows[0], "\u2500".repeat(80));
		assert.equal(rows.at(-1), "\u2500".repeat(80));
		assert.ok(rows.some((line) => line.startsWith("> ")));
		assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
		component.focused = true;
		assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
		component.focused = false;
		assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
	});

	it("MaskedInputComponent propagates focus for the terminal cursor", () => {
		const masked = new MaskedInputComponent("Enter key", keybindings, () => {});
		assert.equal(masked.focused, false);
		masked.focused = true;
		assert.equal(masked.focused, true);
		assert.ok(masked.render(80).join("\n").includes(CURSOR_MARKER));
		masked.focused = false;
		assert.equal(masked.focused, false);
		assert.ok(!masked.render(80).join("\n").includes(CURSOR_MARKER));
	});

	it("fuzzy-filters names case-insensitively and treats letters as input", () => {
		let selected: string | undefined;
		const component = createProviderSelector(choices, theme, (name) => {
			selected = name;
		});
		component.handleInput?.("jN");
		const rendered = plainRows(component).join("\n");
		assert.ok(rendered.includes("> jN"));
		assert.ok(rendered.includes("Jina"));
		assert.ok(!rendered.includes("Tavily"));
		assert.ok(!rendered.includes("Brave"));
		component.handleInput?.("\r");
		assert.equal(selected, "jina");
	});

	it("matches provider IDs when their display labels differ", () => {
		const component = createProviderSelector(
			[{ ...choices[1], label: "Research Engine" }, choices[0]],
			theme,
			() => {},
		);
		component.handleInput?.("EXA");
		const rendered = plainRows(component).join("\n");
		assert.ok(rendered.includes("Research Engine"));
		assert.ok(!rendered.includes("Tavily"));
	});

	it("keeps an empty match list safe and restores results when the query is cleared", () => {
		let confirmed = false;
		const component = createProviderSelector(choices, theme, () => {
			confirmed = true;
		});
		component.handleInput?.("zzz");
		assert.ok(plainRows(component).join("\n").includes("No matching providers"));
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\r");
		assert.equal(confirmed, false);
		for (const line of component.render(20)) assert.ok(visibleWidth(line) <= 20);
		component.handleInput?.("\x15");
		const restored = plainRows(component).join("\n");
		for (const choice of choices) assert.ok(restored.includes(choice.label));
		assert.ok(!restored.includes("No matching providers"));
	});

	it("uses injected selection keybindings and keeps navigation within the list", () => {
		const customBindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.down": "ctrl+n",
			"tui.select.up": "ctrl+p",
			"tui.select.confirm": "ctrl+t",
		});
		let selected: string | undefined;
		const component = createSelector(
			choices,
			theme,
			(name) => {
				selected = name;
			},
			customBindings,
		);
		component.handleInput?.("\x10");
		component.handleInput?.("\x0e");
		component.handleInput?.("\x14");
		assert.equal(selected, "exa");
	});

	it("cancels with Esc without selecting a provider", () => {
		let called = false;
		const component = createProviderSelector(choices, theme, (name) => {
			called = true;
			assert.equal(name, undefined);
		});
		component.handleInput?.("\x1b");
		assert.ok(called);
	});

	it("re-renders credential colors after invalidation", () => {
		let dimColor = colors.dim;
		const changingTheme = {
			...theme,
			fg: (color: string, text: string) => `${color === "dim" ? dimColor : colors[color]}${text}\x1b[39m`,
		} as Theme;
		const component = createProviderSelector(choices, changingTheme, () => {});
		component.render(80);
		dimColor = "\x1b[38;5;245m";
		component.invalidate();
		assert.ok(component.render(80).some((line) => line.includes(`${dimColor}\u2022 unconfigured`)));
	});
});

describe("/search menu cancellation", () => {
	let agentDir: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-search-menu-test-"));
		originalEnv = process.env;
		process.env = { PATH: originalEnv.PATH, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir };
	});
	afterEach(() => {
		process.env = originalEnv;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("exits the TUI provider selector with Esc without opening an action menu or writing config", async () => {
		let renderRequests = 0;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: async (factory: any) => {
					let selected: string | undefined;
					const component = factory(
						{ requestRender: () => renderRequests++ },
						theme,
						keybindings,
						(value: string | undefined) => {
							selected = value;
						},
					);
					assert.ok(!plainRows(component).join("\n").includes("Cancel"));
					component.focused = true;
					assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
					component.handleInput("\x1b");
					return selected;
				},
				select: () => assert.fail("Esc should not open the action menu"),
			},
		} as unknown as ExtensionCommandContext;
		await registeredCommand()("", ctx);
		assert.equal(renderRequests, 1);
		assert.equal(existsSync(resolveDefaultConfigPath()), false);
	});

	for (const stored of [false, true]) {
		it(`omits Cancel from both menus and preserves configuration on action cancellation (stored=${stored})`, async () => {
			if (stored) await saveApiKey("tavily", "test-stored-key");
			const previousConfig = loadConfig();
			let menuCount = 0;
			const ctx = {
				hasUI: true,
				mode: "rpc",
				ui: {
					select: async (_title: string, options: string[]) => {
						menuCount++;
						assert.ok(!options.includes("Cancel"));
						if (menuCount === 1) {
							assert.ok(!options.some((option) => option.includes("(tavily)")));
							assert.ok(options.every((option) => !option.includes("\x1b")));
							return options.find((option) => option.startsWith("Tavily  "));
						}
						assert.deepEqual(options, stored ? ["Change API Key", "Delete Stored Key"] : ["Set API Key"]);
						return undefined;
					},
					custom: () => assert.fail("Cancellation must not open key input"),
				},
			} as unknown as ExtensionCommandContext;
			await registeredCommand()("", ctx);
			assert.equal(menuCount, 2);
			assert.deepEqual(loadConfig(), previousConfig);
		});
	}
});
