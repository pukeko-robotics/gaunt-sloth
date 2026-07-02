import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CFG-14 guard (c): there must be exactly ONE source of truth for a provider's fallback model id
 * — the curated `preferredModels` in `modelDiscovery.ts`. This scans the provider factory files
 * and fails if any of them bakes a curated model id back in as a hardcoded string literal (the old
 * `processJsonConfig` `|| 'model'` defaults and `jsonContent` templates), which is exactly what
 * lets a generated config 404 once a model is retired.
 *
 * This test reads the real `src/providers/*.ts` sources (no mocks) rather than exercising a
 * function, so it catches a re-introduced literal anywhere in a provider file.
 */
const PROVIDERS_DIR = fileURLToPath(new URL('../src/providers/', import.meta.url));

/** The one file that is ALLOWED to contain the literals: the curated registry itself. */
const SINGLE_SOURCE_FILE = 'modelDiscovery.ts';

/** Strip block and line comments so a model id mentioned in prose does not trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('CFG-14 single source of truth for fallback model ids', () => {
  it('modelDiscovery.ts is the source that actually holds the curated literals', async () => {
    const { PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
    const curatedIds = PROVIDER_DESCRIPTORS.flatMap((d) => d.preferredModels);
    expect(curatedIds.length).toBeGreaterThan(0);

    const source = readFileSync(`${PROVIDERS_DIR}${SINGLE_SOURCE_FILE}`, 'utf8');
    // Sanity: the registry really does carry the literals we scan the others for.
    for (const id of curatedIds) {
      expect(source).toContain(`'${id}'`);
    }
  });

  it('no other provider file hardcodes a curated model id as a string literal', async () => {
    const { PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
    const curatedIds = [...new Set(PROVIDER_DESCRIPTORS.flatMap((d) => d.preferredModels))];

    const providerFiles = readdirSync(PROVIDERS_DIR).filter(
      (f) => f.endsWith('.ts') && f !== SINGLE_SOURCE_FILE
    );
    expect(providerFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of providerFiles) {
      const code = stripComments(readFileSync(`${PROVIDERS_DIR}${file}`, 'utf8'));
      for (const id of curatedIds) {
        // A quoted occurrence of the exact id is a hardcoded literal (avoids matching a
        // substring inside a regex/identifier, and comments are already stripped).
        if (code.includes(`'${id}'`) || code.includes(`"${id}"`)) {
          offenders.push(`${file}: "${id}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every provider factory routes its run-time fallback through getCuratedFallbackModel', async () => {
    const { PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
    // Every provider factory (id.ts) must resolve its model default from the single source.
    for (const { id } of PROVIDER_DESCRIPTORS) {
      const code = readFileSync(`${PROVIDERS_DIR}${id}.ts`, 'utf8');
      expect(code).toContain('getCuratedFallbackModel(');
    }
  });
});
