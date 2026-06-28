#!/usr/bin/env node
/**
 * Generate the committed JSON Schema for the Gaunt Sloth config from the Zod schema
 * (the single source of truth, `src/config/schema.ts`). Run AFTER `pnpm run build`
 * so the compiled `dist/config/schema.js` is available:
 *
 *   pnpm --filter @gaunt-sloth/core run build
 *   pnpm --filter @gaunt-sloth/core run schema:generate
 *
 * A vitest golden-snapshot test (`spec/configSchema.spec.ts`) asserts the generator
 * output matches the committed file, so this must be re-run whenever the schema changes.
 * NOTE: the snapshot pins zod's `toJSONSchema` output shape, so a future zod upgrade
 * may change it — re-run this script and commit the regenerated file if the test trips.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { generateConfigJsonSchema } = await import(resolve(here, '../dist/config/schema.js'));

const outPath = resolve(here, '../schema/gsloth-config.schema.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(generateConfigJsonSchema(), null, 2) + '\n', 'utf8');
console.log(`Wrote ${outPath}`);
