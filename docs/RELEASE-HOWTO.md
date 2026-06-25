# Release HOWTO

## Creating npm version

Good habit is to ask Gaunt Sloth to review changes before releasing them:

```bash
git --no-pager diff v0.8.3..HEAD | gth review
```

Make sure `npm config set git-tag-version true`

! Important ! The `files` block of package.json strictly controls what is actually released,
the `files` makes .npmignore ignored.

### Library packages

Library packages (`@gaunt-sloth/core`, `@gaunt-sloth/tools`, `@gaunt-sloth/api`,
`@gaunt-sloth/review`) are lock-stepped: they all carry the same version, with
`packages/core/package.json` as the source of truth. `npm version` does not
work well in workspaces for scoped packages, so use the bump script:

```bash
npm run release:bump                # patch-increment core's version AND sync the rest
npm run release:bump -- minor       # increment patch | minor | major AND sync
npm run release:bump -- 0.1.8       # set an explicit version AND sync
npm run release:bump-and-commit     # same, then refresh package-lock.json and commit
```

The script rewrites each package's `"version"` and their exact pins on each
other, and updates the assistant's `@gaunt-sloth/*` dependency pins (the
assistant's own version is untouched). Commit the result before publishing —
`release:bump-and-commit` does that for you, including the lockfile refresh
(`npm install --package-lock-only`) that keeps the next `npm ci` happy.

### Publishing library packages (CI, recommended)

Dispatch the **Publish packages** workflow
([publish-packages.yml](../.github/workflows/publish-packages.yml)) from the
Actions tab. It runs lint + unit tests, integration tests (Linux, then
macOS/Windows), pushes the `@gaunt-sloth/<pkg>@<version>` git tags via
`tag-packages.sh`, and publishes all four packages to npmjs using npm Trusted
Publishing (OIDC) — no token involved. Each package's Trusted Publisher on
npmjs must point at this repo and `publish-packages.yml`.

Bump and commit first (see above): npm refuses to republish an existing
version, so dispatching without a fresh version fails at the publish stage.

### Publishing library packages (manually)

Tags follow the `@scope/name@version` convention (same as npm) and must be
annotated (`-a`) — lightweight tags are not pushed by `--follow-tags`. The
helper reads each library's current `package.json` version and tags all four
(`core`, `tools`, `api`, `review`) — the assistant is excluded. Existing tags
are skipped, so it's safe to re-run:

```bash
./tag-packages.sh            # create the tags locally
./tag-packages.sh --push     # create and push them (PUSH=1 ./tag-packages.sh also works)
```

Preview what will be included in each package:

```bash
npm pack --dry-run -w @gaunt-sloth/core
npm pack --dry-run -w @gaunt-sloth/tools
npm pack --dry-run -w @gaunt-sloth/api
npm pack --dry-run -w @gaunt-sloth/review
```

Publish all four in dependency order (core → tools → api → review). The script
defaults to a local Verdaccio at `http://localhost:4873`
(see [CONTRIBUTING.md](../CONTRIBUTING.md#local-development-registry-optional));
set `REGISTRY` to target npmjs:

```bash
REGISTRY=https://registry.npmjs.org npm run release:publish
```

Note: the first ever publish of a scoped package requires `--access public`
(pass it via `NPM_PUBLISH_ARGS="--access public"`). After that it's not needed.

### Test-deploying library packages

See [TEST-DEPLOY.md](TEST-DEPLOY.md) for how to test-deploy `@gaunt-sloth/review`
as a standalone global install before publishing.

### Assistant package

The CLI `gaunt-sloth` lives in `packages/assistant` and carries its
own version (tagged `vX.Y.Z`), independent of the lock-stepped `@gaunt-sloth/*`
libraries. The repo root (`gaunt-sloth-workspace`) is `private` and is **never
published** — `npm version` / `npm publish` run at the root do not touch the
assistant.

Bump the assistant inside its workspace. npm does **not** auto-commit or tag for
workspace members, so commit and tag yourself:

```bash
npm version patch -w gaunt-sloth   # or minor / major — edits packages/assistant/package.json only
git commit -am "Release notes"
git tag -a v1.5.1 -m "Release notes"
git push --tags
```

Type `\` and then Enter to type a new line in the message.

## Publish Release to GitHub (assistant only)

Library packages don't need GitHub releases — they're consumed as npm
dependencies, so npm is the distribution channel. Git tags provide
version history in the repo.

Note the release version from pervious step and do

(if you have multiple accounts in gh, you may need to do `gh auth switch`)

```bash
gh release create --notes-from-tag
```

or

```bash
gh release create --notes-file pathToFile
```

Alternatively `gh release create --notes "notes"`

## Publish to NPM (optional)

This step is now automated, and GitHub action publishes any new release with Release action.

### Publishing the assistant package

The repo root is `private`, so publish from the assistant workspace — `npm publish`
at the root will refuse:

```bash
npm login
npm publish -w gaunt-sloth
```

Remember to review a list of files in the build, before confirming it.

## Viewing diff side by side

Configure KDE diff Kompare as github difftool

```bash
# Configure default git diff tool
git config --global diff.tool kompare
# Compare all changed files
git difftool v0.9.3 HEAD -d
```

Configure vimdiff

```bash
# Configure default git diff tool
git config --global diff.tool vimdiff
# Compare changed files one by one
git difftool v0.9.3 HEAD
```

## Cleaning up the mess

Delete incidental remote and local tag

```bash
git tag -d v0.3.0
git push --delete origin v0.3.0
```
