import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * The set of types this file demands is **derived, never listed**. {@link deriveSurface} walks the
 * emitted declarations with the compiler API: it seeds on the barrel's own exported declarations
 * and follows every *type reference* out of them, transitively, keeping the named types whose
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
 * ## What this pin catches
 *
 * - A type reachable from the public surface that the barrel cannot name, however it got that way,
 *   including a coordinated removal from every place a name is written.
 * - A barrel export that carries the right *name* for a different *declaration* than the one the
 *   surface reaches, which a name-only comparison reads as satisfied.
 * - A break in the package `exports` map or the declaration emit, because the probe imports by
 *   package name from outside rather than by path from inside.
 *
 * ## What it does NOT catch — stated because the temptation is to overstate it
 *
 * - **Narrowing the barrel itself.** The walk is seeded from the barrel's exports, so deleting a
 *   public export removes both the name and every obligation its type graph created. "Reachable
 *   implies nameable" has nothing to say once a thing stops being reachable, and no derivation
 *   from the built artifact can distinguish a deliberate narrowing from a smaller API.
 * - **A type emitted without an `export` modifier at its own declaration.** It is nameable by no
 *   route at all, so no barrel re-export could fix it, and it is excluded here on that mechanism —
 *   the modifier flags read off the emitted node, not an opinion about the type.
 *   `ApprovalEntryCommon` in `config/shell-policy.d.ts` is the standing instance, and a failure
 *   below names whatever the current set is. Dropping `export` from a type the barrel
 *   currently re-exports fails the build instead; dropping it from one reached only by an inline
 *   reference would move that type into this exclusion silently.
 * - **Values named only through `typeof`.** A `typeof X` query in an emitted `.d.ts` resolves
 *   inside the file it was emitted into, so an embedder naming the alias never needs `X` in scope
 *   — measured by the handwritten probe below, which uses `RaterOutcome` and `ShellSafetyVerdict`
 *   with neither `RATER_OUTCOMES` nor `ShellSafetyVerdictSchema` imported. The pin therefore says
 *   nothing about whether those values themselves can be imported.
 * - **Anonymous structure.** Only named types can be exported, so an inlined object type is
 *   reachable, nameable by nobody, and correctly not required.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with the message below rather than with a type
 * error, so the cause is named. It reads whatever `dist/` holds: on a tree built before an edit to
 * `src/`, this checks the older declarations, as any artifact probe does.
 *
 * **Windows reads a failure here the same way it reads a real one.** That self-name walk is what a
 * red cell would break first, and an unresolved import surfaces as the same TS2305/TS2307 a dropped
 * export does. A cell that is red only on Windows is about resolution, not about the barrel.
 */

const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = path.join(CORE_DIR, 'dist');
const DIST_BARREL = path.join(DIST_DIR, 'index.d.ts');

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

/**
 * The same devDependency, loaded as a library for the derivation. Reached through `createRequire`
 * for the same reason as the line above rather than imported: this package declares no dependency
 * on `typescript`, and the spec tree is not part of its build.
 */
const ts = requireHere('typescript');

/** Fail with the cause rather than with whatever a missing artifact makes the next call throw. */
function requireBuiltBarrel(): void {
  expect(
    existsSync(DIST_BARREL),
    `${DIST_BARREL} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
  ).toBe(true);
}

/** One named type the public surface reaches, as plain data — no compiler nodes escape. */
interface SurfaceType {
  /** The name the declaration is written under, and the name an embedder would import. */
  name: string;
  /** Declaring file, relative to `dist/`. */
  file: string;
  /** A barrel export whose declaration the walk followed to get here. */
  reachedFrom: string;
  /** Required type parameters. A generic type cannot be aliased bare in the generated probe. */
  arity: number;
  /** Whether the barrel exports this name AND binds it to this very declaration. */
  nameable: boolean;
}

interface DerivedSurface {
  /** Types the barrel is obliged to export: reachable, and exported from their own module. */
  required: SurfaceType[];
  /** Reachable but emitted unexported, so unnameable by any route — see the docblock. */
  unexported: SurfaceType[];
  /** Names reached only through a `typeof` query, recorded rather than followed. */
  typeofReferents: string[];
  /** Declarations the walk visited. Zero would mean it never started. */
  walked: number;
}

let derived: DerivedSurface | undefined;

/**
 * Walk the built declarations and answer which of this package's named types the public surface
 * hands out.
 *
 * The seeds are the barrel's exported *declarations*; everything after that comes from type
 * references written in the source modules. The barrel's export list is consulted exactly once, at
 * the end, to fill in {@link SurfaceType.nameable} — which is the property under test, not the
 * source of the expectation.
 */
function deriveSurface(): DerivedSurface {
  if (derived) return derived;
  requireBuiltBarrel();

  const program = ts.createProgram([DIST_BARREL], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const barrelFile = program.getSourceFile(DIST_BARREL);
  if (!barrelFile) throw new Error(`${DIST_BARREL} exists but the compiler did not load it`);
  const barrelSymbol = checker.getSymbolAtLocation(barrelFile);
  if (!barrelSymbol) throw new Error(`${DIST_BARREL} declares no module — it exports nothing`);
  const barrelExports = checker.getExportsOfModule(barrelSymbol);

  const unalias = (symbol: any) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const insideThisPackage = (file: string) => file.startsWith(DIST_DIR + path.sep);
  const NAMED_TYPE =
    ts.SymbolFlags.TypeAlias |
    ts.SymbolFlags.Interface |
    ts.SymbolFlags.Enum |
    ts.SymbolFlags.Class;

  // What the barrel makes nameable: name -> the declarations that name binds to.
  const boundByBarrel = new Map<string, Set<any>>();
  for (const exported of barrelExports) {
    const target = unalias(exported);
    const bound = boundByBarrel.get(exported.name) ?? new Set<any>();
    for (const declaration of target.declarations ?? []) bound.add(declaration);
    boundByBarrel.set(exported.name, bound);
  }

  const reached = new Map<any, Omit<SurfaceType, 'nameable'> & { exported: boolean }>();
  const walked = new Set<any>();
  const typeofReferents = new Set<string>();
  const queue: { declaration: any; reachedFrom: string }[] = [];

  for (const exported of barrelExports) {
    for (const declaration of unalias(exported).declarations ?? []) {
      if (insideThisPackage(declaration.getSourceFile().fileName)) {
        queue.push({ declaration, reachedFrom: exported.name });
      }
    }
  }

  while (queue.length > 0) {
    const { declaration, reachedFrom } = queue.shift()!;
    if (walked.has(declaration)) continue;
    walked.add(declaration);

    const visit = (node: any): void => {
      if (ts.isTypeQueryNode(node)) {
        // `typeof X` — the referent is a value, resolved inside the file it was emitted into.
        typeofReferents.add(node.exprName.getText());
        return;
      }
      let named: any = null;
      if (ts.isTypeReferenceNode(node)) named = node.typeName;
      else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
        named = node.expression; // `extends Foo` / `implements Foo`
      }
      if (named) {
        // `A.B.C` resolves on its last identifier; a bare name resolves on itself.
        const token = ts.isIdentifier(named) ? named : named.right;
        const symbol = checker.getSymbolAtLocation(token);
        const target = symbol ? unalias(symbol) : undefined;
        // A type parameter is a name, not an export; NAMED_TYPE is what filters it out.
        if (target && target.flags & NAMED_TYPE) {
          for (const found of target.declarations ?? []) {
            const file = found.getSourceFile().fileName;
            if (!insideThisPackage(file)) continue;
            if (!reached.has(found)) {
              reached.set(found, {
                name: target.name,
                file: path.relative(DIST_DIR, file).split(path.sep).join('/'),
                reachedFrom,
                arity: (found.typeParameters ?? []).filter((parameter: any) => !parameter.default)
                  .length,
                exported: Boolean(ts.getCombinedModifierFlags(found) & ts.ModifierFlags.Export),
              });
            }
            queue.push({ declaration: found, reachedFrom });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(declaration, visit);
  }

  const required: SurfaceType[] = [];
  const unexported: SurfaceType[] = [];
  for (const [declaration, info] of reached) {
    const entry: SurfaceType = {
      name: info.name,
      file: info.file,
      reachedFrom: info.reachedFrom,
      arity: info.arity,
      nameable: Boolean(boundByBarrel.get(info.name)?.has(declaration)),
    };
    (info.exported ? required : unexported).push(entry);
  }
  required.sort((a, b) => a.name.localeCompare(b.name));
  unexported.sort((a, b) => a.name.localeCompare(b.name));

  derived = {
    required,
    unexported,
    typeofReferents: [...typeofReferents].sort(),
    walked: walked.size,
  };
  return derived;
}

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a derivation that
 * returns nothing — a walk that never starts, a resolver that stops seeing this package's own
 * files, a filter inverted — makes every assertion below pass by checking nothing, exactly the way
 * an empty probe type-checks clean. The public surface reaches roughly a hundred named types, so a
 * legitimate API is nowhere near this number, and a broken walk yields zero or a handful.
 */
const MIN_DERIVED_TYPES = 40;

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
  it('derives a public type surface from the built declarations rather than an empty set', () => {
    const { required, walked } = deriveSurface();
    expect(walked).toBeGreaterThan(0);
    expect(required.length).toBeGreaterThanOrEqual(MIN_DERIVED_TYPES);

    // Selected by declaring directory, not by name: the walk has to leave the barrel's own file
    // and cross into the trees the public types are actually declared in, or it derived nothing
    // that a hand-written list would not already have contained.
    const treesReached = new Set(required.map((type) => path.posix.dirname(type.file)));
    expect(
      [...treesReached].filter((dir) => dir.startsWith('core/approvals')).length
    ).toBeGreaterThan(0);
    expect([...treesReached].filter((dir) => dir.startsWith('core/shell')).length).toBeGreaterThan(
      0
    );
    expect([...treesReached].filter((dir) => dir.startsWith('config')).length).toBeGreaterThan(0);
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

  it('names the typeof-derived types without their runtime referents in scope', () => {
    // This pairs with the test above and is what licenses the `typeof` exclusion in the docblock:
    // the probe compiles while naming neither value, so excluding them from the derived surface is
    // a measured mechanism rather than an opinion.
    expect(PROBE).toContain(': RaterOutcome');
    expect(PROBE).toContain(': ShellSafetyVerdict');
    expect(PROBE).not.toContain('RATER_OUTCOMES');
    expect(PROBE).not.toContain('ShellSafetyVerdictSchema');
    expect(deriveSurface().typeofReferents).toEqual(
      expect.arrayContaining(['RATER_OUTCOMES', 'ShellSafetyVerdictSchema'])
    );
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
