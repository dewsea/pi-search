# pi-search

[简体中文](README.zh-CN.md)

An LLM-routed web search and content extraction extension for [Pi](https://pi.dev), with built-in Tavily and AnySearch search plus Tavily, AnySearch, and Jina extraction.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Highlights

- LLM routing based on provider capability metadata instead of a hard-coded classifier
- Keyless search and extraction paths with cost-aware fallback
- File-level plug-and-play custom provider adapters under `<agent-dir>/extensions/pi-search/providers/`
- General and vertical search plus web and PDF extraction
- SSRF defenses for direct fetches, bounded responses, cancellation, and timeouts
- Deduplicated output capped to Pi's 2,000-line or 50 KiB tool limit, with full results saved to a temporary file

## Install

Requires Node.js 22.19.0 or newer and Pi.

```sh
pi install npm:@hyav/pi-search
```

Ask Pi for information that requires a live web search. A successful installation exposes `web_search` and `web_fetch` and returns structured results from a selected built-in provider.

## Configure

Built-in Tavily and AnySearch search and Jina extraction work without API keys. Optional credentials unlock provider-specific capabilities:

| Provider | Environment variable | Effect |
|---|---|---|
| Tavily | `TAVILY_API_KEY` | Enables authenticated crawl, map, and research capabilities |
| AnySearch | `ANYSEARCH_API_KEY` | Authenticates general, vertical, and extraction requests |
| Jina | `JINA_API_KEY` | Authenticates web and PDF extraction |

Environment variables take precedence over `<agent-dir>/extensions/pi-search/config.json`, where `<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent` (XDG layouts such as `$XDG_CONFIG_HOME/pi/agent` work through `PI_CODING_AGENT_DIR`). Keep credential files readable only by your user.


## Use

The model calls `web_search` and `web_fetch` directly. Without an explicit provider, the fallback order is:

- Search: Tavily → AnySearch
- Extraction: Tavily → Jina → AnySearch

An explicitly selected provider never falls back silently; its failure is returned directly. If no configured or keyless providers match the requested capability, the tool fails with an explicit actionable error message.

## Custom providers

Custom provider adapters are plain TypeScript files discovered at startup (and re-discovered by `/reload`) from your Pi agent directory:

```text
<agent-dir>/extensions/pi-search/providers/
  my-provider.ts
```

Drop a file in — one provider per file — and it registers automatically. A file declaring the same `name` as a built-in provider overrides it. Adapter files import `defineProvider` from this package and default-export an adapter:

```ts
import { defineProvider, type Provider } from "@hyav/pi-search";

class MyProvider implements Provider {
  // search(), fetch(), ... per the declared ProviderCapabilities
}

export default defineProvider({
  name: "my-provider",
  label: "My Provider",
  envVar: "MY_PROVIDER_API_KEY",
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
  searchHint: "...",
  fetchHint: "...",
  searchFallbackPriority: 20,
  fetchFallbackPriority: 20,
  apiKeyRequired: false,
  create: ({ apiKey }) => new MyProvider(apiKey),
});
```

See the [adapter extension contract](https://github.com/hyav/pi-search/blob/main/docs/adapter-extensions.md) for the full file shape, validation rules, conflicts, and reload behavior. The built-in providers under the package's `src/providers/` are reference templates with this exact shape — copy one and customize it. A repository-only collection of non-built-in DeepSeek, Doubao Search, Exa, Firecrawl, Gemini, iFlow, and Serper adapters is available under [`examples/search-providers`](examples/search-providers/). Adapter files must not runtime-import Pi's bundled packages (`@earendil-works/*`); type-only imports are fine. Add, remove, or modify files, then run `/reload` to rediscover them without touching the package.

Adapter files run with your full system privileges and can execute arbitrary code — only install adapters from sources you trust.

## Before you use it

Search queries, requested URLs, and extracted content are sent to the selected external provider and remain subject to its pricing and data policies. Oversized results are retained in an operating-system temporary directory until you remove them or the OS cleans them up.

## License

[MIT](LICENSE)
