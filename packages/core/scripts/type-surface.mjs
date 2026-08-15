/**
 * Derive the core package's public TYPE surface from its built declarations, and compare that
 * derivation against the committed golden in `spec/coreBarrelTypeSurface.golden.json`.
 *
 * This module is the single implementation shared by the two things that must never disagree:
 * `generate-type-surface.mjs`, which writes the golden, and `spec/coreBarrelTypeSurface.spec.ts`,
 * which asserts the golden still describes the surface. The spec's docblock is where the whole
 * design is written down — what the walk derives, why the expectation is derived rather than
 * listed, and what the pin does and does not catch. Read that first; this file is the mechanism.
 *
 * **No shebang, and no top-level side effects.** Vitest inlines a non-`node_modules` `.mjs` and
 * evaluates it inside an AsyncFunction wrapper, where a surviving shebang is a hard `SyntaxError`
 * — and on the path Vitest takes for absolute Windows paths the shebang strip does not apply, so
 * it fails on the Windows cell alone (OPS-26). The executable half lives in the sibling CLI entry;
 * this half is a library the spec can import on every platform.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireHere = createRequire(import.meta.url);

/**
 * The TypeScript devDependency, loaded as a library. Reached through `createRequire` rather than
 * imported because this package declares no dependency on `typescript`: it is the repo's build
 * tool, and neither this file nor the spec tree is part of what the package ships.
 */
const ts = requireHere('typescript');

/** The `packages/core` directory — this file lives one level down, in `scripts/`. */
export const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DIST_DIR = path.join(CORE_DIR, 'dist');
export const DIST_BARREL = path.join(DIST_DIR, 'index.d.ts');

/** The committed golden: the derived name set as it was last reviewed. */
export const GOLDEN_PATH = path.join(CORE_DIR, 'spec', 'coreBarrelTypeSurface.golden.json');

/** The derivation reads the built declarations, so a regeneration is only as fresh as `dist/`. */
export const BUILD_COMMAND = 'pnpm --filter @gaunt-sloth/core run build';

/**
 * The one command that rewrites the golden, named verbatim in every failure message so nobody has
 * to go looking for it.
 */
export const REGENERATE_COMMAND = `${BUILD_COMMAND} && pnpm --filter @gaunt-sloth/core run surface:generate`;

/** Header written into the golden, so the file says what it is to whoever opens it first. */
export const GOLDEN_COMMENT = `GENERATED — do not hand-edit. The public type surface derived from packages/core/dist by scripts/type-surface.mjs, and compared against this file by spec/coreBarrelTypeSurface.spec.ts. Regenerate with: ${REGENERATE_COMMAND}`;

/** Fail with the cause rather than with whatever a missing artifact makes the next call throw. */
export function requireBuiltBarrel() {
  if (!existsSync(DIST_BARREL)) {
    throw new Error(
      `${DIST_BARREL} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
    );
  }
}

/**
 * @typedef {object} SurfaceType One named type the public surface reaches, as plain data.
 * @property {string} name The name the declaration is written under, and the name an embedder
 *   would import.
 * @property {string} file Declaring file, relative to `dist/`.
 * @property {string} reachedFrom A barrel export whose declaration the walk followed to get here.
 * @property {number} arity Required type parameters. A generic type cannot be aliased bare in the
 *   generated probe.
 * @property {boolean} nameable Whether the barrel exports this name AND binds it to this very
 *   declaration.
 */

/**
 * @typedef {object} DerivedSurface
 * @property {SurfaceType[]} required Types the barrel is obliged to export: reachable, and
 *   exported from their own module.
 * @property {SurfaceType[]} unexported Reachable but emitted unexported, so unnameable by any
 *   route — see the spec's docblock.
 * @property {string[]} typeofReferents Names reached only through a `typeof` query, recorded
 *   rather than followed.
 * @property {number} walked Declarations the walk visited. Zero would mean it never started.
 * @property {number} unresolvedReferences Nodes met in a type-reference position whose form the
 *   resolver could not turn into a name. Must be zero: an unrecognised shape is a type this walk
 *   skipped **silently**, which shrinks the derived surface without shrinking the barrel — the
 *   failure mode the whole spec exists to stop, arriving through the walk instead of through a
 *   list.
 *
 *   It counts the positions the walk **enters**. A node form the walk does not recognise as a
 *   reference position at all never reaches the counter — see the qualifier-less `typeof
 *   import(...)` noted at the import-type branch — so zero here says the resolver named everything
 *   it looked at, which is a weaker statement than nothing having escaped it.
 */

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a derivation that
 * returns nothing — a walk that never starts, a resolver that stops seeing this package's own
 * files, a filter inverted — makes every assertion in the spec pass by checking nothing, exactly
 * the way an empty probe type-checks clean.
 *
 * It is deliberately far below the real surface, and it is no longer the guard against a surface
 * that merely shrank: the golden is. What this number still buys is a *legible* failure for a
 * collapse — "this is a broken walk, not a small API" is the right sentence to read when the walk
 * comes back with three types, and an equality diff listing a hundred missing names is not.
 */
export const MIN_DERIVED_TYPES = 40;

/**
 * Directories the walk must have reached, selected by where a declaration lives rather than by its
 * name. A count floor alone is not enough and that is measured, not assumed: dropping the whole
 * `config` tree still leaves enough types to clear the floor, which silently un-checks more than
 * half the surface. Each entry here is a tree the public surface is genuinely written in, so a
 * derivation that missed one crossed fewer module boundaries than the barrel does.
 */
export const REQUIRED_TREES = ['config', 'core/approvals', 'core/shell'];

/**
 * Refuse a derivation that is degenerate rather than merely small.
 *
 * This is called by {@link deriveSurface} **before it memoises**, so every consumer inherits it —
 * including the generator, which must never write a collapsed walk into the golden and thereby
 * launder the collapse into the reviewed expectation.
 *
 * Its reach is exactly what it always was: these four checks refuse a walk that collapsed to
 * nothing, not one that came back smaller than it should have. That second case is the golden's
 * job. Keeping both is not redundancy — they fail for different reasons and say different
 * sentences, and this one is the cheap, legible check in front of the exact one.
 *
 * It throws rather than returning a verdict because a degenerate derivation is not a result.
 *
 * @param {DerivedSurface} surface
 */
export function assertNonDegenerate(surface) {
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

/** @type {DerivedSurface | undefined} */
let derived;

/**
 * Walk the built declarations and answer which of this package's named types the public surface
 * hands out.
 *
 * The seeds are the barrel's exported *declarations*; everything after that comes from type
 * references written in the source modules. The barrel's export list is consulted exactly once, at
 * the end, to fill in {@link SurfaceType.nameable} — which is the property under test, not the
 * source of the expectation.
 *
 * @returns {DerivedSurface}
 */
export function deriveSurface() {
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

  const unalias = (symbol) =>
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
  const insideThisPackage = (file) => {
    const relative = path.relative(DIST_DIR, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const NAMED_TYPE =
    ts.SymbolFlags.TypeAlias |
    ts.SymbolFlags.Interface |
    ts.SymbolFlags.Enum |
    ts.SymbolFlags.Class;

  // What the barrel makes nameable: name -> the declarations that name binds to.
  const boundByBarrel = new Map();
  for (const exported of barrelExports) {
    const target = unalias(exported);
    const bound = boundByBarrel.get(exported.name) ?? new Set();
    for (const declaration of target.declarations ?? []) bound.add(declaration);
    boundByBarrel.set(exported.name, bound);
  }

  const reached = new Map();
  const walked = new Set();
  const typeofReferents = new Set();
  let unresolvedReferences = 0;
  const queue = [];

  for (const exported of barrelExports) {
    for (const declaration of unalias(exported).declarations ?? []) {
      if (insideThisPackage(declaration.getSourceFile().fileName)) {
        queue.push({ declaration, reachedFrom: exported.name });
      }
    }
  }

  while (queue.length > 0) {
    const { declaration, reachedFrom } = queue.shift();
    if (walked.has(declaration)) continue;
    walked.add(declaration);

    const visit = (node) => {
      if (ts.isTypeQueryNode(node)) {
        // `typeof X` — the referent is a value, resolved inside the file it was emitted into.
        typeofReferents.add(node.exprName.getText());
        return;
      }
      let named = null;
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
        // emits inline imports in one file only, and every one resolves outside the package, so
        // the branch contributes no name and the `isTypeOf` arm just below has never run. The one
        // shape deliberately left outside the count is a qualifier-less `typeof import("./other")`,
        // which names a whole MODULE rather than a type: the test above does not admit it, nothing
        // after it does either, and it is therefore skipped without reaching
        // `unresolvedReferences`. None of those are emitted here — a known hole, not a measured
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
        let token;
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
              // The transitive step this push exists for is INERT on today's surface: every
              // required type is itself a barrel export and so is already a seed. Deleting the
              // push and regenerating the golden is now the way to re-measure that — if the golden
              // does not move, the line still earns its keep only as a property, not as reach.
              // Treat it as correct and untested rather than as dead code to tidy away; it will
              // start mattering the first time a type reaches the surface without being exported
              // from the barrel in its own right.
              if (!reached.has(found)) {
                reached.set(found, {
                  name: target.name,
                  file: path.relative(DIST_DIR, file).split(path.sep).join('/'),
                  reachedFrom,
                  arity: (found.typeParameters ?? []).filter((parameter) => !parameter.default)
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

  /** @type {SurfaceType[]} */
  const required = [];
  /** @type {SurfaceType[]} */
  const unexported = [];
  for (const [declaration, info] of reached) {
    /** @type {SurfaceType} */
    const entry = {
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

  /** @type {DerivedSurface} */
  const surface = {
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

/**
 * Order two golden entries by code units rather than by locale.
 *
 * `localeCompare` is what sorts the derivation for human reading, and it is the wrong tool for a
 * file that one machine writes and another compares: its order depends on the ICU data the
 * platform ships. A golden regenerated on Windows and compared on Linux must be byte-identical, so
 * the file's order is fixed here and never inherited from the walk.
 *
 * The fields are compared one after the other rather than joined into a single key. A joined key
 * needs a separator that sorts below every character a name can contain, which is a constraint
 * nobody reading the line can check; comparing field by field needs no separator and no argument.
 *
 * **The order runs over all three pinned fields on purpose, not just the two that identify a
 * declaration to a human.** Same-named entries are paired positionally by this order before they
 * are compared (see `differingFields`), so the order has to be total over everything a pair can
 * differ in. Two declarations of one name in one file — which today's surface does not have —
 * would otherwise tie, and a tie means the pairing depends on input order, which is how a report
 * invents a change that did not happen.
 */
function byNameFileArity(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return (a.arity ?? 0) - (b.arity ?? 0);
}

/**
 * Project a derivation onto the shape that gets committed.
 *
 * **What is in, and why it is a short list.** `name` is the point. `file` catches a name that
 * still resolves but now binds to a declaration in another module, which a name-only set reads as
 * unchanged. `arity` catches a public type gaining or losing a required type parameter, which is a
 * breaking change for every embedder that writes it bare.
 *
 * **What is deliberately out.** `reachedFrom` records which barrel export the walk happened to
 * arrive by, so it moves with queue order rather than with the API — a golden carrying it would
 * churn on edits that changed nothing. `nameable` is the property the spec's own assertion is
 * about, and freezing a `false` into the golden would turn a live failure into an accepted state.
 * `walked` is an internal counter, `typeofReferents` has its own assertion.
 *
 * @param {DerivedSurface} surface
 */
export function toGoldenDocument(surface) {
  const project = (types) =>
    types
      .map((type) => ({ name: type.name, file: type.file, arity: type.arity }))
      .sort(byNameFileArity);
  return {
    $comment: GOLDEN_COMMENT,
    required: project(surface.required),
    unexported: project(surface.unexported),
  };
}

/** Read the committed golden. Throws with the regeneration command if it is not there at all. */
export function readGoldenDocument() {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(`${GOLDEN_PATH} is missing — regenerate it with: ${REGENERATE_COMMAND}`);
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

/** `name (file)` — how one entry is named in a drift report. */
function label(entry) {
  return `${entry.name} (${entry.file}${entry.arity ? `, arity ${entry.arity}` : ''})`;
}

/**
 * Index one golden document's two lists by type name.
 *
 * Keyed by name rather than by name+file so that a type which MOVED between files reads as one
 * changed entry instead of a removal plus an unrelated addition — the difference between a report
 * that says "investigate, a type vanished" and one that says what actually happened. A name
 * carrying two declarations (which today's surface does not have) keeps both, and the comparison
 * below treats any difference in that group as a change.
 */
function indexByName(document) {
  const index = new Map();
  for (const list of ['required', 'unexported']) {
    for (const entry of document[list] ?? []) {
      const group = index.get(entry.name) ?? { required: [], unexported: [] };
      group[list].push(entry);
      index.set(entry.name, group);
    }
  }
  return index;
}

/** How a differing field is named in a drift report. */
const CHANGED_FIELD_LABEL = {
  file: 'moved file',
  arity: 'arity',
  declarations: 'declaration count',
};

/**
 * Which pinned fields differ between two groups of same-named entries — `[]` when none do.
 *
 * **Which fields, not merely whether any:** a name that moved file and a name that changed arity
 * are different events with different answers (one is usually a refactor, the other breaks every
 * embedder that writes the type bare), so the report cannot say what happened unless the
 * comparison keeps hold of that. Entries are paired positionally after a sort that is total over
 * the pinned fields, so the pairing is deterministic; when the two sides do not even hold the same
 * number of declarations there is no pairing to make, and the whole group is reported as one
 * `declarations` difference with both sides printed in full.
 */
function differingFields(left, right) {
  if (left.length !== right.length) return ['declarations'];
  const sortedLeft = [...left].sort(byNameFileArity);
  const sortedRight = [...right].sort(byNameFileArity);
  /** @type {Set<'file' | 'arity'>} */
  const fields = new Set();
  sortedLeft.forEach((entry, i) => {
    if (entry.file !== sortedRight[i].file) fields.add('file');
    if (entry.arity !== sortedRight[i].arity) fields.add('arity');
  });
  return [...fields];
}

/**
 * Say, in words a reader can act on, how the derived surface differs from the committed golden —
 * or `null` when it does not.
 *
 * **The whole reason this is not a bare deep-equality assertion:** the situations behind an
 * equality failure demand opposite responses, and `toEqual` renders them identically. Adding a
 * public type is ordinary work whose only correct answer is to regenerate the golden and commit
 * it. Losing one is the failure this golden exists to catch — the derivation quietly stopping
 * seeing part of the surface while every other check in the spec stays green — where regenerating
 * would erase the evidence and re-bless the loss.
 *
 * **There is a third case, and collapsing it into either of those is the same mistake one level
 * down.** A name that is still on the surface but bound differently — moved to another declaration
 * file, or gaining or losing a required type parameter — was neither lost nor added. Told it is an
 * addition, a reader regenerates and an arity break ships silently; told it is a loss, a reader
 * hunts a type that never went anywhere. So the report has three branches, it leads with the most
 * careful one that applies (loss, then rebinding, then addition), and only the addition branch
 * says the command is the whole answer.
 *
 * @param {ReturnType<typeof toGoldenDocument>} committed
 * @param {ReturnType<typeof toGoldenDocument>} current
 * @returns {string | null}
 */
export function describeSurfaceDrift(committed, current) {
  const before = indexByName(committed);
  const after = indexByName(current);

  const gone = [];
  const added = [];
  const lostExport = [];
  const gainedExport = [];
  const changed = [];

  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name);
    const is = after.get(name);
    if (!is) {
      gone.push(...was.required, ...was.unexported);
      continue;
    }
    if (!was) {
      added.push(...is.required, ...is.unexported);
      continue;
    }
    const side = (group) => [...group.required, ...group.unexported].map(label).join(' + ');
    const recordRebinding = (fields) => {
      if (fields.length === 0) return;
      changed.push({
        fields,
        text: `${name} [${fields.map((field) => CHANGED_FIELD_LABEL[field]).join(' + ')}]: ${side(was)} -> ${side(is)}`,
      });
    };

    if (was.required.length > 0 && is.required.length === 0) {
      // A lost export modifier is reported as a loss, which is the careful branch already: a
      // rebinding riding along with it cannot make the advice any less cautious than it is.
      lostExport.push(...is.unexported);
      continue;
    }
    if (was.unexported.length > 0 && is.unexported.length === 0) {
      gainedExport.push(...is.required);
      // A gained export modifier IS benign, and that is exactly why this line has to be here.
      // These are the same declarations, now exported; anything else that changed about them did
      // not become benign by arriving alongside the modifier, and without recording it an arity
      // break would be handed the "deliberate API addition, regenerate" advice.
      recordRebinding(differingFields(was.unexported, is.required));
      continue;
    }
    recordRebinding([
      ...new Set([
        ...differingFields(was.required, is.required),
        ...differingFields(was.unexported, is.unexported),
      ]),
    ]);
  }

  const names = (entries) => entries.map(label).sort().join(', ');
  const sections = [];
  if (gone.length > 0) {
    sections.push(`GONE from the derived surface (${gone.length}): ${names(gone)}`);
  }
  if (lostExport.length > 0) {
    sections.push(
      `NO LONGER EXPORTED at their own declaration, so nameable by no route (${lostExport.length}): ${names(lostExport)}`
    );
  }
  if (changed.length > 0) {
    const text = changed
      .map((change) => change.text)
      .sort()
      .join('; ');
    sections.push(`BOUND DIFFERENTLY (${changed.length}): ${text}`);
  }
  if (gainedExport.length > 0) {
    sections.push(
      `NEWLY EXPORTED at their own declaration (${gainedExport.length}): ${names(gainedExport)}`
    );
  }
  if (added.length > 0) {
    sections.push(`ADDED to the derived surface (${added.length}): ${names(added)}`);
  }
  if (sections.length === 0) return null;

  const lost = gone.length > 0 || lostExport.length > 0;
  const reboundFields = new Set(changed.flatMap((change) => change.fields));

  let headline;
  /** @type {string[]} */
  let advice;
  if (lost) {
    headline =
      'The derived public type surface LOST names the committed golden lists. Investigate before you regenerate.';
    advice = [
      'A type dropping out of the derivation is the failure this golden exists to catch: the walk',
      'stops seeing part of the surface, every other check in this spec stays green, and those',
      'types quietly stop being checked at all. Three benign causes to rule out first — a STALE',
      `dist/ (the walk reads the built declarations as-is, so rebuild and run again: ${BUILD_COMMAND}),`,
      'a deliberate narrowing of the public API, and a type that is still exported but',
      'NO LONGER REFERENCED by anything the barrel hands out: the derivation follows references, so',
      'a type nothing points at leaves the surface even though an embedder can still import it.',
      'Only once you have established which it is, and the removal is intended, regenerate the',
      `golden and commit it: ${REGENERATE_COMMAND}`,
    ];
  } else if (changed.length > 0) {
    headline = `The derived public type surface BOUND ${changed.length} name${changed.length === 1 ? '' : 's'} DIFFERENTLY than the committed golden. A name bound differently was neither lost nor added, so neither of the usual answers fits it.`;
    advice = [];
    if (reboundFields.has('arity')) {
      advice.push(
        'A type that gained or lost a REQUIRED TYPE PARAMETER breaks every embedder that writes it',
        'bare, which is the whole reason the golden pins arity. Establish that the new parameter',
        'list is what you meant before you accept it.'
      );
    }
    if (reboundFields.has('file')) {
      advice.push(
        'A type that MOVED to another declaration file is usually a refactor, and usually harmless:',
        'an embedder importing from the package root follows the move. It is not harmless for',
        'anything deep-importing the old path, and a half-rebuilt dist/ can move a declaration on',
        `its own, so rebuild and run again if the move is news: ${BUILD_COMMAND}`
      );
    }
    if (reboundFields.has('declarations')) {
      advice.push(
        'A name is DECLARED A DIFFERENT NUMBER OF TIMES than the golden records, so the two sides',
        'cannot be paired declaration by declaration; both are printed above in full.'
      );
    }
    advice.push(
      'Once the change is established as intended, regenerate the golden and commit it:',
      REGENERATE_COMMAND
    );
  } else {
    headline =
      'The derived public type surface no longer matches the committed golden, and nothing was lost.';
    advice = [
      'That is what a deliberate API addition looks like from here. Regenerate the golden and',
      `commit it alongside the change: ${REGENERATE_COMMAND}`,
    ];
  }

  return [headline, '', ...sections, '', advice.join('\n')].join('\n');
}
