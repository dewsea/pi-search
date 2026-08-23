# Changelog

This file is the authoritative user-facing release history for `@hyav/pi-search`.

## Unreleased

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
