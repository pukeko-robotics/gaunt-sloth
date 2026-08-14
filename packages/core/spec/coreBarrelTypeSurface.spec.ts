import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GS2-97 — the root barrel's public TYPE surface, pinned against the built declarations.
 *
 * A type that a barrel-exported value hands you but that the barrel does not export is a type you
 * can receive and cannot name. `ToolApprovalCallback` is handed a `PendingToolInterrupt`, whose
 * `subject`, `safetyVerdict` and `negotiationRounds` are declared under `core/approvals/` and
 * `core/shell/`, so writing a typed approval handler — the most likely reason to embed this
 * package — is where an embedder meets the gap first. Nothing about a missing type export is
 * visible from inside this repo, where every module is reachable by its own path: the whole defect
 * lives at the package boundary, which is why it has to be probed from outside rather than read.
 *
 * **A type-level assertion written in a spec file would not pin anything.** `packages/core/tsconfig
 * .json` builds `src/` only, so no spec here is ever type-checked, and vitest strips types without
 * checking them — an `expectTypeOf`-shaped line in this file could name types that do not exist and
 * still go green. So this spec spawns the type-checker itself, over the emitted `dist/` `.d.ts`
 * artifacts, and reads its exit status: an ordinary runtime assertion about a real build artifact.
 *
 * The probe imports `@gaunt-sloth/core` by name, exactly as an embedder writes it, so a green run
 * covers the package `exports` map and the declaration emit as well as the barrel's own re-exports.
 * That resolution is why the probe is written into a temp dir INSIDE the package rather than the
 * system temp dir: the package name resolves from here (through the package's own `exports`, and
 * through the workspace link), and from an unrelated directory it would not resolve at all.
 *
 * It needs `dist/` to exist. `pnpm test` builds first; a bare `pnpm run unit` on a never-built tree
 * fails here with the message below rather than with a type error, so the cause is named.
 */

const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));
const DIST_BARREL = path.join(CORE_DIR, 'dist', 'index.d.ts');

/** The TypeScript compiler's own CLI entry, run through `process.execPath` so Windows agrees. */
const TSC_ENTRY = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');

/**
 * The approval and shell types the barrel re-exports for naming. Each is the declared type of
 * something already reachable from the barrel; each is used below in an annotation position, which
 * is the only thing that proves it can be NAMED rather than merely inferred.
 */
const PINNED_TYPE_EXPORTS = [
  'ApprovalSubject',
  'ShellApprovalSubject',
  'ToolApprovalSubject',
  'McpToolApprovalSubject',
  'ShellSafetyVerdict',
  'RaterNegotiationRound',
  'RaterOutcome',
  'DeclaredToolAnnotations',
] as const;

/** The already-public names that reach the pinned ones, and the reason they need naming at all. */
const REACHING_EXPORTS = [
  'PendingToolInterrupt',
  'ToolApprovalCallback',
  'ToolApprovalDecision',
] as const;

/**
 * A typed approval handler, written the way an embedder writes one.
 *
 * `RaterOutcome` and `ShellSafetyVerdict` are used WITHOUT importing `RATER_OUTCOMES` or
 * `ShellSafetyVerdictSchema`, the runtime values their declarations derive from: a type alias
 * resolves its referent inside the declaration file it was emitted into, so a consumer never needs
 * either value in scope. This file compiling is the measurement that says so.
 */
const PROBE = `import type {
  ApprovalSubject,
  DeclaredToolAnnotations,
  McpToolApprovalSubject,
  PendingToolInterrupt,
  RaterNegotiationRound,
  RaterOutcome,
  ShellApprovalSubject,
  ShellSafetyVerdict,
  ToolApprovalCallback,
  ToolApprovalDecision,
  ToolApprovalSubject,
} from '@gaunt-sloth/core';

export const shellSubject: ShellApprovalSubject = { kind: 'shell', command: 'npm test' };
export const toolSubject: ToolApprovalSubject = { kind: 'tool', name: 'gth_web_fetch' };
export const mcpSubject: McpToolApprovalSubject = {
  kind: 'mcpTool',
  server: 'jira',
  name: 'create_issue',
};
export const subjects: ApprovalSubject[] = [shellSubject, toolSubject, mcpSubject];
export const outcome: RaterOutcome = 'catastrophic';
export const verdict: ShellSafetyVerdict = { outcome: 'destructive', reason: 'a reason' };
export const round: RaterNegotiationRound = {
  command: 'git reset --hard origin/main',
  outcome: 'destructive',
  reason: 'a reason',
};
export const declared: DeclaredToolAnnotations = { openWorldHint: true };

export const decide: ToolApprovalCallback = (
  pending: PendingToolInterrupt
): ToolApprovalDecision => {
  const subject: ApprovalSubject | undefined = pending.subject;
  const safety: ShellSafetyVerdict | undefined = pending.safetyVerdict;
  const rounds: readonly RaterNegotiationRound[] | undefined = pending.negotiationRounds;
  const annotations: DeclaredToolAnnotations = { readOnlyHint: subject?.kind === 'shell' };
  if (safety?.outcome === 'safe' && annotations.readOnlyHint && !rounds?.length) {
    return { type: 'approve', scope: 'once' };
  }
  return { type: 'reject', message: 'declined' };
};
`;

/**
 * The same import, deliberately wrong three ways: a name the barrel does not export, a value
 * outside a closed union, and a wrong discriminator. Without this a green run above would be
 * indistinguishable from a run that resolved nothing and type-checked nothing.
 *
 * It names none of the types above on purpose, so that each test here fails for its own reason: a
 * dropped re-export is test one's failure, and this one keeps saying only whether the checker
 * still bites.
 */
const NEGATIVE_PROBE = `import type {
  ThisNameIsNotExportedByTheBarrel,
  ToolApprovalDecision,
  ToolApprovalScope,
} from '@gaunt-sloth/core';

export const scope: ToolApprovalScope = 'forever';
export const decision: ToolApprovalDecision = { type: 'maybe' };
export const absent: ThisNameIsNotExportedByTheBarrel = 1;
`;

interface TypeCheckResult {
  status: number | null;
  output: string;
}

/** Type-check one probe against the built package and hand back tsc's verdict verbatim. */
function typeCheck(source: string): TypeCheckResult {
  expect(
    existsSync(DIST_BARREL),
    `${DIST_BARREL} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
  ).toBe(true);

  const dir = mkdtempSync(path.join(CORE_DIR, '.type-probe-'));
  try {
    const file = path.join(dir, 'probe.ts');
    writeFileSync(file, source, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        TSC_ENTRY,
        '--noEmit',
        '--pretty',
        'false',
        // Files named on the command line take no tsconfig; every option the probe needs is here.
        '--ignoreConfig',
        '--strict',
        // The barrel's declarations pull in LangChain and Zod; their internals are not what this
        // spec is asking about, and checking them would make the pin fail for unrelated reasons.
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        path.relative(CORE_DIR, file),
      ],
      { cwd: CORE_DIR, encoding: 'utf8', timeout: 120_000 }
    );
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('@gaunt-sloth/core root barrel type surface', () => {
  it('lets an embedder name every type a typed approval handler receives', () => {
    const { status, output } = typeCheck(PROBE);
    expect(output).toBe('');
    expect(status).toBe(0);
  }, 120_000);

  it('goes red on a missing export, a bad literal and a wrong discriminator', () => {
    const { status, output } = typeCheck(NEGATIVE_PROBE);
    // TS2305 is the shape a dropped re-export takes, and the reason this spec is worth having.
    expect(output).toContain(
      `Module '"@gaunt-sloth/core"' has no exported member 'ThisNameIsNotExportedByTheBarrel'`
    );
    expect(output).toContain(`Type '"forever"' is not assignable to type 'ToolApprovalScope'`);
    expect(output).toContain(`Type '"maybe"' is not assignable to type '"approve" | "reject"'`);
    expect(status).not.toBe(0);
  }, 120_000);

  it('exercises every pinned name in an annotation position', () => {
    // The probe is the pin; a name quietly dropped from it would shrink the surface being checked
    // without failing anything.
    for (const name of [...PINNED_TYPE_EXPORTS, ...REACHING_EXPORTS]) {
      expect(PROBE).toContain(`  ${name},\n`);
      expect(PROBE).toContain(`: ${name}`);
    }
  });
});
