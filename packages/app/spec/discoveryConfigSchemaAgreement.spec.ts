import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CFG-82 — the discovery config's zod schema (core) and its TypeScript interfaces (this package)
 * cannot drift apart silently.
 *
 * `src/commands/discoveryConfigSchemaAgreement.ts` holds the claim: it compiles only when
 * `PrDiscoveryConfig` / `ReviewDiscoveryConfig` and the zod-inferred `commands.pr.discovery` /
 * `commands.review.discovery` have the same keys and the same types (with `tools` bounded one way;
 * that file says why). `pnpm run build` already type-checks it. This spec states the claim where a
 * test run sees it, and proves the comparison is able to fail.
 *
 * **A type-level assertion written in this file would pin nothing**: `packages/app/tsconfig.json`
 * builds `src/` only and vitest strips types without checking them. So each cell writes a probe,
 * runs the type-checker over it and reads its exit status and diagnostics.
 *
 * The probes read core through its BUILT declarations (`@gaunt-sloth/core/config/schema.js`
 * resolves to `packages/core/dist`), as the app build does. A schema change is only seen here after
 * core is rebuilt; `pnpm test` and CI build first.
 *
 * Each failing cell must fail for the reason it names, not because a probe did not resolve: it
 * asserts exactly one diagnostic, `TS2344` on the probe's assertion line. Each has a control that
 * differs only in the break and must compile, so a construction the comparator dislikes for some
 * other reason cannot pass as a detected drift.
 */
const APP_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The TypeScript compiler's JS entry, run through `process.execPath` so Windows can spawn it. */
const TSC_ENTRY = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');

const AGREEMENT_FILE = 'src/commands/discoveryConfigSchemaAgreement.ts';

/** The probe's imports, shared by every cell. */
const PROBE_HEADER = `import type { RawGthConfigInput } from '@gaunt-sloth/core/config/schema.js';
import type { DiscoveryShapesAgree, Expect } from '#src/commands/discoveryConfigSchemaAgreement.js';
import type { PrDiscoveryConfig } from '#src/commands/prDiscovery.js';
import type { ReviewDiscoveryConfig } from '#src/commands/reviewDiscovery.js';
type Commands = NonNullable<RawGthConfigInput['commands']>;
export type SchemaPr = NonNullable<NonNullable<Commands['pr']>['discovery']>;
export type SchemaReview = NonNullable<NonNullable<Commands['review']>['discovery']>;
export type Unused = [PrDiscoveryConfig, ReviewDiscoveryConfig];
`;

/** 1-based line the single assertion lands on in a probe built by {@link probe}. */
const ASSERTION_LINE = PROBE_HEADER.split('\n').length;

function probe(interfaceSide: string, schemaSide: string): string {
  return `${PROBE_HEADER}export type Check = Expect<DiscoveryShapesAgree<${interfaceSide}, ${schemaSide}>>;\n`;
}

interface TypeCheckResult {
  status: number | null;
  output: string;
}

/** Type-check the named files (relative to the probe dir) with the app's own compiler options. */
function typeCheck(files: string[], probeSource?: string): TypeCheckResult {
  expect(
    existsSync(path.join(APP_DIR, '..', 'core', 'dist', 'config', 'schema.d.ts')),
    'core is not built; run `pnpm run build` first'
  ).toBe(true);
  const dir = mkdtempSync(path.join(APP_DIR, '.type-probe-'));
  try {
    if (probeSource !== undefined) writeFileSync(path.join(dir, 'probe.ts'), probeSource, 'utf8');
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: { noEmit: true, rootDir: '..', incremental: false },
        files,
      }),
      'utf8'
    );
    const result = spawnSync(
      process.execPath,
      [TSC_ENTRY, '--pretty', 'false', '-p', path.join(dir, 'tsconfig.json')],
      { cwd: APP_DIR, encoding: 'utf8', timeout: 120_000 }
    );
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectCompiles(result: TypeCheckResult): void {
  expect(result.output).toBe('');
  expect(result.status).toBe(0);
}

/** Exactly one diagnostic, the failed `Expect` on the probe's assertion line. */
function expectDriftDetected(result: TypeCheckResult): void {
  const errors = result.output.split('\n').filter((line) => /error TS\d+/.test(line));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(
    new RegExp(`probe\\.ts\\(${ASSERTION_LINE},\\d+\\): error TS2344: Type 'false' does not`)
  );
  expect(result.status).not.toBe(0);
}

const TIMEOUT = 120_000;

describe('discovery config: zod schema and app interfaces agree (CFG-82)', () => {
  it(
    'the agreement file type-checks against the built schema',
    () => {
      expectCompiles(typeCheck([`../${AGREEMENT_FILE}`]));
    },
    TIMEOUT
  );

  it(
    'controls: each construction the failing cells use compiles when nothing drifted',
    () => {
      const controls = [
        // The interface side re-declares a key it already has, as the first break adds one.
        ['PrDiscoveryConfig & { enabled?: boolean }', 'SchemaPr'],
        // The review interface given pr's extra key matches pr's schema.
        ['ReviewDiscoveryConfig & { deterministicDiff?: boolean }', 'SchemaPr'],
        // A key replaced with its own type.
        ["Omit<ReviewDiscoveryConfig, 'enabled'> & { enabled?: boolean }", 'SchemaReview'],
        // `tools` replaced with exactly what the schema takes.
        ["Omit<ReviewDiscoveryConfig, 'tools'> & { tools?: unknown[] }", 'SchemaReview'],
      ];
      const source =
        PROBE_HEADER +
        controls
          .map(
            ([iface, schema], i) =>
              `export type Control${i} = Expect<DiscoveryShapesAgree<${iface}, ${schema}>>;`
          )
          .join('\n') +
        '\n';
      expectCompiles(typeCheck(['probe.ts'], source));
    },
    TIMEOUT
  );

  it(
    'fails when the interface gains a key the schema lacks',
    () => {
      expectDriftDetected(
        typeCheck(['probe.ts'], probe('PrDiscoveryConfig & { enabeld?: boolean }', 'SchemaPr'))
      );
    },
    TIMEOUT
  );

  it(
    'fails when the schema has a key the interface lacks',
    () => {
      // pr's schema carries `deterministicDiff`; the review interface does not.
      expectDriftDetected(typeCheck(['probe.ts'], probe('ReviewDiscoveryConfig', 'SchemaPr')));
    },
    TIMEOUT
  );

  it(
    'fails when a shared key has a different type',
    () => {
      expectDriftDetected(
        typeCheck(
          ['probe.ts'],
          probe("Omit<ReviewDiscoveryConfig, 'enabled'> & { enabled?: string }", 'SchemaReview')
        )
      );
    },
    TIMEOUT
  );

  it(
    "fails when the interface's tools is something the schema would refuse",
    () => {
      expectDriftDetected(
        typeCheck(
          ['probe.ts'],
          probe("Omit<ReviewDiscoveryConfig, 'tools'> & { tools?: string }", 'SchemaReview')
        )
      );
    },
    TIMEOUT
  );
});
