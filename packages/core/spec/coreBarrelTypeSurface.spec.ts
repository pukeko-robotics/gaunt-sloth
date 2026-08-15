import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  assertNonDegenerate,
  CORE_DIR,
  deriveSurface,
  describeSurfaceDrift,
  GOLDEN_PATH,
  MIN_DERIVED_TYPES,
  readGoldenDocument,
  REGENERATE_COMMAND,
  requireBuiltBarrel,
  toGoldenDocument,
} from '../scripts/type-surface.mjs';
import type { SurfaceType } from '../scripts/type-surface.mjs';

/**
 * The root barrel's public TYPE surface, pinned against the built declarations.
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
 * system temp dir: it resolves by SELF-NAME — the compiler walks up to this package's own
 * `package.json` and matches subpath `.` in its `exports`, and `--traceResolution` shows it never
 * enters `node_modules`, so no workspace link or symlink takes part. From an unrelated directory
 * the name would not resolve at all.
 *
 * ## Where the expectation comes from, and why it is not the export list
 *
 * The set of types this file demands is **derived, never listed**. {@link deriveSurface} — in
 * `scripts/type-surface.mjs`, shared with the generator described below — walks the emitted
 * declarations with the compiler API: it seeds on the barrel's own exported declarations and
 * follows every *type reference* out of them, transitively, keeping the named types whose
 * declarations live inside this package's `dist/`. What it produces is the answer to "which of our
 * types does the public surface hand out", read off the reference graph the source modules are
 * written in — a different question from "which names does the barrel export", and answered by
 * different text.
 *
 * That distinction is the entire point. A list of expected exports kept in this file would restate
 * the surface, so a maintainer who deletes a re-export, its probe line and its list entry in one
 * edit leaves every test green while the barrel is genuinely narrower. Here, deleting the
 * re-export changes nothing about the derivation: `RaterNegotiationRound.outcome` still says
 * `RaterOutcome`, so `RaterOutcome` is still required, and it is now missing — red.
 *
 * ## The committed golden, and why it is not that list coming back
 *
 * The derivation answers which types the surface hands out; nothing in it can say whether it
 * answered *completely*. The two guards that speak about size are thresholds —
 * {@link MIN_DERIVED_TYPES} and its `REQUIRED_TREES` neighbour — and **a threshold cannot see a
 * proportional loss.** Measured on this surface by dropping one symbol flag from the walk's
 * `NAMED_TYPE` filter: the `Class` bit costs three of the derived names, the `TypeAlias` bit costs
 * more than a third of them, and every guard passes either way. Those types stop being checked and
 * nothing says so — the three-name loss reds no cell in this file except the comparison below,
 * which is the whole argument for having it.
 *
 * So the primary guard is the committed golden, `coreBarrelTypeSurface.golden.json`: the derived
 * name set as it was last reviewed, compared for equality. A threshold asks "is this plausibly a
 * surface?"; the golden asks "is this THE surface?" — the only question that catches the loss of
 * one name as readily as the loss of forty, and its diff names the types that moved, which no count
 * can. It follows the convention `schema/gsloth-config.schema.json` already sets in this package: a
 * generate script (`pnpm --filter @gaunt-sloth/core run surface:generate`), a committed file, and a
 * cell that compares.
 *
 * **This is not the thing GS2-98 exists to stop trusting, and the distinction is exact.** What that
 * node took out of this file was the *barrel's export list* as the statement of what ought to be
 * exported — a hand-maintained list restates the surface, so a single edit deleting a re-export,
 * its probe line and its list entry leaves everything green. That is unchanged: the walk still
 * derives the answer, and the golden is a snapshot of **the walk's own output**, a change detector
 * over the derivation rather than a second source of truth about the API. Delete a re-export and
 * the derivation still fails, golden or no golden. The related warning — that measuring the derived
 * set as a *ratio* against the barrel's export count would put the expectation back where it came
 * from — stands, and is a different idea: a change that shrinks both sides moves neither.
 *
 * **The guards stay in front of it, demoted to what they are.** They are cheap, and for a total
 * collapse they say the right sentence — "this is a broken walk, not a small API" — where an
 * equality diff would list a hundred missing names and leave the reader to infer it.
 *
 * **The cost, stated rather than hidden:** every legitimate addition to the public surface now
 * regenerates the golden. That is one command and a reviewable diff, and the failure message names
 * it. The message also says which kind of drift it is, because an equality failure looks identical
 * for "you added a type", "types vanished" and "a type is still here but bound differently", while
 * the right response to each is a different one — and for a vanished type, reaching for the
 * regeneration command first is precisely the wrong move.
 *
 * ## What this pin catches
 *
 * - A type reachable from the public surface that the barrel cannot name, however it got that way,
 *   including a coordinated removal from every place a name is written.
 * - A barrel export that carries the right *name* for a different *declaration* than the one the
 *   surface reaches, which a name-only comparison reads as satisfied.
 * - A break in the package `exports` map or the declaration emit, because the probe imports by
 *   package name from outside rather than by path from inside.
 * - A type referenced through the inline `import("./other").MyType` form the emitter reaches for
 *   when a declaration has no top-level import to reuse, as well as through an ordinary named
 *   reference or a heritage clause.
 * - **A PARTIAL collapse of the derivation** — the golden's own reason to exist. Any change to the
 *   derived set at any size fails the comparison cell and is named in its message: a name lost, a
 *   name added, or a name still present but bound to another file or another arity.
 * - **Its own TOTAL collapse.** {@link assertNonDegenerate} runs inside {@link deriveSurface},
 *   before the result is memoised, so a derivation that walked nothing, resolved a reference shape
 *   it did not recognise, fell under the floor, or missed a whole tree is refused rather than
 *   handed out. That placement is deliberate, and it now protects the generator too: a collapsed
 *   walk must never be written into the golden, which would launder the collapse into the reviewed
 *   expectation.
 *
 * ## What it does NOT catch — stated because the temptation is to overstate it
 *
 * - **A loss regenerated away.** The golden makes a shrinking derivation loud; it cannot stop
 *   someone from running the regeneration command to make the red go away. What it converts is the
 *   failure mode: from silence into a diff that names the vanished types, in a commit, for a
 *   reviewer. That is the most a derived oracle can do, and the failure message says as much.
 * - **Narrowing the barrel itself.** The walk is seeded from the barrel's exports, so deleting a
 *   public export removes both the name and every obligation its type graph created. "Reachable
 *   implies nameable" has nothing to say once a thing stops being reachable, and no derivation from
 *   the built artifact can distinguish a deliberate narrowing from a smaller API. What the golden
 *   adds is that the narrowing is no longer *silent* — the derived set shrinks with the barrel, so
 *   the comparison reds and names what left; deciding it was intended is then a human step at
 *   regeneration. Measured: deleting one `export *` line from `src/index.ts` drops ten names from
 *   the derived set, and the failure names all ten.
 * - **A rename at the declaration.** Renaming a public type breaks every embedder's import, and
 *   the derivation simply follows the new name. The golden reds — one name gone, one added — but
 *   reads it as a change, not as a break; only a human knows an embedder's import broke. Naming a
 *   type in text is the other defence, which is what the handwritten probe below does for the
 *   twelve names it carries.
 * - **A shape change to a still-named type.** What is pinned is the set of names, the file each
 *   binds to and its arity — never its members. Measured: rewriting `BinaryFormatType` in `dist`
 *   from its union of string literals to `number`, a hard break for every embedder, leaves this
 *   whole spec green. This is a pin on what an embedder can *name*, not on what those names mean;
 *   member lists are the compiler's job, and the compiler checks them against this package's own
 *   callers rather than anybody else's.
 * - **A value export becoming type-only.** The derivation asks the compiler only about types, so
 *   turning an `export *` into `export type *` is invisible to it. Measured on
 *   `#src/history/historyStore.js`: every cell here stays green while `new HistoryStore(...)` from
 *   the package root stops compiling for an embedder. Three entries in the golden are classes
 *   (`ConfigDiscoveryError`, `HistoryStore`, `MissingProviderKeyError`) whose value half this pin
 *   cannot see, and no spec in this package imports the barrel for its runtime exports, so that
 *   half is unguarded rather than guarded elsewhere.
 * - **A type emitted without an `export` modifier at its own declaration.** It is nameable by no
 *   route at all, so no barrel re-export could fix it, and it is excluded from `required` on that
 *   mechanism — the modifier flags read off the emitted node, not an opinion about the type.
 *   `ApprovalEntryCommon` in `config/shell-policy.d.ts` is the standing instance, and both a
 *   failure below and the golden's `unexported` list name whatever the current set is. This is a
 *   standing escape hatch, not just a listing quirk: deleting that one keyword removes a type from
 *   the public surface — the golden reports it as the name changing lists, which is the strongest
 *   signal available for a change that no compiler complains about.
 * - **Values named only through `typeof`.** A `typeof X` query in an emitted `.d.ts` resolves
 *   inside the file it was emitted into, so an embedder naming the alias never needs `X` in scope
 *   — measured by the handwritten probe below, which uses `RaterOutcome` and `ShellSafetyVerdict`
 *   with neither `RATER_OUTCOMES` nor `ShellSafetyVerdictSchema` imported. The pin therefore says
 *   nothing about whether those values themselves can be imported.
 * - **Anonymous structure.** Only named types can be exported, so an inlined object type is
 *   reachable, nameable by nobody, and correctly not required.
 * - **A type nothing hands out.** `ToolApprovalCallback` is the case to know: an embedder passes
 *   one IN, so no reachable declaration is typed as one and the derivation cannot require it. It
 *   is named in the handwritten probe for exactly that reason.
 *
 * **A reference position the walk ENTERS and cannot name is a hard red, and it is not a barrel
 * regression.** The resolver takes a heritage clause in whatever form it arrives and counts
 * anything it cannot turn into a name, and {@link assertNonDegenerate} refuses a derivation with
 * any such count — so a future emitter that writes a shape this walk has never met fails every
 * derivation-driven test here at once, with no public type having moved. That is the intended
 * trade: the alternative is a shape skipped in silence, which shrinks the derived surface without
 * shrinking the barrel and is the exact failure this file exists to stop. Read that message as a
 * resolver to teach, not as an export to restore. The scoping in that first sentence is exact and
 * not throat-clearing: a node form the walk does not enter as a reference position at all is
 * neither named nor counted, which is the standing gap recorded at the import-type branch.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with the message below rather than with a type
 * error, so the cause is named. It reads whatever `dist/` holds: on a tree built before an edit to
 * `src/`, this checks the older declarations, as any artifact probe does — which is also the first
 * thing to rule out when the golden reports a loss.
 *
 * **Windows reads a failure here the same way it reads a real one.** That self-name walk is what a
 * red cell would break first, and an unresolved import surfaces as the same TS2305/TS2307 a dropped
 * export does. A cell that is red only on Windows is about resolution, not about the barrel.
 */

const requireHere = createRequire(import.meta.url);

/**
 * The TypeScript compiler's own CLI entry, run through `process.execPath` so Windows agrees — a
 * `.bin` shim is a shell script there and would not spawn.
 *
 * This is the repo's `typescript` devDependency, which is the JS compiler; the build runs the
 * native one. Both check the same language, but the flags and the diagnostic text asserted below
 * are this compiler's: moving the pin to the native one means re-reading its output rather than
 * assuming these strings survive.
 */
const TSC_ENTRY = requireHere.resolve('typescript/lib/tsc.js');

/** Prefix for the generated aliases. No exported type is named this way, so nothing collides. */
const ALIAS_PREFIX = 'Named_';

/**
 * Render the derived surface as a probe an embedder could have written: import every required name
 * from the package root, and alias each one in a type position.
 *
 * The import alone is what fails on a missing export — TypeScript reports TS2305 on the specifier
 * whether or not the name is used. The alias line is what makes a green run legible, and it is
 * emitted only for a type that takes no required type argument, since `type X = Generic;` is an
 * arity error rather than a statement about the barrel.
 *
 * **Two branches here are unexercised and will stay that way until the surface changes shape**: the
 * current surface has no generic and no repeated name, so the arity filter and the `byName` dedup
 * both measure zero. Neither is speculative — a generic public type is ordinary and a name collision
 * across two modules is what test 4 exists for — but treat them as untested when either first fires.
 * The dedup in particular keeps the FIRST declaration seen for a name, so if a name ever does arrive
 * from two declarations with different arities it can alias the wrong one.
 */
function renderSurfaceProbe(required: SurfaceType[]): string {
  const byName = new Map<string, SurfaceType>();
  for (const type of required) if (!byName.has(type.name)) byName.set(type.name, type);
  const names = [...byName.keys()].sort();
  const imports = names.map((name) => `  ${name},`).join('\n');
  const aliases = names
    .filter((name) => byName.get(name)!.arity === 0)
    .map((name) => `export type ${ALIAS_PREFIX}${name} = ${name};`)
    .join('\n');
  return `import type {\n${imports}\n} from '@gaunt-sloth/core';\n\n${aliases}\n`;
}

/**
 * A typed approval handler, written the way an embedder writes one.
 *
 * The derived probe proves each name resolves; this one is the scenario the surface exists for,
 * and it is the measurement behind the `typeof` exclusion in the docblock: `RaterOutcome` and
 * `ShellSafetyVerdict` are used WITHOUT importing `RATER_OUTCOMES` or `ShellSafetyVerdictSchema`,
 * the runtime values their declarations derive from. This file compiling is what says a consumer
 * never needs either value in scope.
 */
const PROBE = `import type {
  ApprovalSubject,
  DeclaredToolAnnotations,
  GthAgentInterface,
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

export const declaredBy = (
  agent: GthAgentInterface
): ReadonlyMap<string, DeclaredToolAnnotations> | undefined =>
  agent.getDeclaredMcpToolAnnotations?.();

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
 * It names none of the derived types on purpose, so that each test here fails for its own reason: a
 * dropped re-export is the surface test's failure, and this one keeps saying only whether the
 * checker still bites.
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
  requireBuiltBarrel();

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
  it('matches the committed golden of the derived surface, name for name', () => {
    // The primary guard, and the only one here that sees a derivation which came back SMALLER than
    // it should have. `describeSurfaceDrift` is what turns the situations an equality failure
    // conflates — a type added, a type vanished, a type still here but bound to a different
    // declaration — into different sentences with different advice;
    // the drift specs in coreTypeSurfaceGolden.spec.ts pin that wording, because a message nobody
    // ever reads is a message nobody notices going wrong.
    const derived = toGoldenDocument(deriveSurface());
    const committed = readGoldenDocument();

    // The drift report is the received value rather than the message, so it is printed once: the
    // message says which file disagrees, and the report itself says how and what to do about it.
    const drift = describeSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the derived surface`
    ).toBeNull();

    // The drift report reads the two name lists. This says the file as a whole is what the
    // generator writes, so a hand-edit anywhere in it — including to the header that tells the
    // next reader how to regenerate — is a failure rather than a silent divergence.
    expect(
      committed,
      `${GOLDEN_PATH} is not what the generator writes: ${REGENERATE_COMMAND}`
    ).toEqual(derived);
  });

  it('refuses a degenerate derivation, and rejects each shape one can take', () => {
    // `deriveSurface` has already run this on the real surface — reaching this line at all is the
    // positive half. The rest is the half that matters: a guard nothing ever fails is a guard
    // nobody can trust, so each degenerate shape is fed in by hand and must be named in the throw.
    const real = deriveSurface();

    expect(() => assertNonDegenerate({ ...real, walked: 0 })).toThrow(/never started/);
    expect(() => assertNonDegenerate({ ...real, unresolvedReferences: 1 })).toThrow(
      /could not resolve to a name/
    );
    expect(() => assertNonDegenerate({ ...real, required: real.required.slice(0, 1) })).toThrow(
      /derived only 1 types, below the floor/
    );

    // The case a count floor cannot see, and the reason the tree check exists: dropping the whole
    // `config` tree silently un-checks more than half the surface and still clears the floor.
    const withoutConfig = real.required.filter((type) => !type.file.startsWith('config/'));
    expect(withoutConfig.length).toBeGreaterThanOrEqual(MIN_DERIVED_TYPES);
    expect(() => assertNonDegenerate({ ...real, required: withoutConfig })).toThrow(
      /reached no declaration under config/
    );
  });

  it('names every derived type in the generated probe', () => {
    // The generated probe is the pin, and this is the only test that reads it as text. A renderer
    // that dropped names would shrink the checked surface without failing anything, because an
    // empty probe type-checks clean.
    const { required } = deriveSurface();
    const probe = renderSurfaceProbe(required);
    for (const type of required) {
      expect(probe, `${type.name} is missing from the generated probe's import list`).toContain(
        `  ${type.name},\n`
      );
      if (type.arity === 0) {
        expect(probe, `${type.name} is imported but never used in a type position`).toContain(
          `= ${type.name};`
        );
      }
    }
  });

  it('lets an embedder name every type the public surface hands out', () => {
    const { required } = deriveSurface();
    const { status, output } = typeCheck(renderSurfaceProbe(required));
    expect(output).toBe('');
    expect(status).toBe(0);
  }, 120_000);

  it('binds each derived name to the declaration the surface actually reaches', () => {
    // The generated probe answers "does this name resolve"; this answers "does it resolve to the
    // right thing", which a name-only comparison cannot. Two distinct declarations sharing a name
    // — one exported, one reached — would satisfy the compiler and be reported here.
    const { required, unexported } = deriveSurface();
    const unnameable = required
      .filter((type) => !type.nameable)
      .map((type) => `${type.name} (${type.file}, reached from ${type.reachedFrom})`);
    const skipped = unexported.map((type) => `${type.name} (${type.file})`);
    expect(
      unnameable,
      `re-export each of these from the core barrel. Reachable declarations emitted WITHOUT an export modifier are outside this assertion by the mechanism in the docblock, and today they are: ${skipped.join(', ') || 'none'}`
    ).toEqual([]);
  });

  it('lets an embedder name every type a typed approval handler receives', () => {
    const { status, output } = typeCheck(PROBE);
    expect(output).toBe('');
    expect(status).toBe(0);
  }, 120_000);

  it('pins the handwritten probe: the typeof mechanism, and the name no derivation can require', () => {
    // The test above only says the probe compiles, and it would compile just as happily with names
    // quietly removed from it. This reads it as text, for the two things the derived pin cannot
    // cover on its own.

    // One: what licenses the `typeof` exclusion in the docblock. The probe compiles while naming
    // neither runtime value, so the exclusion is a measured mechanism rather than an opinion.
    expect(PROBE).toContain(': RaterOutcome');
    expect(PROBE).toContain(': ShellSafetyVerdict');
    expect(PROBE).not.toContain('RATER_OUTCOMES');
    expect(PROBE).not.toContain('ShellSafetyVerdictSchema');
    expect(deriveSurface().typeofReferents).toEqual(
      expect.arrayContaining(['RATER_OUTCOMES', 'ShellSafetyVerdictSchema'])
    );

    // Two: `ToolApprovalCallback` is the one name in the embedder scenario the derivation can never
    // demand. Nothing reachable from the barrel is declared to be one — it is a callback an
    // embedder passes IN — so it is absent from `required` by construction, and deleting it from
    // the probe would otherwise leave every test green. This line is its only guard.
    expect(PROBE).toContain('  ToolApprovalCallback,\n');
    expect(PROBE).toContain(': ToolApprovalCallback');
  });

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
});
