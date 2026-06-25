# Test Deploy for @gaunt-sloth/review

Scripts for testing `@gaunt-sloth/review` as a standalone global install,
without workspace hoisting leaking in transitive dependencies from other packages
(e.g. `gaunt-sloth`).

## Bumping versions before deploy

Before the first test-deploy, bump versions ahead of what's published on npm.
Edit the `"version"` field directly in `packages/core/package.json` and
`packages/review/package.json`. Also update the `@gaunt-sloth/core` dependency
version in `packages/review/package.json` to match.

Don't use `npm version` — that creates tags and commits. For test-deploy
iterations you want just the version number change, no tags.

You only need to bump once — after that, re-run `./test-deploy.sh` as many
times as needed while iterating. The tarball is rebuilt from source each time.

See [RELEASE-HOWTO.md](RELEASE-HOWTO.md) for the full release and tagging process.

## Deploy

From the workspace root:

```bash
./test-deploy.sh
```

This will:

1. Build the workspace
2. Pack `@gaunt-sloth/core` and `@gaunt-sloth/review` into tarballs
3. Create `../gaunt-sloth-review-test-deploy/` as a clean staging directory
4. Copy `package-lock.json` for deterministic resolution
5. Install both tarballs locally in staging (resolves transitive deps)
6. Install `@gaunt-sloth/review` globally from the staging `node_modules`

After running, test with:

```bash
gaunt-sloth-review <pr-number> [requirements...]
```

## Undeploy

```bash
./test-undeploy.sh
```

This removes `@gaunt-sloth/review` and `@gaunt-sloth/core` from global
node_modules and deletes the `../gaunt-sloth-review-test-deploy/` staging
directory.

## Why a staging directory?

Installing a tarball globally with `npm install -g file.tgz` resolves
dependencies from the npm registry. If `@gaunt-sloth/core` hasn't been
published yet (or is at a different version), transitive deps won't resolve.

The staging directory installs both tarballs locally first, then
`npm install -g node_modules/@gaunt-sloth/review` picks up the real
package with all dependencies already resolved.
