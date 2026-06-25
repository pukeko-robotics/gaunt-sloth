#!/usr/bin/env bash
# Create git tags for the synced @gaunt-sloth/* packages (core, tools, api, review).
#
# The user-facing CLI (gaunt-sloth) is intentionally EXCLUDED — it
# carries its own version and already uses the repo's v<MAJOR.MINOR.PATCH> tags.
#
# Tags are annotated and named "@gaunt-sloth/<pkg>@<version>" (npm monorepo
# convention) so they never collide with the assistant's v* tags. Versions are
# read straight from each package.json — run `npm run release:bump` first so the
# synced set is at the version you want to tag.
#
# Local only by default. Push with:  PUSH=1 ./tag-packages.sh
#                               or:  ./tag-packages.sh --push

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Synced packages only — same set as bump.mjs / publish-all.sh, minus assistant.
PACKAGES=(core tools api review)

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
