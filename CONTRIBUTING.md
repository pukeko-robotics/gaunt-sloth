# Contributing to Gaunt Sloth Assistant

## Scope

This project is developed on GitHub. Please use:

- Issues for bug reports, feature requests, and design discussion
- Pull requests for proposed code or documentation changes

Keep changes focused. Large or ambiguous changes should start with an Issue so the approach can be discussed before implementation.

## Before You Start

1. Check existing Issues and pull requests to avoid duplicates.
2. If you plan to change behavior, add or update tests in the same pull request.
3. Do not include secrets, API keys, or personal data in code, tests, fixtures, screenshots, or diffs.

## Development Setup

The repository currently targets Node.js 24 and npm 11 or newer.

```bash
npm ci
npm run build
```

If you need to regenerate `package-lock.json`, use the `--workspaces --include-workspace-root` flags:

```bash
npm install --workspaces --include-workspace-root
```

Plain `npm install` may omit workspace entries from the lockfile, which causes `npm ci` to fail with "Missing from lock file" errors.

Useful commands:

```bash
npm test
npm run lint
npm run lint-n-fix
npm run format
```

## Local Development Registry (optional)

The four publishable packages — `@gaunt-sloth/{core,tools,api,review}` — release
in lock-step (`packages/core/package.json` holds the authoritative version).
When iterating against downstream
consumers (`galvanized-pukeko-ai-ui`, `pukeko-robot-controller`, etc.), it is
much faster to publish dev versions to a local [Verdaccio](https://verdaccio.org)
registry than to rebuild tarballs each cycle.

### One-time setup

Start the container and register a local user (any credentials — this is a
single-user dev registry):

```bash
docker run -d -p 4873:4873 \
  -v ~/.verdaccio/config.yaml:/verdaccio/conf/config.yaml \
  --name verdaccio verdaccio/verdaccio:latest

curl -X PUT http://localhost:4873/-/user/org.couchdb.user:dev \
  -H 'Content-Type: application/json' \
  -d '{"name":"dev","password":"dev","email":"dev@local"}'
```

The response includes a token. Add it to `~/.npmrc`:

```
//localhost:4873/:_authToken=<token>
```

`~/.verdaccio/config.yaml` should disable the `npmjs` proxy for `@gaunt-sloth/*`
so local publishes are authoritative regardless of what's on npmjs (otherwise
publishing a version lower than the public `latest` is rejected). Add this rule
*before* the default `'@*/*'` block:

```yaml
packages:
  '@gaunt-sloth/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '@galvanized-pukeko/*':   # add other in-house scopes the same way
    access: $all
    publish: $authenticated
    unpublish: $authenticated

  # default scoped + unscoped rules below — leave them as shipped (proxy: npmjs)
  '@*/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs
  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs
```

Each repo that consumes the synced packages should carry a gitignored `.npmrc`
routing those scopes to localhost:

```
@gaunt-sloth:registry=http://localhost:4873
```

### Release workflow

`packages/core/package.json` is the single source of truth for the synced version:

```bash
# Bump like `npm version` — patch | minor | major or an explicit version;
# no argument means patch:
npm run release:bump
npm run release:bump -- minor
npm run release:bump -- 0.0.7   # passing the current version re-syncs without bumping

# Same as above, but also refreshes package-lock.json and commits the result:
npm run release:bump-and-commit

npm run build
npm run release:publish    # publishes core → tools → api → review to Verdaccio
```

`release:bump` writes the new version into `packages/{tools,core,api,review}`,
pins their internal `@gaunt-sloth/*` deps to that exact version (no caret —
the lock-stepped set has no useful range semantics), and rewrites
`packages/assistant`'s `@gaunt-sloth/*` pins to match without touching
assistant's own version (1.5.x is its independent user-facing semver).

Then in any downstream repo, bump its `@gaunt-sloth/*` pins to the new version
and run `npm install` — Verdaccio serves the local copy via the per-repo
`.npmrc` scope routing.

To publish to the public registry instead of Verdaccio:

```bash
REGISTRY=https://registry.npmjs.org npm run release:publish
```

## Development Expectations

- Follow the existing project structure and naming conventions.
- Prefer import aliases such as `#src/*.js` instead of relative imports where possible.
- Use project utilities instead of direct platform access:
  - `src/utils/consoleUtils.ts` for user-facing console output
  - `src/utils/systemUtils.ts` for system access
  - `src/utils/llmUtils.ts` for LLM access
- Keep architecture boundaries clear between commands, modules, providers, tools, middleware, and core runtime code.
- Avoid unrelated refactors in the same pull request unless they are necessary for the change.

## Tests

Tests are required for pull requests that change behavior, fix bugs, or add features.

- Add or update unit tests in `spec/` when changing application logic
- Add or update integration tests in `integration-tests/` when changing end-to-end behavior, command flows, provider integration, or output contracts
- If a change does not need tests, explain why in the pull request description

Before opening a pull request, run:

```bash
npm test
npm run lint
```

Integration tests are available when relevant:

```bash
npm run it <provider>
npm run it <provider> simple
```

See [integration-tests/README.md](./integration-tests/README.md) for details.

## Test Conventions

When working in `spec/`:

- Use Vitest
- Reset mocks in `beforeEach()` with `vi.resetAllMocks()`
- Import the file under test dynamically inside each test
- Mock dependencies instead of importing mocked implementations directly into the tested module

When adding release notes, follow the conventions in `release-notes/`.

## Pull Request Guidelines

PRs should be easy to review and easy to validate.

Include in the pull request description:

- What changed
- Why it changed
- How it was tested
- Any follow-up work, limitations, or risk areas

Reasonable PR checklist:

- The branch is up to date with the target branch
- The change is scoped to one problem or feature
- Tests are included when behavior changes
- `npm test` passes locally
- `npm run lint` passes locally
- Documentation is updated if user-facing behavior changed

Small, targeted pull requests are preferred over large mixed changes.

## Reporting Bugs

Open a GitHub Issue and include:

- Expected behavior
- Actual behavior
- Steps to reproduce
- Relevant logs or command output
- Environment details such as Node.js version, OS, and provider/config context

If the report involves credentials or private data, redact them before posting.

## Feature Requests

Open a GitHub Issue describing:

- The problem you are trying to solve
- The proposed user-facing behavior
- Alternatives considered, if any

## Documentation Publishing

If you need to publish project documentation, clone `gauntsloth.app` in the same parent directory as this repository and run:

```bash
./update-docs.sh
```

Commit and push from the `gauntsloth.app` repository.

## Code of Conduct

By participating in this project, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
