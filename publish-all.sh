#!/usr/bin/env bash
# Publish the synced @gaunt-sloth/* packages in topological order.
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

# Topological order: core is published first (everything depends on it), then
# agent (the merged tools+api runtime; depends on core), then review (depends on
# core). The former tools/api forwarding shims were removed in the 2.0 break.
ORDER=(core agent review)

echo "Publishing @gaunt-sloth/* to ${REGISTRY}"
for pkg in "${ORDER[@]}"; do
  version="$(node -p "require('${ROOT}/packages/${pkg}/package.json').version")"
  echo "==> @gaunt-sloth/${pkg}@${version}"
  # NPM_PUBLISH_ARGS is intentionally left unquoted so multiple flags split into
  # separate arguments; it defaults to empty for the plain local Verdaccio path.
  # shellcheck disable=SC2086
  (cd "${ROOT}/packages/${pkg}" && npm publish --registry "${REGISTRY}" ${NPM_PUBLISH_ARGS:-})
done
echo "Done."
