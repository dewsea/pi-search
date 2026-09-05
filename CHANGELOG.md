# Changelog

This file is the authoritative user-facing release history for `@hyav/pi-search`.

## Unreleased

## 0.2.0 - 2026-09-05

- **Breaking**: Renamed model-facing tools from `web_search` and `web_fetch` to `search` and `fetch`, requiring explicit `providers: string[]` selection; individual `provider` argument is normalized to an array for backwards compatibility.
- **Breaking**: Replaced complex multi-tier capabilities and factory functions with a unified `Provider` contract directly implementing `search(query, maxResults, ctx)` and `fetch(url, ctx)`.
- **Breaking**: Removed deprecated features: `queries` multi-query planning, `research` deep research, `vertical` search, `raw` extraction, fallback chains, direct local fetching, and business cache.
- Fixed AnySearch content extraction response parsing to read `data.content` and `data.title` from structured envelopes, resolving empty content extraction errors.
- Fixed Firecrawl search and scrape integration for the current v2 response envelopes.
- Added interactive `/search` command to inspect provider status, set API keys, and clear stored credentials with atomic file updates and live tool definition refreshes.
- Simplified `/search` menus with compact provider names, separately styled credential status, and Escape cancellation without extra Cancel entries; the TUI picker follows Pi's searchable selector pattern with fuzzy filtering and input focus handling.
- Added 9 built-in search and fetch providers: Tavily, AnySearch, Jina, Exa, Serper, Firecrawl, Brave, TinyFish, and SerpApi.
- Implemented multi-provider concurrent execution (up to 3 providers) preserving input order, with partial failure aggregation and 30-second per-provider timeouts.
- Standardized credential resolution priority to `stored > env > keyless`, storing local credentials in `<agent-dir>/extensions/pi-search/config.json` with 0600 file permissions.
- Bounded complete tool output strictly to 2,000 lines or 50 KiB, persisting oversized results to temporary files with paths reported in responses.
- Fixed the package root entry point to export the documented custom provider adapter API.

## 0.1.3 - 2026-08-24

- Fixed custom provider adapters failing to load in compiled Pi installs when `typebox` is supplied by the host instead of installed as a physical package.
- Added repository-only reference adapters for DeepSeek, Doubao Search, Exa, Firecrawl, Gemini, iFlow, and Serper under `examples/search-providers/`; they remain excluded from built-in registration and the npm artifact.

## 0.1.2 - 2026-08-17

- Added file-level plug-and-play custom provider adapters: drop a `defineProvider()` file into `<agent-dir>/extensions/pi-search/providers/` and run `/reload` to rediscover; same-name adapters override built-ins, deleted adapters disappear on reload, and edited files are re-read.
- Consolidated user-managed files under `<agent-dir>/extensions/pi-search/`: `config.json` moved from `<agent-dir>/pi-search/config.json`; legacy `pi-search-kit` and `~/.pi/pi-search*` paths are no longer read.
- Removed the `@earendil-works/pi-ai` peer dependency (its `StringEnum` helper is inlined); added `jiti` as the only runtime dependency, used to load user adapter files.
- Runtime-validated adapter metadata (non-empty strings, boolean capability flags, finite priorities) so plain `.js` adapter files cannot register malformed providers.
- Error messages now point custom provider authors at the user adapter directory instead of the package source tree.

## 0.1.1 - 2026-08-16

- Enforced upfront provider capability and method verification in fallback routing chains.
- Improved error messaging when requested search or content extraction capabilities are unavailable.

## 0.1.0 - 2026-08-16

- Initial public release of `@hyav/pi-search`.
- LLM-routed web search and content extraction with built-in Tavily, AnySearch, and Jina providers.
- Keyless search and extraction paths with explicit provider selection and cost-aware fallback chains.
- Direct-fetch SSRF defenses, DNS/IP pinning, bounded responses, cancellation, timeouts, and temporary full-output paths.
- Actionable errors when no matching providers are available, with deduplicated and Pi-bounded tool output.
