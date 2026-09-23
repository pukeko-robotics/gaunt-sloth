/**
 * **Loading the agent's MCP modules must not load undici.**
 *
 * Importing undici installs its own process-global dispatcher, including the legacy
 * `undici.globalDispatcher.1` slot that Node's built-in `fetch` reads. From undici 8.11 that
 * dispatcher lets Node's `fetch` negotiate HTTP/2 and drop response headers, which broke MCP servers
 * such as Atlassian's. So `tlsTrust.ts` imports undici only when it has a dispatcher to install.
 *
 * This runs in a fresh `node` process against the built modules, because an in-process check cannot
 * see a load: Vitest runs a `vi.mock` factory on the module's first use, not when it is imported, so
 * a counter in the factory stays at zero under a top-level `import ... from 'undici'`. The control
 * cell imports undici directly and must see the slot set, which proves the probe can fail.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');

function legacySlotSetAfterImporting(specifier: string): boolean {
  const code =
    `await import(${JSON.stringify(specifier)});` +
    `console.log(globalThis[Symbol.for('undici.globalDispatcher.1')] !== undefined);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: dirname(distDir),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() === 'true';
}

describe('undici is not loaded at module load', () => {
  it('control: importing undici itself sets the legacy global dispatcher slot', () => {
    expect(legacySlotSetAfterImporting('undici')).toBe(true);
  });

  it.each(['mcp/tlsTrust.js', 'resolvers.js'])(
    'importing dist/%s leaves the global dispatcher slot unset',
    (file) => {
      expect(legacySlotSetAfterImporting(pathToFileURL(resolve(distDir, file)).href)).toBe(false);
    }
  );
});
