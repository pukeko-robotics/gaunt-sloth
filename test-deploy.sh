#!/bin/bash
# Packs @gaunt-sloth/core and @gaunt-sloth/review from the workspace,
# then installs them into a clean staging directory so the global install
# pulls only declared dependencies (no workspace hoisting leaks).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/gaunt-sloth-review-test-deploy"

# Optional peer dependencies for @gaunt-sloth/core.
# Add/remove provider packages depending on which LLM providers you use.
PEER_DEPS=(
  "@langchain/google"
)

echo "==> Building workspace..."
pnpm --dir "$SCRIPT_DIR" run build

# Pack with `pnpm pack`, NOT `npm pack`: internal deps use the `workspace:*`
# protocol, and only pnpm rewrites `workspace:*` to the concrete version in the
# tarball. (No tarball here actually carries a workspace dep — review→core is
# installed separately below — but staying on pnpm keeps the flow consistent and
# future-proof.) `pnpm pack` runs per package dir rather than via an `-w` flag.
echo "==> Packing @gaunt-sloth/core..."
CORE_TGZ=$(cd "$SCRIPT_DIR/packages/core" && pnpm pack --pack-destination "$SCRIPT_DIR" 2>/dev/null | tail -1)
CORE_TGZ=$(basename "$CORE_TGZ")

echo "==> Packing @gaunt-sloth/review..."
REVIEW_TGZ=$(cd "$SCRIPT_DIR/packages/review" && pnpm pack --pack-destination "$SCRIPT_DIR" 2>/dev/null | tail -1)
REVIEW_TGZ=$(basename "$REVIEW_TGZ")

echo "==> Preparing $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"
rm -rf "$DEPLOY_DIR/node_modules" "$DEPLOY_DIR/package.json" "$DEPLOY_DIR/package-lock.json"

cp "$SCRIPT_DIR/$CORE_TGZ" "$DEPLOY_DIR/"
cp "$SCRIPT_DIR/$REVIEW_TGZ" "$DEPLOY_DIR/"

cd "$DEPLOY_DIR"

# Minimal package.json so npm install works
cat > package.json <<'EOF'
{
  "name": "gaunt-sloth-review-test-deploy",
  "version": "0.0.0",
  "private": true,
  "description": "Staging directory for testing @gaunt-sloth/review global install"
}
EOF

echo "==> Installing @gaunt-sloth/core from tarball..."
npm install "./$CORE_TGZ"

echo "==> Installing @gaunt-sloth/review from tarball..."
npm install "./$REVIEW_TGZ"

if [ ${#PEER_DEPS[@]} -gt 0 ]; then
  echo "==> Installing peer dependencies: ${PEER_DEPS[*]}..."
  npm install "${PEER_DEPS[@]}"
fi

echo "==> Installing globally from staging node_modules..."
npm install -g node_modules/@gaunt-sloth/review

# Clean up tarballs from workspace root
rm -f "$SCRIPT_DIR/$CORE_TGZ" "$SCRIPT_DIR/$REVIEW_TGZ"

echo ""
echo "Done. Verify with:"
echo "  which gaunt-sloth-review"
echo "  gaunt-sloth-review --help"
