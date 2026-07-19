#!/usr/bin/env bash
# Publish the locked Gaunt Sloth packages in topological order.
#
# Defaults to the local Verdaccio at http://localhost:4873.
# To publish to npmjs:  REGISTRY=https://registry.npmjs.org ./publish-all.sh
#
# Extra flags can be passed to every `npm publish` via NPM_PUBLISH_ARGS, e.g. the
# CI release workflow uses NPM_PUBLISH_ARGS="--access public --provenance".
#
# Versions must already be in sync — run `npm run release:bump` first.

set -euo pipefail

REGISTRY="${REGISTRY:-http://localhost:4873}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Topological order, by package DIRECTORY: core first (everything depends on it),
# then agent (the merged tools+api runtime; depends on core) and review (depends
# on core), then batch (depends on core+agent), then the fat CLI `gaunt-sloth`
# (dir: app) LAST — it depends on all four. The former tools/api forwarding shims
# were removed in the 2.0 break.
ORDER=(core agent review batch app)

# Derive the dist-tag from the CURRENT version (source of truth: packages/core),
# same rule as .github/workflows/release.yml: a prerelease (2.0.0-alpha.0) maps to
# its alpha/beta/rc id; a plain release maps to `latest`. We pass this as an
# EXPLICIT `--tag` because npm (>=11) does NOT reliably honour `publishConfig.tag`
# for a bare publish — relying on it would route a prerelease to `latest` and
# hijack the stable channel. The explicit flag is the real guard (publishConfig
# stays as defence-in-depth). If the caller already passed `--tag` via
# NPM_PUBLISH_ARGS (the CI workflow does), we don't add a second one.
#
# The derivation is a tiny INLINE parse — no `semver` (REL-4). `semver` is only a
# *transitive* dep, so `require('semver')` could fail to hoist and, under
# `set -euo pipefail`, abort the whole publish before anything ships. Reading the
# version from the package's own package.json (its own file, not a transitive dep)
# is safe; the prerelease id is the part after the first `-`, up to the first `.`.
# A plain release, a numeric-only id, or an empty parse all fall back to `latest`.
CORE_VERSION="$(node -p "require('${ROOT}/packages/core/package.json').version")"
DIST_TAG="latest"
if [[ "${CORE_VERSION}" == *-* ]]; then
  pre="${CORE_VERSION#*-}"   # 2.0.0-alpha.0 -> alpha.0
  pre="${pre%%.*}"          #              -> alpha
  # a real channel is a non-empty, non-numeric identifier; else stay on latest
  if [[ -n "${pre}" && ! "${pre}" =~ ^[0-9]+$ ]]; then
    DIST_TAG="${pre}"
  fi
fi
TAG_ARG=""
if [[ "${NPM_PUBLISH_ARGS:-}" != *"--tag"* ]]; then
  TAG_ARG="--tag ${DIST_TAG}"
fi

echo "Publishing Gaunt Sloth packages to ${REGISTRY} (dist-tag: ${DIST_TAG})"
for dir in "${ORDER[@]}"; do
  name="$(node -p "require('${ROOT}/packages/${dir}/package.json').name")"
  version="$(node -p "require('${ROOT}/packages/${dir}/package.json').version")"
  echo "==> ${name}@${version}  --tag ${DIST_TAG}"
  # TAG_ARG + NPM_PUBLISH_ARGS are intentionally left unquoted so multiple flags
  # split into separate arguments; both default to empty for the plain local
  # Verdaccio path (where everything is a prerelease → tag follows the version).
  #
  # We publish with `pnpm publish`, NOT `npm publish`: internal cross-deps use the
  # `workspace:*` protocol, and ONLY pnpm rewrites `workspace:*` to the concrete
  # version (e.g. 2.0.0-alpha.2) in the published tarball. `npm publish` would ship
  # the literal "workspace:*" specifier — an unresolvable, broken package.
  # `--no-git-checks` is required because pnpm otherwise refuses to publish from a
  # non-release branch / dirty tree (we gate releases via the CI pipeline instead).
  # shellcheck disable=SC2086
  (cd "${ROOT}/packages/${dir}" && pnpm publish --registry "${REGISTRY}" --no-git-checks ${TAG_ARG} ${NPM_PUBLISH_ARGS:-})
done
echo "Done."
