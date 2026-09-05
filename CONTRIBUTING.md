# Contributing

Thank you for helping improve `@hyav/pi-search`. The canonical user contract is in [README.md](README.md).

## Before you start

- Search existing [GitHub issues](https://github.com/hyav/pi-search/issues) before opening a new one.
- For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of using a public issue.
- Keep changes focused. Do not commit credentials, personal data, private query strings, generated output, or unrelated formatting changes.

## Development setup

The supported development environment is Node.js `22.19.0` or later with npm and the tested Pi `0.84.1` host:

```sh
npm ci --ignore-scripts
```

The repository intentionally publishes TypeScript source files because Pi loads them through its extension loader. Do not add a compiled `dist/` tree unless the public package contract is deliberately changed and documented.

## Required checks

Run the same deterministic gate used by CI:

```sh
npm run audit:runtime
npm run audit:all
npm run check
npm test
npm run artifact:check
```

- `npm run audit:runtime` checks the published dependency boundary for high-severity advisories.
- `npm run audit:all` also checks development and tested-host dependencies.
- `npm run check` runs Biome and TypeScript type checking across `src/`, `test/`, and `index.ts`.
- `npm test` runs mocked behavior, public contract, and package-boundary tests.
- `npm run artifact:check` verifies the real npm tarball and loads its published Pi tools against the tested host API.

The ordinary gate must not call live Provider search or extraction APIs or require API keys. Provider-specific integration tests that hit third-party network services are opt-in and do not belong in the default test suite.

## Changes and review

- Public behavior changes must include behavior-focused tests and documentation updates.
- Built-in providers use the same `defineProvider()` adapter shape as user adapters; the file-level plug-and-play contract lives in the [adapter extension contract](https://github.com/hyav/pi-search/blob/v0.2.0/docs/adapter-extensions.md) (also in Chinese) and must stay in sync with `src/adapter-api.ts` validation rules.
- Keep `README.md` canonical and update `README.zh-CN.md` when user-visible behavior changes.
- Update [CHANGELOG.md](CHANGELOG.md) for release-relevant behavior, compatibility, security, or migration changes.
- Preserve the package boundary in `package.json.files`; tests, documentation, and maintainer adapters must not enter the npm artifact.
- Keep direct Pi core imports in `peerDependencies` with a `"*"` range and pin their tested versions in `devDependencies`; Pi supplies these packages at runtime.
- Treat URLs, queries, headers, and fetched content as untrusted input. Maintain SSRF validation, output bounds, cancellation, and temporary-output limits.

## Reporting defects

Use a public [GitHub issue](https://github.com/hyav/pi-search/issues) for ordinary defects and include, when safe:

- package version or commit;
- Node.js, Pi, and Provider versions;
- search query or URL, with private domains and credentials removed;
- expected and actual behavior;
- a minimal reproduction and relevant redacted logs.

Do not disclose vulnerability details publicly; use [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is provided under the repository's [MIT License](LICENSE).
