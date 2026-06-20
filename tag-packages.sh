#!/usr/bin/env bash
# Create git tags for the locked Gaunt Sloth packages — all FOUR:
# @gaunt-sloth/{core,agent,review} and the fat CLI `gaunt-sloth` (dir app).
#
# Tags are annotated and named "<package-name>@<version>" (npm monorepo
# convention): "@gaunt-sloth/core@<v>", …, and "gaunt-sloth@<v>" for the fat
# CLI. The fat package's "gaunt-sloth@<v>" tag is distinct from the repo's
# historical "v<MAJOR.MINOR.PATCH>" tags, so they don't collide. Versions are
# read straight from each package.json — run `npm run release:bump` first so the
# locked set is at the version you want to tag.
#
# Local only by default. Push with:  PUSH=1 ./tag-packages.sh
#                               or:  ./tag-packages.sh --push

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All locked packages, by DIRECTORY — same set as bump.mjs / publish-all.sh,
# including the fat CLI (dir app, name gaunt-sloth).
PACKAGES=(core agent review app)

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
