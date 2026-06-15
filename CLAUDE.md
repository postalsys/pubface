# Claude Development Guidelines

## Project Overview

pubface resolves the public-facing network interfaces of the current machine.
For each non-internal local interface it makes an outbound HTTPS request (bound
to that local address) to a resolver service - by default
`https://api.nodemailer.com/` - to learn the public IP address the outside world
sees, then performs a reverse-DNS (PTR) lookup on that IP. It returns an array of
`{ localAddress, ip, name, family, defaultInterface }` entries.

It ships in two forms:

- A CommonJS module exposing `resolvePublicInterfaces()`.
- A `pubface` CLI that prints the resolved interfaces as JSON, also distributed
  as prebuilt standalone binaries.

pubface is a dependency of EmailEngine (`../emailengine`).

## Project Structure

- `index.js` - Main module. Public interface detection, DNS/PTR resolution, the
  outbound HTTPS resolver request, and result sorting. Exports
  `resolvePublicInterfaces` plus an `_internal` object used only by the tests.
- `bin/pubface.js` - CLI entry point (calls `resolvePublicInterfaces` and prints
  JSON).
- `test/index.test.js` - Test suite (Node.js native test runner).
- `eslint.config.mjs` - Flat ESLint config.
- `package.json` - Also holds the `pkg` build configuration (binary targets).

## Technology Stack

- **Runtime**: Node.js (CommonJS, no build step for the library itself)
- **Dependencies**: `ipaddr.js` (IP parsing), `nodemailer` (the `nodemailer/lib/fetch`
  helper is used for the bound outbound HTTPS request)
- **License**: MIT No Attribution (MIT-0)

## Development Commands

```
npm test           # Run the test suite (node --test 'test/**/*.test.js')
npm run lint       # Lint with ESLint
npm run format     # Format code with Prettier
npm run update     # Refresh dependencies (see Dependency Management)
npm run licenses   # Regenerate licenses.txt from production dependencies
npm run build-source   # Reinstall production-only deps for a binary build
npm run build-dist     # Build standalone binaries with @yao-pkg/pkg (Brotli compressed)
npm run build-dist-fast  # Build binaries without compression (faster, for debugging)
```

## Testing

- Uses the Node.js native test runner (`node:test`) with `node:assert/strict`.
- Tests live in `test/` and are matched by the `test/**/*.test.js` glob.
- Tests are hermetic: network, DNS, and `os.networkInterfaces()` are mocked via
  `node:test` mocks, so no live network access is required. Keep them that way -
  new tests must not depend on real DNS or the live resolver service.
- Helper functions are exported through `module.exports._internal` purely so the
  tests can exercise them; this object is not part of the public API.

## Packaging (@yao-pkg/pkg)

We package pubface into standalone executables with
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) (the maintained fork of the now
unmaintained `vercel/pkg`). The build configuration and target list live under
the `pkg` key in `package.json`; binaries target Node 24 for Linux x64, macOS
x64, macOS arm64, and Windows x64 and are written to `ee-dist/`.

**`@yao-pkg/pkg` only supports CommonJS.** Every runtime dependency - and the
project's own code - must be requireable as CommonJS. Do not add pure-ESM
dependencies (packages that ship only an ESM entry point with no CommonJS
fallback); they break the binary build even when they work fine under plain
`node`. When evaluating or upgrading a dependency, confirm it still exposes a
CommonJS entry point.

## Dependency Management

- `npm run update` removes `node_modules` and `package-lock.json`, runs
  `ncu -u` (npm-check-updates) to bump every dependency to its latest allowed
  version, then reinstalls.
- `.ncurc.js` controls which upgrades `ncu` is allowed to take. Add any package
  whose newer releases are pure ESM (or otherwise break the `@yao-pkg/pkg` build
  or our supported Node range) to its `reject` list, with a comment explaining
  why, so it stays pinned to its last compatible release.
- After updating dependencies, run `npm run lint` and `npm test`, and remember
  that production dependency changes are user-facing - commit them with a `fix:`
  prefix so a release is cut (see Commit Conventions).

## Releases

- Releases are managed by `release-please` (config in `release-please-config.json`
  and `.release-please-manifest.json`), driven by Conventional Commit messages on
  `master`.
- On a release, the `release` workflow publishes to npm with provenance
  (`npm publish --provenance --access public`).
- Prebuilt CLI binaries are built locally with `npm run build-dist` and attached
  to the GitHub release.

## Code Style Rules

- Never use emojis in code or documentation, only printable ASCII characters.
- Use a single hyphen-minus (`-`) as a dash in UI copy and user-facing strings.
  Never use double hyphens (`--`), em dashes, or en dashes.
- The codebase is CommonJS (`require`/`module.exports`, `'use strict'`). Keep new
  code CommonJS; do not introduce ESM syntax in files that are bundled by
  `@yao-pkg/pkg`.

## Commit Conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/) - `feat:`,
  `fix:`, `chore:`, `docs:`, etc. `release-please` relies on these prefixes to
  decide version bumps and changelog entries.
- When composing git commit messages, do not include Claude as a co-contributor.
- For commits that do not change runtime behavior (docs, comments, CI/workflow
  tweaks, formatting), append `[skip ci]` to the commit message to avoid
  triggering the GitHub Actions workflows. Exception: do not add `[skip ci]` to
  commits using a `fix:` or `feat:` prefix - those must run so the release action
  is triggered.

## After Making Code Changes

1. Run `npm run format` and `npm run lint`.
2. Run `npm test` and make sure the suite passes.
3. Consider `/simplify` to review changed code and `/security-review` to check
   for security issues before committing.
4. After pushing, check the GitHub Actions runs for the push (for example
   `gh run list --branch <branch>`) and report their status, including CodeQL. If
   a run fails for a strange or unrelated reason (for example a checkout step
   reporting "account suspended", HTTP 403, or other auth/infrastructure errors
   that have nothing to do with the change), check <https://www.githubstatus.com/>
   for an active GitHub incident before assuming the failure is caused by the
   change.

## Related Projects

- **EmailEngine** (`../emailengine`): The primary consumer of pubface and the
  source of these maintenance conventions. Keep the package-management and
  release rules here aligned with EmailEngine's.
