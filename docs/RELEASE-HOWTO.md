# Release HOWTO

## Creating npm version

Good habit is to ask Gaunt Sloth to review changes before releasing them:

```bash
git --no-pager diff v0.8.3..HEAD | gth review
```

Make sure `npm config set git-tag-version true`

! Important ! The `files` block of package.json strictly controls what is actually released,
the `files` makes .npmignore ignored.

### Unified, locked versioning (all four packages)

As of v2 **all four packages release in lockstep at one version**:

- `@gaunt-sloth/core`, `@gaunt-sloth/agent`, `@gaunt-sloth/review` (the scoped libraries), and
- `gaunt-sloth` — the fat user-facing CLI (dir `packages/app`; the package **name** is
  `gaunt-sloth`, not `@gaunt-sloth/assistant`). The former `@gaunt-sloth/tools` and
  `@gaunt-sloth/api` were merged into `@gaunt-sloth/agent` in the 2.0 break.

`packages/core/package.json` is the source of truth for the version. `npm version` does not work
well in workspaces for scoped packages, so use the bump script. Version computation uses
`semver.inc(current, releaseType, preid)` — the same engine npm uses:

```bash
npm run release:bump                          # patch-increment core's version AND sync all four
npm run release:bump -- minor                 # patch | minor | major AND sync
npm run release:bump -- prerelease alpha      # walk the prerelease counter on the alpha channel
npm run release:bump -- preminor alpha        # open the next minor's alpha line
npm run release:bump -- 2.0.0-alpha.0         # set an explicit version AND sync
npm run release:bump-and-commit -- <args>     # same, then refresh package-lock.json and commit
```

Release types: `patch | minor | major | prepatch | preminor | premajor | prerelease`, plus an
explicit `MAJOR.MINOR.PATCH[-prerelease]`. An optional preid (`alpha | beta | rc`) applies to the
`pre*`/`prerelease` verbs.

The script rewrites each package's `"version"`, the scoped libraries' exact pins on each other,
and the fat CLI's `@gaunt-sloth/*` dependency pins. It also writes `publishConfig.tag` into **all
four** package.jsons, derived from the new version: a prerelease (`2.0.0-alpha.0`) gets its preid
(`alpha`/`beta`/`rc`) as the tag; a stable version gets `latest`. This is the `latest`-hijack
guard (see below). Commit the result before publishing — `release:bump-and-commit` does that for
you, including the lockfile refresh (`npm install --package-lock-only`) that keeps the next
`npm ci` happy.

### Prereleases never take `latest`

`npm publish` defaults to `--tag latest` for **every** version regardless of any prerelease
suffix. Two guards keep a prerelease (`-alpha`/`-beta`/`-rc`) off `latest`:

1. **`publishConfig.tag`** in each package.json (written by the bump script) — so even a bare
   `npm publish` routes to the prerelease channel.
2. **Explicit `--tag <dist-tag>`** in the release pipeline, derived from the resulting version.

A stable version derives `latest`; a prerelease derives its preid.

### Releasing — the consolidated pipeline (CI, recommended)

**One workflow, [release.yml](../.github/workflows/release.yml), replaces the old `publish.yml`
and `publish-packages.yml`.** Dispatch it from the Actions tab via the "Run workflow" button. It
is `workflow_dispatch` (not `release: published`) so the tag + GitHub Release are created **last**,
only after every gate is green. Job graph:

```
lint+unit  ->  integration-tests (big provider)
           ->  integration-tests-platforms (macOS + Windows)
           ->  release   (ship CURRENT version, THEN post-bump main to next)
```

#### Versioning model: "release CURRENT, then post-bump to next"

**The invariant: `main` HEAD always carries the *next* version to publish.** A release run ships
whatever version is currently in `package.json`, and **only after a successful publish** does it
bump to the next version, commit, and push that commit to `main`.

This makes a run **idempotent at the version level**:

- If the publish step fails, the version in `main` is **unchanged** — re-dispatching the workflow
  simply **retries the same version**.
- If the publish succeeds, the version has **moved on** — so the just-shipped version can never be
  re-shipped by a later run.

Step order inside the `release` job:

1. Checkout `main` (`fetch-depth: 0`), setup Node, `npm ci`, configure git identity.
2. **Read the CURRENT version** from `packages/core/package.json` — this is what ships.
3. **Derive the dist-tag** from the *current* version (prerelease suffix → its preid; else `latest`).
4. `npm run build`.
5. `./tag-packages.sh --push` — tags the current version (skips already-existing tags, so a
   re-dispatch of the same version is safe).
6. `gh release create v<current>` (`--prerelease` when the current version has a prerelease suffix).
7. **Publish all four** at the current version with `--tag <derived>`.
8. **Only after publish succeeds:** post-bump — `npm run release:bump-and-commit` driven by the
   dispatch inputs, then `git push origin HEAD:main`.

#### The dispatch inputs describe the POST-bump, not the version shipped

The "Run workflow" form has three inputs. They control the **next** version (the increment applied
*after* this release), **not** the version being released now:

- **`bump`** — the semver verb applied as the post-bump: `patch | minor | major | prepatch |
  preminor | premajor | prerelease | explicit`. **Default `prerelease`.**
- **`preid`** — `alpha | beta | rc`; only used by the `pre*`/`prerelease` verbs. Default `alpha`.
- **`explicit_version`** — an exact NEXT version (e.g. `2.0.0-alpha.0`); only used when
  `bump = explicit`.

#### One-time seed (before the very first release)

Because a run ships the *current* version, `main` must already carry a version to ship. Seed it
**once**, locally, before the first dispatch:

```bash
npm run release:bump-and-commit -- 2.0.0-alpha.0   # then push main
```

`premajor` from `0.1.8` would yield `1.0.0-alpha.0`, not `2.0.0` — we're skipping a whole major
(0→2) as a one-time unification jump, so the seed is set explicitly. After this seed, the first
dispatch ships `2.0.0-alpha.0` and post-bumps `main` to whatever the inputs say.

#### The lifecycle from one dropdown

With the seed in place, each dispatch ships the version on `main` and leaves the *next* version
there. The "from" column is what `main` carries when you press the button (= what ships); "leaves
on main" is the post-bump result that the **next** run will ship.

| run | from (ships now) | dist-tag | post-bump inputs | leaves on main (ships next) |
| --- | --- | --- | --- | --- |
| seed | — | — | (local) `explicit` `2.0.0-alpha.0` | `2.0.0-alpha.0` |
| 1 | `2.0.0-alpha.0` | alpha | `prerelease` `alpha` (default) | `2.0.0-alpha.1` |
| 2 | `2.0.0-alpha.1` | alpha | `prerelease` `alpha` | `2.0.0-alpha.2` |
| … | … | alpha | `prerelease` `alpha` | … |
| last alpha | `2.0.0-alpha.3` | alpha | `prerelease` `beta` | `2.0.0-beta.0` |
| last beta | `2.0.0-beta.1` | beta | `prerelease` `rc` | `2.0.0-rc.0` |
| last rc (GA prep) | `2.0.0-rc.2` | rc | `patch` *(finalizes)* | `2.0.0` |
| GA | `2.0.0` | **latest** | `preminor` `alpha` | `2.1.0-alpha.0` |
| stable patch | `2.0.0` | latest | `patch` | `2.0.1` |

The key mental shift from a "compute target, then release" model: **channel moves and finalize are
chosen on the run that ships the *last* of the previous channel.** Shipping the last alpha with a
post-bump of `prerelease`+`beta` leaves `2.0.0-beta.0` on `main`, so the next run ships the first
beta. Likewise, finalizing happens by post-bumping with `patch` on the run that ships the last rc —
that run ships `2.0.0-rc.2` and leaves `2.0.0` on `main` for the GA run.

#### Idempotency caveat (accepted): mid-publish npm outage

The version-level idempotency above protects against re-shipping, but `publish-all.sh` publishes
the four packages sequentially and has **no auto-skip** of already-published versions (deliberate).
If an npm outage interrupts mid-publish, some of the four may be live and others not. Re-dispatching
would fail on the already-published ones. **Recovery is manual** and accepted: publish the
remaining stragglers by hand at the same current version, e.g.

```bash
REGISTRY=https://registry.npmjs.org \
  NPM_PUBLISH_ARGS="--access public --provenance --tag <derived>" \
  npm publish -w <straggler-package>
```

then re-create the tag/release/post-bump steps as needed. This trade-off (manual straggler
recovery in a rare outage) was chosen over baking skip-if-published logic into `publish-all.sh`.

The `release` job uses npm Trusted Publishing (OIDC) — no token. Each package's Trusted Publisher
on npmjs must point at this repo and `release.yml`.

### Releasing manually

Bump and commit first (see above): npm refuses to republish an existing version.

Tags follow the `<name>@<version>` convention (npm monorepo style) and are annotated. The helper
reads each package's current `package.json` and tags all four — `@gaunt-sloth/core@<v>`,
`@gaunt-sloth/agent@<v>`, `@gaunt-sloth/review@<v>`, and `gaunt-sloth@<v>` for the fat CLI.
Existing tags are skipped, so it's safe to re-run:

```bash
./tag-packages.sh            # create the tags locally
./tag-packages.sh --push     # create and push them (PUSH=1 ./tag-packages.sh also works)
```

Preview what will be included in each package:

```bash
npm pack --dry-run -w @gaunt-sloth/core
npm pack --dry-run -w @gaunt-sloth/agent
npm pack --dry-run -w @gaunt-sloth/review
npm pack --dry-run -w gaunt-sloth
```

Publish all four in dependency order (core → agent → review → `gaunt-sloth`). The script defaults
to a local Verdaccio at `http://localhost:4873`
(see [CONTRIBUTING.md](../CONTRIBUTING.md#local-development-registry-optional)); set `REGISTRY` to
target npmjs:

```bash
REGISTRY=https://registry.npmjs.org npm run release:publish
```

Note: the first ever publish of a scoped package requires `--access public` (pass it via
`NPM_PUBLISH_ARGS="--access public"`). After that it's not needed. To force a dist-tag for a
prerelease when running manually, add `--tag <alpha|beta|rc>` to `NPM_PUBLISH_ARGS`
(`publishConfig.tag` already covers this, but the explicit flag is belt-and-suspenders).

### Test-deploying library packages

See [TEST-DEPLOY.md](TEST-DEPLOY.md) for how to test-deploy `@gaunt-sloth/review`
as a standalone global install before publishing.

## GitHub Release

The consolidated pipeline creates the GitHub Release automatically (`gh release create
v<version>`, with `--prerelease` for prerelease versions) as its last step. You normally don't
create releases by hand. If you ever need to:

(if you have multiple accounts in gh, you may need to do `gh auth switch`)

```bash
gh release create v<version> --generate-notes        # or --notes-from-tag / --notes-file / --notes
```

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
