#!/usr/bin/env node
/**
 * Write the committed golden of the core barrel's public TYPE surface — the derived name set that
 * `spec/coreBarrelTypeSurface.spec.ts` compares against. The derivation itself lives in
 * `type-surface.mjs` and is shared with that spec, so the file this writes is by construction the
 * thing the spec derives rather than a second opinion about it.
 *
 * Run AFTER a build, because the walk reads the emitted declarations in `dist/`:
 *
 *   pnpm --filter @gaunt-sloth/core run build
 *   pnpm --filter @gaunt-sloth/core run surface:generate
 *
 * Run it when the spec's golden cell tells you to and you have established that the change to the
 * public surface is one you meant. On a LOSS of types that is a decision, not a formality: the
 * spec's failure message says what to establish first.
 */
import { writeFileSync } from 'node:fs';
import { deriveSurface, GOLDEN_PATH, toGoldenDocument } from './type-surface.mjs';

const golden = toGoldenDocument(deriveSurface());
writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n', 'utf8');
console.log(
  `Wrote ${GOLDEN_PATH} (${golden.required.length} required, ${golden.unexported.length} reachable but unexported)`
);
