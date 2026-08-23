# Search provider adapter references

This directory contains complete, non-built-in provider adapter references for `@hyav/pi-search`.

They intentionally live outside `src/providers/`, so installing the package does not load or enable them by default. The npm package also excludes this repository-only `examples/` tree.

## Included adapters

| Provider | Capabilities | Required environment variable | Optional environment variable |
|---|---|---|---|
| DeepSeek | Search | `DEEPSEEK_API_KEY` | `DEEPSEEK_SEARCH_MODEL` |
| Doubao Search | Search | `DOUBAO_SEARCH_API_KEY` | — |
| Exa | Search, extraction | `EXA_API_KEY` | — |
| Firecrawl | Extraction | `FIRECRAWL_API_KEY` | — |
| Gemini | Search | `GEMINI_API_KEY` | `GEMINI_SEARCH_MODEL` |
| iFlow | Search, extraction | `IFLOW_API_KEY` | — |
| Serper | Search | `SERPER_API_KEY` | — |

## Install as user adapters

Copy any adapters you want into the resolved Pi agent directory:

```text
<agent-dir>/extensions/pi-search/
  config.json             # optional
  providers/
    deepseek.ts
    doubao.ts
    exa.ts
    firecrawl.ts
    gemini.ts
    iflow.ts
    serper.ts
```

For example:

```sh
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/pi-search/providers"
cp examples/search-providers/providers/exa.ts \
  "$agent_dir/extensions/pi-search/providers/exa.ts"
```

If `PI_CODING_AGENT_DIR` is unset, Pi normally resolves the agent directory as `~/.pi/agent`.

Provide credentials through the environment variables above, or through `<agent-dir>/extensions/pi-search/config.json` using the adapter `name` as the key:

```json
{
  "apiKeys": {
    "doubao": "...",
    "exa": "..."
  }
}
```

Environment variables take precedence. Keep credential files readable only by your user and never commit keys. Restart Pi after changing inherited environment variables, or update `config.json`, then run `/reload` so the adapter files and tool schemas are rediscovered.

The provider names used by `web_search` or `web_fetch` are `deepseek`, `doubao`, `exa`, `firecrawl`, `gemini`, `iflow`, and `serper`.

## Scope and security

These are reference integrations, not built-in providers. Their upstream APIs, models, fields, pricing, quotas, and availability can change independently of pi-search. The ordinary repository test suite uses mocked responses and never spends provider quota.

Adapter files execute with the user's full system privileges. Review them before installation, use only trusted credentials, and verify each provider's current pricing and data policy.
