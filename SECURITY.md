# Security Policy

`@hyav/pi-search` is a Pi extension. Its TypeScript source runs with the user's system privileges, sends queries and URLs to configured Provider services, reads API keys from environment variables or local configuration, and writes oversized results to temporary files. Custom provider adapters under `<agent-dir>/extensions/pi-search/providers/` are user-supplied code that runs with the same privileges as the extension itself. Review the source and package artifact before installing extensions or adapters from untrusted sources.

## Supported versions

| Version or branch | Support |
|---|---|
| Latest published release | Best-effort security fixes |
| Older published releases | Not supported |
| Unreleased `main` | No compatibility or response-time promise |

There is no long-term-support branch. Upgrade to the latest release before reporting whether an issue is still present.

## Reporting a vulnerability

Do **not** report suspected vulnerabilities in a public issue, pull request, chat, or forum.

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/hyav/pi-search/security/advisories/new). Include:

- affected package version, commit, or published artifact;
- reproduction steps or a minimal proof of concept;
- impact, prerequisites, and affected trust boundary;
- logs or traces with API keys, tokens, queries, private URLs, and personal data removed;
- a safe way to contact you for follow-up.

## Response and disclosure

Reports are handled on a best-effort basis; no acknowledgement, remediation, or disclosure deadline is guaranteed. The maintainer will coordinate a fix and public disclosure when affected users have a reasonable mitigation or upgrade path. Please do not publish details before then.

## Scope

This policy covers the source repository, the published `@hyav/pi-search` npm artifact, Provider routing, configuration and credential handling, user-supplied adapter code under `<agent-dir>/extensions/pi-search/providers/`, public URL validation, request deadlines and cancellation, response-size limits, and temporary output handling. Vulnerabilities in Pi, a Provider service, npm, GitHub, or another dependency should also be reported to the relevant upstream maintainer.

For ordinary defects and usage questions, use the [public issue tracker](https://github.com/hyav/pi-search/issues).

