# pi-search Adapter Extension Contract

Custom provider adapters give pi-search file-level plug and play: drop a
TypeScript file into the user adapter directory, reload, and the provider is
registered — no package edits, no registry changes.

## Directory layout

User adapters are discovered from Pi's resolved agent directory:

```text
<agent-dir>/extensions/pi-search/
  config.json        # optional: apiKeys / defaults (see README)
  providers/         # custom provider adapter files
```

`<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent` (XDG layouts work
through `PI_CODING_AGENT_DIR`). Adapter files may be `.ts` or `.js`. Files
named `index.*`, `types.*`, `*.test.*`, `*.spec.*`, and `*.d.ts` are ignored.
Subdirectories are not scanned.

## Adapter file shape

Each file default-exports a `ProviderAdapter` produced by `defineProvider`:

```ts
import { defineProvider, type Provider } from "@hyav/pi-search";

class MyProvider implements Provider {
  // Implement the methods promised by capabilities:
  //   search(query, maxResults, signal?)
  //   fetch(url, signal?)
  //   verticalSearch(domain, subDomain, query, maxResults, signal?)
  //   batchSearch(queries, maxResults, signal?)
  //   crawl(url, maxPages, signal?)
  //   map(url, signal?)
  //   research(query, signal?)
}

export default defineProvider({
  name: "my-provider",            // unique ID; same-name overrides built-in
  label: "My Provider",           // human-readable name
  envVar: "MY_PROVIDER_API_KEY",  // environment variable for the API key
  capabilities: {
    generalSearch: true,
    verticalSearch: false,
    contentExtraction: true,
    crawl: false,
    siteMap: false,
    deepResearch: false,
    batchSearch: false,
    hasMetadata: false,
  },
  searchHint: "When to prefer this provider for web_search.",
  fetchHint: "When to prefer this provider for web_fetch.",
  searchFallbackPriority: 20,     // lower = tried first in the search chain
  fetchFallbackPriority: 20,      // lower = tried first in the fetch chain
  apiKeyRequired: false,          // true (default) requires a key to instantiate
  create: ({ apiKey }) => new MyProvider(apiKey),
});
```

`defineProvider` is pure: it validates the declaration and returns the adapter
unchanged. The loader registers the default export after a successful import.

## Validation rules

An invalid declaration throws during load; the file is skipped with a warning
and the remaining files still load. Rules:

- `name`, `label`, and `envVar` are required non-empty strings.
- `capabilities` and `create()` are required. Every capability flag must be a
  boolean, `apiKeyRequired` (when present) must be a boolean, and the fallback
  priorities (when present) must be finite numbers.
- `verticals`, when present, must be an array of non-empty strings.
- `generalSearch: true` requires `searchHint` and `searchFallbackPriority`.
- `contentExtraction: true` requires `fetchHint` and `fetchFallbackPriority`.
- Declaring `searchHint` or `searchFallbackPriority` with
  `generalSearch: false` is rejected.
- Declaring `verticals` with `verticalSearch: false` is rejected.

## Conflicts and override semantics

Built-in providers register first at module load; user adapters load after, so
a user adapter with the same `name` overrides the built-in registration. The
overridden metadata and factory are replaced in place; routing, fallback
chains, and the tool schemas pick up the override automatically. Re-registration
logs a warning naming the provider.

## Loading and /reload

Adapters load at extension startup, before the `web_search` and `web_fetch`
tools register their schemas, so new providers appear in the provider enums
immediately. On `/reload`, the extension re-runs discovery: cached modules
under the adapter root are dropped, so edits to existing files are re-read
from disk; removed files disappear; broken files are skipped with a warning.

## Import rules for adapter files

- Adapter files import `defineProvider`, `registerProvider`, and the shared
  types (`Provider`, `ProviderCapabilities`, ...) from `@hyav/pi-search`.
  The loader aliases this package name to the package's adapter API, so it
  resolves regardless of local installs.
- Adapter files must not runtime-import Pi's bundled packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `@earendil-works/pi-ai`); type-only imports are fine. Runtime values such as
  the agent directory and configuration are resolved by the host, not by
  adapter files.
- API keys: the host resolves them from the adapter's `envVar` environment
  variable first, then from `config.apiKeys[name]` in
  `<agent-dir>/extensions/pi-search/config.json`.
- Adapter code runs with the user's full system privileges and can execute
  arbitrary code. Only install adapters from sources you trust.

## Reference templates

The built-in providers under the package's `src/providers/` (`tavily.ts`,
`anysearch.ts`, `jina.ts`) are reference templates with this exact shape —
copy one and customize it. Complete non-built-in references for DeepSeek,
Doubao Search, Exa, Firecrawl, Gemini, iFlow, and Serper live under
[`examples/search-providers`](../examples/search-providers/). `src/adapter-loader.ts`
documents the discovery implementation.
