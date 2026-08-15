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
 * - A type referenced through the inline `import("./other").MyType` form the emitter reaches for
 *   when a declaration has no top-level import to reuse, as well as through an ordinary named
 *   reference or a heritage clause.
 * - **Its own TOTAL collapse.** {@link assertNonDegenerate} runs inside {@link deriveSurface},
 *   before the result is memoised, so a derivation that walked nothing, resolved a reference shape
 *   it did not recognise, fell under the floor, or missed a whole tree is refused rather than
 *   handed out. That placement is deliberate: the pin below type-checks a *generated* probe, and an
 *   empty probe type-checks clean, so a check that lived only beside it would let the assertion
 *   this file exists for pass while the derivation had collapsed. The word `total` is doing real
 *   work — a derivation that shrinks without emptying is a different case, and it is the first
 *   entry in the list below.
 *
 * ## What it does NOT catch — stated because the temptation is to overstate it
 *
 * - **A PARTIAL collapse of the derivation.** The guards above refuse a walk that returns nothing
 *   or misses a whole tree; they do not notice one that returns most of itself. Both
 *   {@link MIN_DERIVED_TYPES} and {@link REQUIRED_TREES} are thresholds, and a threshold cannot see
 *   a proportional loss: the floor sits at 40 against a real 103, and one surviving declaration
 *   satisfies a tree. The measurement, because the size of the hole is the point — dropping a
 *   single flag from `NAMED_TYPE` (the `TypeAlias` bit) leaves `walked` at 225 and no unresolved
 *   reference, so all four guards pass and THE PIN ITSELF STAYS GREEN, while `required` falls from
 *   103 to 65: 38 types silently stop being checked, among them `RaterOutcome`,
 *   `ShellSafetyVerdict` and `GthOutputHeaderRung`. Closing this needs a guard measured against
 *   something that moves with the API rather than a fixed number, and the obvious candidate — the
 *   barrel's own export count — would put part of the expectation back where this file spent its
 *   whole existence taking it out of. So it is stated here rather than half-solved. What the guards
 *   below give you is that an emptied derivation cannot be handed out as a result; they do not tell
 *   you the derived set is the whole surface.
 * - **Narrowing the barrel itself.** The walk is seeded from the barrel's exports, so deleting a
 *   public export removes both the name and every obligation its type graph created. "Reachable
 *   implies nameable" has nothing to say once a thing stops being reachable, and no derivation
 *   from the built artifact can distinguish a deliberate narrowing from a smaller API. The
 *   magnitude is worth knowing rather than guessing: deleting one `export *` line from
 *   `src/index.ts` drops 22 names from the barrel and the whole unit suite stays green.
 * - **A rename at the declaration.** Renaming a public type breaks every embedder's import, and
 *   the derivation simply follows the new name, so nothing here reacts. It is irreducible for a
 *   derived oracle — the only defence is naming a type in text, which is what the handwritten
 *   probe below does for the twelve names it carries.
 * - **A type emitted without an `export` modifier at its own declaration.** It is nameable by no
 *   route at all, so no barrel re-export could fix it, and it is excluded here on that mechanism —
 *   the modifier flags read off the emitted node, not an opinion about the type.
 *   `ApprovalEntryCommon` in `config/shell-policy.d.ts` is the standing instance, and a failure
 *   below names whatever the current set is. This is a standing escape hatch, not just a listing
 *   quirk: deleting that one keyword removes a type from the public surface with no test reaction.
 *   Dropping it from a type the barrel currently re-exports fails the build instead; dropping it
 *   from one reached only by an inline reference is silent.
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
  /**
   * Nodes met in a type-reference position whose form the resolver could not turn into a name.
   * Must be zero: an unrecognised shape is a type this walk skipped **silently**, which shrinks the
   * derived surface without shrinking the barrel — the failure mode this whole spec exists to stop,
   * arriving through the walk instead of through a list.
   *
   * It counts the positions the walk **enters**. A node form the walk does not recognise as a
   * reference position at all never reaches the counter — see the qualifier-less `typeof
   * import(...)` noted at the import-type branch — so zero here says the resolver named everything
   * it looked at, which is a weaker statement than nothing having escaped it.
   */
  unresolvedReferences: number;
}

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a derivation that
 * returns nothing — a walk that never starts, a resolver that stops seeing this package's own
 * files, a filter inverted — makes every assertion below pass by checking nothing, exactly the way
 * an empty probe type-checks clean. The public surface reaches roughly a hundred named types, so a
 * legitimate API is nowhere near this number, and the breakages this number is chosen against
 * yield zero or a handful.
 *
 * A break that leaves most of the surface behind clears it comfortably and is meant to: measured,
 * one dropped symbol flag still derives 65. That is a threshold's nature rather than a bug in this
 * one, and it is stated as a limit in this file's docblock instead of being papered over here.
 */
const MIN_DERIVED_TYPES = 40;

/**
 * Directories the walk must have reached, selected by where a declaration lives rather than by its
 * name. A count floor alone is not enough and that is measured, not assumed: dropping the whole
 * `config` tree still leaves 47 types, which clears the floor while silently un-checking more than
 * half the surface. Each entry here is a tree the public surface is genuinely written in, so a
 * derivation that missed one crossed fewer module boundaries than the barrel does.
 */
const REQUIRED_TREES = ['config', 'core/approvals', 'core/shell'];

/**
 * Refuse a derivation that is degenerate rather than merely small.
 *
 * This is called by {@link deriveSurface} **before it memoises**, so every consumer inherits it and
 * no edit to a single test can make the pin vacuous. That placement is the point: the pin itself —
 * type-checking the generated probe — passes on an empty probe, so if this check lived only beside
 * it, the assertion that is the reason for this file could hold while the derivation had collapsed,
 * and only some other test's failure would say so.
 *
 * Its reach is stated where the rest of the file's limits are: these four checks refuse a walk that
 * collapsed to nothing, not one that came back smaller than it should have.
 *
 * It throws rather than returning a verdict because a degenerate derivation is not a result.
 */
function assertNonDegenerate(surface: DerivedSurface): void {
  if (surface.walked === 0) {
    throw new Error(
      'the type-surface walk never started: no barrel export resolved to a declaration inside this package'
    );
  }
  if (surface.unresolvedReferences > 0) {
    throw new Error(
      `the type-surface walk met ${surface.unresolvedReferences} reference position(s) it could not resolve to a name, so it skipped them silently — teach the resolver that shape rather than letting the derived surface shrink`
    );
  }
  if (surface.required.length < MIN_DERIVED_TYPES) {
    throw new Error(
      `the type-surface walk derived only ${surface.required.length} types, below the floor of ${MIN_DERIVED_TYPES} — this is a broken walk, not a small API`
    );
  }
  const reachedTrees = new Set(surface.required.map((type) => path.posix.dirname(type.file)));
  const missing = REQUIRED_TREES.filter(
    (tree) => ![...reachedTrees].some((dir) => dir === tree || dir.startsWith(`${tree}/`))
  );
  if (missing.length > 0) {
    throw new Error(
      `the type-surface walk reached no declaration under ${missing.join(', ')} — it did not cross the module boundaries the public surface is written across`
    );
  }
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
  /**
   * Is this declaration one of ours?
   *
   * Asked through `path.relative` rather than by comparing prefixes, because the two paths are
   * built by different machinery and do not agree on separators: `DIST_DIR` comes from
   * `fileURLToPath` and `path.join`, which give backslashes on win32, while a `SourceFile.fileName`
   * is whatever the compiler's own normalizer produced — always forward-slashed. A prefix test
   * matches nothing there, and the resulting empty derivation is indistinguishable from a broken
   * walk. `path.relative` resolves both sides first, so it is separator-agnostic, and its result
   * also rules out a sibling directory whose name merely starts with `dist`.
   */
  const insideThisPackage = (file: string) => {
    const relative = path.relative(DIST_DIR, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
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
  let unresolvedReferences = 0;
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
      else if (ts.isExpressionWithTypeArguments(node)) {
        // `extends Foo` / `implements Foo`. Taken whatever its shape: a dotted heritage name is a
        // PropertyAccessExpression here rather than a QualifiedName, and an identifier-only guard
        // would drop it without a word.
        named = node.expression;
      } else if (ts.isImportTypeNode(node) && node.qualifier) {
        // `import("./other").MyType` — the inline form the emitter reaches for when a declaration
        // has no top-level import to reuse. It is an ordinary type reference wearing a module
        // specifier, and skipping it would let a type leave the barrel unnoticed.
        //
        // Unexercised in both directions today, and worth knowing before trusting it: this package
        // emits six inline imports, all in one file, and every one resolves outside the package, so
        // the branch contributes no name and the `isTypeOf` arm just below has never run. The one
        // shape deliberately left outside the count is a qualifier-less `typeof import("./other")`,
        // which names a whole MODULE rather than a type: the test above does not admit it, nothing
        // after it does either, and it is therefore skipped without reaching
        // `unresolvedReferences`. Zero of those are emitted here — a known hole, not a measured
        // one, and the honest edge on "counted, never ignored" below.
        if (node.isTypeOf) {
          // `typeof import("./other").thing` is a value query, and follows the rule below it.
          typeofReferents.add(node.getText());
          return;
        }
        named = node.qualifier;
      }
      if (named) {
        // A bare name resolves on itself; `A.B.C` resolves on its last identifier, which is spelled
        // `right` in a type position and `name` in an expression position.
        let token: any;
        if (ts.isIdentifier(named)) token = named;
        else if (ts.isQualifiedName(named)) token = named.right;
        else if (ts.isPropertyAccessExpression(named)) token = named.name;

        if (!token) {
          // Counted, never ignored — for every position the walk enters, which is the whole of
          // what the counter claims: see DerivedSurface.unresolvedReferences.
          unresolvedReferences += 1;
        } else {
          const symbol = checker.getSymbolAtLocation(token);
          const target = symbol ? unalias(symbol) : undefined;
          // A type parameter is a name, not an export; NAMED_TYPE is what filters it out.
          if (target && target.flags & NAMED_TYPE) {
            for (const found of target.declarations ?? []) {
              const file = found.getSourceFile().fileName;
              if (!insideThisPackage(file)) continue;
              // Enqueued exactly when first reached — `walked` already makes a second visit a
              // no-op, so a repeat push is only queue bloat for a widely referenced type.
              //
              // The transitive step this push exists for is INERT on today's surface, which is
              // measured rather than assumed: every required type is itself a barrel export and so
              // is already a seed, and deleting the push leaves the derived set byte-identical —
              // the same 103 required, the same one unexported, no name lost — moving only `walked`
              // (225 to 224). The property is right and will earn its keep the first time a type
              // reaches the surface without being exported from the barrel in its own right; until
              // then, treat the line as correct and untested rather than as dead code to tidy away.
              if (!reached.has(found)) {
                reached.set(found, {
                  name: target.name,
                  file: path.relative(DIST_DIR, file).split(path.sep).join('/'),
                  reachedFrom,
                  arity: (found.typeParameters ?? []).filter((parameter: any) => !parameter.default)
                    .length,
                  exported: Boolean(ts.getCombinedModifierFlags(found) & ts.ModifierFlags.Export),
                });
                queue.push({ declaration: found, reachedFrom });
              }
            }
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

  const surface: DerivedSurface = {
    required,
    unexported,
    typeofReferents: [...typeofReferents].sort(),
    walked: walked.size,
    unresolvedReferences,
  };
  // Before the memo, so no consumer can ever read a degenerate surface.
  assertNonDegenerate(surface);
  derived = surface;
  return derived;
}

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
