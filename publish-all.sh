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
# on core), then batch (depends on core+agent), then the eval-reporter tier —
# eval-reporter-junit (JUnit results.xml) and eval-reporter-teamcity (live
# TeamCity service messages), both `gth eval` reporters depending only on batch's
# types — then the fat CLI `gaunt-sloth` (dir: app) LAST — it depends on all of
# the above. The former tools/api forwarding shims were removed in the 2.0 break.
#
# NOTE the eval-reporter-* packages are INDEPENDENTLY VERSIONED: they are
# published (and git-tagged) here at their own versions (0.1.0), but they are NOT
# part of bump.mjs's version-sync (SYNCED). The @gaunt-sloth/eval-reporter-*
# plugin family is versioned on its own track and bumped by hand. The loop
# below reads each package's own name+version from its package.json, so it ships
# e.g. @gaunt-sloth/eval-reporter-junit@0.1.0 regardless. app's `workspace:*` deps
# on them are rewritten to the concrete versions by pnpm at pack time, so the
# install resolves even though they ride the same alpha dist-tag as the synced set.
ORDER=(core agent review batch eval-reporter-junit eval-reporter-teamcity app)

# Each package's npm dist-tag (publish CHANNEL) is derived from THAT package's OWN
# version, per package, inside the loop below (see scripts/dist-tag.mjs): a
# prerelease (2.0.0-alpha.0) maps to its alpha/beta/rc id; a plain release (0.1.1)
# maps to `latest`. Deriving per package is what lets the INDEPENDENTLY-versioned,
# stable-`0.x` eval-reporter-* tier land on `latest` while the version-locked
# synced set rides its prerelease channel — a single core-derived tag applied to
# every package is exactly what stranded a stable reporter under `--tag alpha`
# (OPS-22). Because the synced set is version-locked to core, own-version
# derivation yields the same channel it always had.
#
# We pass the tag as an EXPLICIT `--tag` because npm (>=11) does NOT reliably
# honour `publishConfig.tag` for a bare publish — relying on it would route a
# prerelease to `latest` and hijack the stable channel. The explicit flag is the
# real guard (publishConfig.tag stays as defence-in-depth).
#
# The derivation lives in a tiny, dependency-free node helper — NO `semver`
# (REL-4). `semver` is only a *transitive* dep, so `require('semver')` could fail
# to hoist and, under `set -euo pipefail`, abort the whole publish before anything
# ships. The helper reads a plain version string; the prerelease id is the part
# after the first `-`, up to the first `.`. A plain release, a numeric-only id, or
# an empty parse all fall back to `latest`.
#
# NOTE the CI caller passes NPM_PUBLISH_ARGS="--access public --provenance"
# WITHOUT a `--tag`: the per-package `--tag` computed below is authoritative, so a
# global `--tag` must NOT be re-added there or it would double the flag and
# re-hijack `latest` for the reporters.
DIST_TAG_HELPER="${ROOT}/scripts/dist-tag.mjs"

echo "Publishing Gaunt Sloth packages to ${REGISTRY} (dist-tag derived per package)"
for dir in "${ORDER[@]}"; do
  name="$(node -p "require('${ROOT}/packages/${dir}/package.json').name")"
  version="$(node -p "require('${ROOT}/packages/${dir}/package.json').version")"
  # Derive THIS package's dist-tag from its OWN version (the OPS-22 fix): the
  # synced set yields its prerelease channel, the stable-0.x eval-reporter-* tier
  # yields `latest`.
  dist_tag="$(node "${DIST_TAG_HELPER}" "${version}")"
  # Idempotency guard (npmjs only): skip a version that is already on the registry.
  # Two real cases: (a) a re-dispatch after a mid-loop failure — the packages that
  # DID ship must not abort the retry (npm answers a republish with E403, and
  # `set -e` would kill the run at the first already-published package, exactly
  # what stranded the 2.0.0-alpha.21 run); (b) the independently-versioned
  # eval-reporter-* packages, whose versions only move when bumped by hand — every
  # release between their bumps must skip them, not die on them. `npm view` prints the
  # version iff that exact version exists; any lookup failure leaves `published`
  # empty and we attempt the publish as before. Scoped to the real registry so the
  # local Verdaccio flow (which proxies npmjs and would false-positive) is untouched.
  if [[ "${REGISTRY}" == "https://registry.npmjs.org" ]]; then
    published="$(npm view "${name}@${version}" version --registry "${REGISTRY}" 2>/dev/null || true)"
    if [[ "${published}" == "${version}" ]]; then
      echo "==> ${name}@${version} already on ${REGISTRY} — skipping"
      continue
    fi
  fi
  echo "==> ${name}@${version}  --tag ${dist_tag}"
  # NPM_PUBLISH_ARGS is intentionally left unquoted so multiple flags split into
  # separate arguments; it defaults to empty for the plain local Verdaccio path
  # (where the per-package `--tag ${dist_tag}` still follows each version).
  #
  # We publish with `pnpm publish`, NOT `npm publish`: internal cross-deps use the
  # `workspace:*` protocol, and ONLY pnpm rewrites `workspace:*` to the concrete
  # version (e.g. 2.0.0-alpha.2) in the published tarball. `npm publish` would ship
  # the literal "workspace:*" specifier — an unresolvable, broken package.
  # `--no-git-checks` is required because pnpm otherwise refuses to publish from a
  # non-release branch / dirty tree (we gate releases via the CI pipeline instead).
  # shellcheck disable=SC2086
  (cd "${ROOT}/packages/${dir}" && pnpm publish --registry "${REGISTRY}" --no-git-checks --tag "${dist_tag}" ${NPM_PUBLISH_ARGS:-})
done
echo "Done."
