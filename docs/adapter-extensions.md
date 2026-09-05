# pi-search Adapter Extension Contract

Custom provider adapters give pi-search file-level plug-and-play capability: drop a TypeScript or JavaScript file into the user adapter directory, reload, and the provider is registered — no package edits, no registry changes.

## Directory Layout

User adapters are discovered from Pi's resolved agent directory:

```text
<agent-dir>/extensions/pi-search/
  config.json        # optional: apiKeys / defaults (see README)
  providers/         # custom provider adapter files
```

`<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent` (XDG layouts work through `PI_CODING_AGENT_DIR`). Adapter files may be `.ts` or `.js`. Files named `index.*`, `types.*`, `*.test.*`, `*.spec.*`, and `*.d.ts` are ignored. Subdirectories are not scanned.

## Adapter File Shape

Each file default-exports a `Provider` object produced by `defineProvider`:

```ts
import { defineProvider, type ProviderContext, type SearchResponse, type FetchResponse } from "@hyav/pi-search";

export default defineProvider({
  name: "my-provider",            // unique ID; same-name overrides built-in
  label: "My Provider",           // human-readable display name
  envVar: "MY_PROVIDER_API_KEY",  // environment variable for the API key
  keyless: false,                 // optional: true if provider functions without an API key

  searchHint: "When to prefer this provider for search.",
  fetchHint: "When to prefer this provider for fetch.",

  async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
    const res = await ctx.request(`https://api.myprovider.com/search?q=${encodeURIComponent(query)}&n=${maxResults}`);
    const data = await res.json();
    return {
      results: data.items.map((item: any) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
      })),
    };
  },

  async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
    const res = await ctx.request(`https://api.myprovider.com/extract?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    return {
      title: data.title,
      text: data.content,
    };
  },
});
```

`defineProvider` is a pure validator: it validates the declaration at load time and returns the provider object unchanged.

## Validation Rules

An invalid declaration throws during load; the file is skipped with a warning and the remaining files still load.

- `name`, `label`, and `envVar` are required non-empty strings.
- Must implement at least one operation: `search` or `fetch`.
- If `search` is implemented, `searchHint` is required.
- If `fetch` is implemented, `fetchHint` is required.
- `keyless` (when present) must be a boolean.
- Legacy v0.1 fields (`create`, `capabilities`, `searchFallbackPriority`, `fetchFallbackPriority`) are strictly rejected with an explicit migration error message.

## ProviderContext

Methods receive a `ProviderContext` parameter providing:

- `apiKey`: The resolved API key (from stored config or environment variable), or `undefined` if keyless.
- `signal`: An `AbortSignal` for cancellation propagation.
- `request(url, init)`: An HTTP helper wrapping `fetch` with an automatic 30-second timeout, 10 MiB buffer limit, and abortion signal handling.

## Conflicts and Override Semantics

Built-in providers register first at module load; user adapters load after, so a user adapter with the same `name` overrides the built-in registration. The overridden metadata is replaced in place. Deleting a user adapter that overrode a built-in provider and reloading with `/reload` automatically restores the built-in provider.

## Loading and `/reload`

Adapters load at extension startup. On `/reload`, the extension re-runs discovery: cached modules under the adapter root are dropped, so edits to existing files are re-read from disk; removed files disappear; broken files are skipped with a warning.

## Import Rules for Adapter Files

- Adapter files import `defineProvider`, `registerProvider`, and shared types (`Provider`, `ProviderContext`, `SearchResponse`, `FetchResponse`) from `@hyav/pi-search`. The loader aliases this package name to the package's internal adapter API, so it resolves regardless of local installs.
- Adapter files must not runtime-import Pi's bundled packages (`@earendil-works/*`); type-only imports are fine.
- Adapter code runs with the user's full system privileges and can execute arbitrary code. Only install adapters from sources you trust.

## Reference Templates

The built-in providers under `src/providers/` (`tavily.ts`, `anysearch.ts`, `jina.ts`, `exa.ts`, `serper.ts`, `firecrawl.ts`, `brave.ts`, `tinyfish.ts`, `serpapi.ts`) serve as reference templates. Additional non-built-in examples (DeepSeek, Doubao, Gemini, iFlow) live under [`examples/search-providers`](../examples/search-providers/).
