# pi-search

[简体中文](README.zh-CN.md)

A focused web search and content extraction extension for [Pi](https://pi.dev), providing two explicit tools (`search` and `fetch`), an interactive `/search` command, and 9 built-in providers.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Highlights

- Two streamlined tools: `search` and `fetch`, requiring explicit `providers` selection
- Interactive `/search` command to inspect provider status and manage API keys
- Multi-provider concurrency (up to 3 providers) with input order preservation and partial failure aggregation
- 9 built-in providers: Tavily, AnySearch, Jina, Exa, Serper, Firecrawl, Brave, TinyFish, and SerpApi
- Unified credential resolution priority: `stored > env > keyless`, storing keys securely in `<agent-dir>/extensions/pi-search/config.json` (0600 permissions)
- File-level plug-and-play custom provider adapters under `<agent-dir>/extensions/pi-search/providers/`
- Tool output strictly bounded to Pi's 2,000-line or 50 KiB limit, with full results preserved in a temporary file

## Install

Requires Node.js 22.19.0 or newer and Pi.

```sh
pi install npm:@hyav/pi-search
```

Once installed, pi-search exposes the `/search` command and dynamically registers `search` and `fetch` based on configured providers.

## Built-in Providers

| Provider | Method | Environment Variable | Keyless | Description |
|---|---|---|---|---|
| Tavily | search, fetch | `TAVILY_API_KEY` | Yes | General web search and clean text extraction |
| AnySearch | search, fetch | `ANYSEARCH_API_KEY` | Yes | Multi-engine aggregator with fast structured extraction |
| Jina | fetch | `JINA_API_KEY` | Yes | Fast reader converting web pages and PDF files into clean Markdown |
| Exa | search, fetch | `EXA_API_KEY` | No | Neural/semantic search engine with content retrieval |
| Serper | search | `SERPER_API_KEY` | No | Google Search API with structured snippets |
| Firecrawl | search, fetch | `FIRECRAWL_API_KEY` | No | Web scraper and search returning clean Markdown |
| Brave | search | `BRAVE_API_KEY` | No | Independent search index with structured results |
| TinyFish | search, fetch | `TINYFISH_API_KEY` | No | High-speed AI search engine and web extractor |
| SerpApi | search | `SERPAPI_API_KEY` | No | Google and multi-engine SERP scraping API |

Tavily, AnySearch, and Jina support keyless access out of the box. Supplying an optional API key provides higher rate limits and higher concurrency.

## Configure

### Interactive `/search` Command

Run `/search` inside Pi to inspect provider status, add or update API keys, or clear stored credentials:

```text
/search
```

Keys configured via `/search` are written to `<agent-dir>/extensions/pi-search/config.json` with strict 0600 permissions. Upon modification, tool definitions and candidate lists refresh immediately.

### Credential Priority

Credentials resolve in the following order:

1. **Stored**: Keys saved in `<agent-dir>/extensions/pi-search/config.json` under `apiKeys`
2. **Environment**: Environment variables declared by the provider (e.g. `TAVILY_API_KEY`)
3. **Keyless**: Built-in keyless support (e.g. Jina fetch)

`<agent-dir>` is resolved from `PI_CODING_AGENT_DIR` or defaults to `~/.pi/agent`.

### Configuration Options

`<agent-dir>/extensions/pi-search/config.json` supports optional defaults:

```json
{
  "apiKeys": {
    "tavily": "tvly-...",
    "exa": "..."
  },
  "defaults": {
    "max_results": 8
  }
}
```

The `defaults.max_results` integer sets the default result count for `search` when omitted (valid range: 1–20).

## Use

### `search`

Executes search across one or more specified providers with bounded concurrency (up to 3 providers in parallel).

```json
{
  "query": "nodejs 22 release notes",
  "providers": ["tavily", "brave"],
  "max_results": 5
}
```

- `query` (required): The search query string.
- `providers` (required): Array of candidate provider names. Single provider for standard search; multiple providers for cross-comparison and wider coverage.
- `max_results` (optional): Maximum results per provider (defaults to configured setting or 5).

### `fetch`

Extracts content from a URL using specified providers.

```json
{
  "url": "https://example.com/article",
  "providers": ["jina"]
}
```

- `url` (required): Target HTTP(S) URL to extract.
- `providers` (required): Array of candidate provider names (e.g. `["jina"]`, `["firecrawl"]`).

## Custom Providers

Add custom provider adapters as plain TypeScript or JavaScript files under your agent directory:

```text
<agent-dir>/extensions/pi-search/providers/
  my-provider.ts
```

Each file default-exports a `Provider` object using `defineProvider`:

```ts
import { defineProvider, type ProviderContext } from "@hyav/pi-search";

export default defineProvider({
  name: "my-provider",
  label: "My Provider",
  envVar: "MY_PROVIDER_API_KEY",
  searchHint: "Use for specialized domain queries.",
  fetchHint: "Use for specific site extractions.",

  async search(query: string, maxResults: number, ctx: ProviderContext) {
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

  async fetch(url: string, ctx: ProviderContext) {
    const res = await ctx.request(`https://api.myprovider.com/extract?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    return {
      title: data.title,
      text: data.content,
    };
  },
});
```

See the [adapter extension contract](https://github.com/hyav/pi-search/blob/v0.2.0/docs/adapter-extensions.md) for full contract details, validation rules, and context methods. Use `/reload` inside Pi to rediscover newly added or edited adapters.

## Security & Privacy

- External Network Calls: Search queries and requested URLs are sent to the explicitly chosen external provider and are subject to its data and privacy policies.
- Custom Adapters: Files under `<agent-dir>/extensions/pi-search/providers/` are user-supplied code executed with Pi's full system privileges; install only adapters you trust.
- SSRF Defenses: Built-in URL validation rejects non-HTTP(S) URLs and invalid formats before network transmission. Provider requests enforce a 30-second timeout and 10 MiB payload limits.
- Output Budgeting: Tool responses are strictly capped to 2,000 lines or 50 KiB. Complete outputs exceeding these limits are written to a user-readable temporary file (0600 permissions) and the path is returned to the model.

## License

[MIT](LICENSE)
