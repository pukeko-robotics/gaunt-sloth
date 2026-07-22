#!/usr/bin/env bash
# Create git tags for the released Gaunt Sloth packages. The locked FIVE:
# @gaunt-sloth/{core,agent,review,batch} and the fat CLI `gaunt-sloth` (dir app)
# all share one synced version. PLUS the independently-versioned reporter plugins
# @gaunt-sloth/eval-reporter-junit and @gaunt-sloth/eval-reporter-teamcity (dirs
# eval-reporter-junit / eval-reporter-teamcity) — tagged here at their OWN
# versions (0.1.0), NOT part of the synced five (bump.mjs never touches them; the
# @gaunt-sloth/eval-reporter-* plugin family is bumped by hand).
#
# Tags are annotated and named "<package-name>@<version>" (npm monorepo
# convention): "@gaunt-sloth/core@<v>", …, and "gaunt-sloth@<v>" for the fat
# CLI. The fat package's "gaunt-sloth@<v>" tag is distinct from the repo's
# historical "v<MAJOR.MINOR.PATCH>" tags, so they don't collide. Versions are
# read straight from each package.json — run `npm run release:bump` first so the
# locked set is at the version you want to tag (the reporter carries its own).
#
# Local only by default. Push with:  PUSH=1 ./tag-packages.sh
#                               or:  ./tag-packages.sh --push

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Packages to tag, by DIRECTORY — the locked set (same as bump.mjs) plus the
# independently-versioned eval-reporter-* packages (same publish set as
# publish-all.sh). batch and the fat CLI (dir app, name gaunt-sloth) are locked;
# the eval-reporter-* packages are tagged at their own versions, not the synced one.
PACKAGES=(core agent review batch eval-reporter-junit eval-reporter-teamcity app)

PUSH="${PUSH:-0}"
[[ "${1:-}" == "--push" ]] && PUSH=1

created=()
for pkg in "${PACKAGES[@]}"; do
  name="$(node -p "require('${ROOT}/packages/${pkg}/package.json').name")"
  version="$(node -p "require('${ROOT}/packages/${pkg}/package.json').version")"
  tag="${name}@${version}"
  if git -C "${ROOT}" rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    echo "==> ${tag} already exists — skipping"
    continue
  fi
  echo "==> tagging ${tag}"
  git -C "${ROOT}" tag -a "${tag}" -m "Release ${tag}"
  created+=("${tag}")
done

if [[ ${#created[@]} -eq 0 ]]; then
  echo "No new tags created."
  exit 0
fi

if [[ "${PUSH}" == "1" ]]; then
  echo "Pushing ${#created[@]} tag(s)…"
  git -C "${ROOT}" push origin "${created[@]}"
else
  echo "Created ${#created[@]} tag(s) locally. Push with:"
  echo "  git push origin ${created[*]}"
fi
