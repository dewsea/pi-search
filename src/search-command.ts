import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getProviderRegistry } from "./adapter-api.js";
import { loadConfig, resolveProviderCredential, type SearchConfig, saveApiKey } from "./config.js";
import type { Provider } from "./providers/types.js";

function providerChoices(providers: readonly Provider[], config: SearchConfig) {
	return providers.map((provider) => {
		const { status, displayStatus } = resolveProviderCredential(provider, config);
		const duplicateLabel = providers.some((p) => p.name !== provider.name && p.label === provider.label);
		return {
			value: provider.name,
			label: duplicateLabel ? `${provider.label} (${provider.name})` : provider.label,
			status,
			displayStatus,
		};
	});
}

export function createProviderSelector(
	choices: ReturnType<typeof providerChoices>,
	theme: Theme,
	done: (name: string | undefined) => void,
	keybindings: KeybindingsManager,
	requestRender: () => void = () => {},
): Component & Focusable {
	const byName = new Map(choices.map((choice) => [choice.value, choice]));
	const nameWidth = Math.min(24, Math.max(0, ...choices.map((choice) => visibleWidth(choice.label))));
	const title = new Text("", 1, 0);
	const input = new Input();
	const border = new DynamicBorder((text: string) => theme.fg("border", text));
	const createList = (items: typeof choices) =>
		new SelectList(
			items,
			8,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: () => theme.fg("dim", "  No matching providers"),
			},
			{
				truncatePrimary: ({ item, maxWidth, isSelected }) => {
					const choice = byName.get(item.value)!;
					const name = truncateToWidth(choice.label, Math.min(nameWidth, maxWidth), "");
					const gap = " ".repeat(Math.max(2, nameWidth - visibleWidth(name) + 2));
					const status = theme.fg(choice.status === "unconfigured" ? "dim" : "muted", choice.displayStatus);
					return truncateToWidth(`${isSelected ? name : theme.fg("text", name)}${gap}${status}`, maxWidth, "");
				},
			},
		);
	let filtered = choices;
	let list = createList(filtered);

	return {
		get focused() {
			return input.focused;
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		render(width) {
			title.setText(theme.fg("accent", theme.bold("Search & Fetch Providers")));
			return [
				...border.render(width),
				"",
				...title.render(width),
				"",
				...input.render(width),
				"",
				...list.render(width),
				"",
				...border.render(width),
			].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() {
			title.invalidate();
			input.invalidate();
			list.invalidate();
			border.invalidate();
		},
		handleInput(data) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
			} else if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
				const selected = list.getSelectedItem();
				if (selected) done(selected.value);
			} else if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				const index = filtered.findIndex((choice) => choice.value === list.getSelectedItem()?.value);
				list.setSelectedIndex(index + (keybindings.matches(data, "tui.select.up") ? -1 : 1));
			} else {
				const previousQuery = input.getValue();
				input.handleInput(data);
				if (input.getValue() !== previousQuery) {
					filtered = fuzzyFilter(choices, input.getValue(), (choice) => `${choice.label} ${choice.value}`);
					list = createList(filtered);
				}
			}
			requestRender();
		},
	};
}

export class MaskedInput extends Input {
	override render(width: number): string[] {
		const originalValue = this.getValue();
		try {
			(this as any).value = "*".repeat(originalValue.length);
			return super.render(width);
		} finally {
			(this as any).value = originalValue;
		}
	}
}

export class MaskedInputComponent extends Container implements Focusable {
	private input: MaskedInput;
	private done: (value: string | undefined) => void;
	private keybindings: KeybindingsManager;

	constructor(title: string, keybindings: KeybindingsManager, done: (value: string | undefined) => void) {
		super();
		this.done = done;
		this.keybindings = keybindings;
		this.addChild(new Spacer(1));
		this.addChild(new Text(title, 1, 0));
		this.addChild(new Spacer(1));
		this.input = new MaskedInput();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text("Enter: submit | Esc: cancel", 1, 0));
		this.addChild(new Spacer(1));
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") {
			this.done(this.input.getValue());
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		this.input.handleInput(data);
	}
}

export function registerSearchCommand(
	pi: ExtensionAPI,
	onConfigUpdated?: (ctx: ExtensionContext) => Promise<void> | void,
): void {
	pi.registerCommand("search", {
		description: "Configure search & fetch provider credentials",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"Interactive UI required for /search. Configure credentials via environment variables or <agent-dir>/extensions/pi-search/config.json",
					"warning",
				);
				return;
			}

			const config = loadConfig();
			const providers = getProviderRegistry();

			const choices = providerChoices(providers, config);
			let selectedName: string | undefined;
			if (ctx.mode === "tui") {
				selectedName = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
					createProviderSelector(choices, theme, done, keybindings, () => tui.requestRender()),
				);
			} else {
				const labels = choices.map((choice) => `${choice.label}  ${choice.displayStatus}`);
				const selection = await ctx.ui.select("Search & Fetch Providers", labels);
				if (selection === undefined) return;
				selectedName = choices[labels.indexOf(selection)]?.value;
			}
			if (selectedName === undefined) return;

			const provider = providers.find((p) => p.name === selectedName);
			if (!provider) return;

			const currentCred = resolveProviderCredential(provider, config);
			const actionOptions =
				currentCred.status === "stored" ? ["Change API Key", "Delete Stored Key"] : ["Set API Key"];

			const action = await ctx.ui.select(`Configure ${provider.label}`, actionOptions);
			if (!action) return;

			if (action === "Delete Stored Key") {
				try {
					await saveApiKey(provider.name, undefined);
					ctx.ui.notify(`Removed stored API key for ${provider.label}`, "info");
					await onConfigUpdated?.(ctx);
				} catch (err) {
					ctx.ui.notify(`Failed to remove key: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (action === "Set API Key" || action === "Change API Key") {
				if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
					ctx.ui.notify(
						`Masked input requires interactive TUI mode. To configure ${provider.label}, set environment variable ${provider.envVar} or edit config.json.`,
						"warning",
					);
					return;
				}

				const promptTitle = `Enter API key for ${provider.label} (${provider.envVar}):`;
				const keyInput = await ctx.ui.custom<string | undefined>((_tui, _theme, keybindings, done) => {
					return new MaskedInputComponent(promptTitle, keybindings, done);
				});

				if (keyInput === undefined) return; // Cancelled

				const trimmed = keyInput.trim();
				if (!trimmed) {
					ctx.ui.notify("API key cannot be empty", "warning");
					return;
				}

				try {
					await saveApiKey(provider.name, trimmed);
					ctx.ui.notify(`Saved API key for ${provider.label}`, "info");
					await onConfigUpdated?.(ctx);
				} catch (err) {
					ctx.ui.notify(`Failed to save key: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			}
		},
	});
}
