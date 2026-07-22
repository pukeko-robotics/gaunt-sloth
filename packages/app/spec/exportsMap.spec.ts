import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * GS2-2 B7 — guards the app package's narrowed `exports` map.
 *
 * The app is the fat CLI, not a library: its exports map exposes ONLY `./package.json`.
 * The old `"./*": "./dist/*.js"` wildcard served the B4 re-export shim tree; both are gone,
 * and nothing in this repo or the known consumers imports `gaunt-sloth/*` (they spawn the
 * bins instead). These tests pin that surface so a re-widening (or an accidental narrowing
 * of `./package.json`) fails fast.
 *
 * Resolution is probed through Node's package self-reference (a package can import itself
 * by name through its own exports map), spawned with cwd at the package root.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('gaunt-sloth (app) exports map', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('declares only ./package.json in exports, no main and no types', () => {
    const require = createRequire(import.meta.url);
    const pkg = require(path.join(appDir, 'package.json'));
    expect(Object.keys(pkg.exports)).toEqual(['./package.json']);
    expect(pkg.main).toBeUndefined();
    expect(pkg.types).toBeUndefined();
  });

  it('does not resolve deep module paths (the app is not a library)', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `try {
          await import('gaunt-sloth/commands/askCommand.js');
          console.log('RESOLVED');
        } catch (e) {
          console.log('ERR:' + e.code);
        }`,
      ],
      { cwd: appDir, encoding: 'utf8', timeout: 30000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ERR:ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('still resolves ./package.json for tooling', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `const { createRequire } = await import('node:module');
        const req = createRequire(process.cwd() + '/');
        console.log(req.resolve('gaunt-sloth/package.json') ? 'OK' : 'MISSING');`,
      ],
      { cwd: appDir, encoding: 'utf8', timeout: 30000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('OK');
  });
});
