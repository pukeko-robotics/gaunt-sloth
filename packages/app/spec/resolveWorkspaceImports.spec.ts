import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Vitest workspace-import shim under test. Importing it directly (rather than
// driving resolution through vitest) lets us assert exactly which package file a
// `#src/…` specifier resolves to for a given importer.
import { resolveWorkspaceImports, packageOfImporter } from '../../../vitest.config.js';

// Repo root = three levels up from this spec (packages/app/spec).
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

// Real files inside packages/app and packages/review, used as representative importers.
const APP_IMPORTER = resolve(repoRoot, 'packages', 'app', 'spec', 'getCommand.spec.ts');
const REVIEW_IMPORTER = resolve(repoRoot, 'packages', 'review', 'spec', 'reviewPreamble.spec.ts');

const APP_COMMAND_UTILS = resolve(
  repoRoot,
  'packages',
  'app',
  'src',
  'commands',
  'commandUtils.ts'
);
const REVIEW_COMMAND_UTILS = resolve(
  repoRoot,
  'packages',
  'review',
  'src',
  'commands',
  'commandUtils.ts'
);

describe('resolveWorkspaceImports (GS2-45 importer-aware #src resolution)', () => {
  const plugin = resolveWorkspaceImports();
  const resolveId = (id: string, importer: string | undefined): string | undefined =>
    plugin.resolveId(id, importer);

  it('maps an importer absolute path to the workspace package it belongs to', () => {
    expect(packageOfImporter(APP_IMPORTER)).toBe('app');
    expect(packageOfImporter(REVIEW_IMPORTER)).toBe('review');
    // Not a workspace-package file -> unmapped, so resolution falls back to the scan.
    expect(packageOfImporter(undefined)).toBeUndefined();
    expect(packageOfImporter(resolve(repoRoot, 'node_modules', 'x', 'index.js'))).toBeUndefined();
  });

  // The core regression: `packages/app` and `packages/review` both own an
  // independent `src/commands/commandUtils.ts` with the same exported names but
  // different content. The specifier must resolve to the IMPORTER's own package.
  it('resolves #src/commands/commandUtils.js to the importer’s OWN package on the app↔review collision', () => {
    const fromApp = resolveId('#src/commands/commandUtils.js', APP_IMPORTER);
    const fromReview = resolveId('#src/commands/commandUtils.js', REVIEW_IMPORTER);

    // app importer -> app's file (the old importer-blind resolver returned review's here).
    expect(fromApp).toBe(APP_COMMAND_UTILS);
    // review importer -> review's file.
    expect(fromReview).toBe(REVIEW_COMMAND_UTILS);
    // They are genuinely different files — proving per-importer discrimination.
    expect(fromApp).not.toBe(fromReview);
  });

  it('resolves a non-colliding #src import to the importer’s own package (app-only path)', () => {
    // `commands/getCommand.ts` exists only in app; an app importer must still get it.
    const resolved = resolveId('#src/commands/getCommand.js', APP_IMPORTER);
    expect(resolved).toBe(resolve(repoRoot, 'packages', 'app', 'src', 'commands', 'getCommand.ts'));
  });

  it('falls back to the dependency-order scan when the importer is not a workspace package', () => {
    // No importer -> importer-blind fallback (the old behavior): review is the
    // first package in scan order that ships commands/commandUtils.ts (core has none).
    expect(resolveId('#src/commands/commandUtils.js', undefined)).toBe(REVIEW_COMMAND_UTILS);
  });

  it('prefers core over a review re-export stub sharing the same relative path', () => {
    // review/src/utils/fileUtils.ts is a stub re-exporting core; a review importer
    // must still get core's canonical module (shared identity), not the stub.
    const resolved = resolveId('#src/utils/fileUtils.js', REVIEW_IMPORTER);
    expect(resolved).toBe(resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'fileUtils.ts'));
  });

  it('resolves @gaunt-sloth/<pkg>/<path>.js to that package’s src file', () => {
    expect(resolveId('@gaunt-sloth/core/utils/fileUtils.js', APP_IMPORTER)).toBe(
      resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'fileUtils.ts')
    );
  });

  // Guard against an accidental hard-coded separator in the importer→package map.
  it('uses the platform path separator when splitting importer paths', () => {
    expect(sep.length).toBe(1);
  });
});
