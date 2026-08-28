/**
 * Derive the core package's public RUNTIME (value) surface from its built barrel, and compare that
 * derivation against the committed golden in `spec/coreBarrelValueSurface.golden.json`.
 *
 * This module is the single implementation shared by the two things that must never disagree:
 * `generate-value-surface.mjs`, which writes the golden, and `spec/coreBarrelValueSurface.spec.ts`,
 * which asserts the golden still describes the surface. The spec's docblock is where the design is
 * written down — what is pinned, why the expectation here is a committed snapshot rather than a
 * derivation from somewhere else, and what the pin does and does not catch. Read that first; this
 * file is the mechanism.
 *
 * It is the value-half twin of `type-surface.mjs`, and deliberately shares that file's shape:
 * a derivation, a degeneracy guard that runs before the memo, a projection onto a committed
 * document, and a drift reporter that says which KIND of change happened rather than only that
 * one did.
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const requireHere = createRequire(import.meta.url);

/**
 * The TypeScript devDependency, loaded as a library for the declared-class cross-check below.
 * Reached through `createRequire` rather than imported because this package declares no dependency
 * on `typescript`: it is the repo's build tool, and neither this file nor the spec tree is part of
 * what the package ships.
 */
const ts = requireHere('typescript');

/** The name an embedder writes. Resolved by SELF-REFERENCE, which is the point — see below. */
export const PACKAGE_NAME = '@gaunt-sloth/core';

/** The `packages/core` directory — this file lives one level down, in `scripts/`. */
export const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DIST_DIR = path.join(CORE_DIR, 'dist');
export const DIST_BARREL_JS = path.join(DIST_DIR, 'index.js');
export const DIST_BARREL_TYPES = path.join(DIST_DIR, 'index.d.ts');

/** The committed golden: the runtime name/kind set as it was last reviewed. */
export const GOLDEN_PATH = path.join(CORE_DIR, 'spec', 'coreBarrelValueSurface.golden.json');

/** The probe reads the built barrel, so a regeneration is only as fresh as `dist/`. */
export const BUILD_COMMAND = 'pnpm --filter @gaunt-sloth/core run build';

/**
 * The one command that rewrites the golden, named verbatim in every failure message so nobody has
 * to go looking for it.
 */
export const REGENERATE_COMMAND = `${BUILD_COMMAND} && pnpm --filter @gaunt-sloth/core run value-surface:generate`;

/** Header written into the golden, so the file says what it is to whoever opens it first. */
export const GOLDEN_COMMENT = `GENERATED — do not hand-edit. The public runtime (value) surface of the core barrel, read from packages/core/dist/index.js by scripts/value-surface.mjs and compared against this file by spec/coreBarrelValueSurface.spec.ts. Regenerate with: ${REGENERATE_COMMAND}`;

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a probe that imported
 * something other than the barrel — a stub, a half-written artifact, a resolver pointing somewhere
 * new — and came back with almost nothing, which would make every name assertion pass by checking
 * nothing. The golden is what sees a surface that merely shrank; this is what makes a total
 * collapse say the right sentence.
 */
export const MIN_VALUE_EXPORTS = 60;

/**
 * Kinds the classifier must actually distinguish on the real surface.
 *
 * This guard exists because {@link kindOf} is the one part of this derivation that can fail
 * SILENTLY and self-consistently: a classifier that returned `'object'` for everything would write
 * a self-consistent golden, compare clean forever, and never see a class demoted to a plain object
 * — the exact defect the kind field is here to catch. A collapsed classifier cannot satisfy this
 * list, so it is refused rather than blessed into the golden.
 */
export const REQUIRED_KINDS = ['class', 'function', 'object', 'string'];

/**
 * Fail with the cause rather than with whatever a missing artifact makes the next call throw.
 *
 * Both halves of the built barrel are required: the emitted JavaScript is the runtime surface this
 * file derives, and the emitted declarations are the independent oracle the class cross-check reads.
 */
export function requireBuiltBarrel() {
  for (const artifact of [DIST_BARREL_JS, DIST_BARREL_TYPES]) {
    if (!existsSync(artifact)) {
      throw new Error(
        `${artifact} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
      );
    }
  }
}

/**
 * Classify one exported value the way an embedder would care about it.
 *
 * **`class` is separated from `function` semantically, not by reading source text.** A class
 * constructor's own `prototype` property is non-writable; an ordinary function's is writable, and
 * an arrow function or concise method has no `prototype` at all. Sniffing `toString()` for a
 * leading `class` keyword would agree today and disagree the moment anything is minified or
 * re-emitted, and it reads a decompiled string where a property descriptor is the actual language
 * semantics.
 *
 * **Objects keep their internal tag** (`array`, `regexp`, `map`, …) rather than flattening to
 * `object`, because a public constant changing from an array to a plain object is a break for
 * every embedder that iterates it, and a pin that cannot see it is not worth the field.
 *
 * The kinds are what the emitted artifact IS, so they follow the build target: a build that
 * downlevelled classes to ES5 functions would move three names from `class` to `function` and be
 * reported as a kind change. That is correct — it is a real change to what an embedder receives.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function kindOf(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'function') {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'prototype');
    return descriptor && descriptor.writable === false ? 'class' : 'function';
  }
  if (type !== 'object') return type;
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === 'Object' ? 'object' : tag.toLowerCase();
}

/**
 * Resolve the package's own name to the file an embedder's `import` would load.
 *
 * This resolves by SELF-REFERENCE: Node walks up to this package's own `package.json` and matches
 * subpath `.` in its `exports` map, so nothing in `node_modules` and no workspace link takes part.
 * That is why the probe is worth more than reading `dist/index.js` by path — a break in the
 * `exports` map, or an `exports` map pointed at something that is not the built barrel, is exactly
 * the kind of packaging regression that reds nothing inside this repo where every module is
 * reachable by its own path.
 *
 * @returns {string} Absolute path to the resolved barrel.
 */
export function resolveBarrelEntry() {
  return requireHere.resolve(PACKAGE_NAME);
}

/**
 * Which names the barrel exports as CLASSES according to the emitted declarations.
 *
 * This is the independent oracle, and the reason it is worth the TypeScript dependency. A class is
 * both a type and a value, so a name the declarations call a class MUST also be importable as a
 * runtime value — an invariant whose two sides are written by different emitters into different
 * files. The expectation therefore does not come from the artifact under test, which is what
 * separates this cell from the golden's change-detection.
 *
 * Measured, and the reason this exists: rewriting one `export *` in `src/index.ts` as
 * `export type *` leaves the declarations byte-identical in surface — 238 exports, the same three
 * classes — while the emitted JavaScript silently drops five runtime exports including the class.
 * Every cell of the type-surface spec stays green through that change.
 *
 * @returns {string[]} Sorted class names.
 */
export function deriveDeclaredClasses() {
  requireBuiltBarrel();

  const program = ts.createProgram([DIST_BARREL_TYPES], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const barrelFile = program.getSourceFile(DIST_BARREL_TYPES);
  if (!barrelFile) throw new Error(`${DIST_BARREL_TYPES} exists but the compiler did not load it`);
  const barrelSymbol = checker.getSymbolAtLocation(barrelFile);
  if (!barrelSymbol)
    throw new Error(`${DIST_BARREL_TYPES} declares no module — it exports nothing`);

  const classes = [];
  for (const exported of checker.getExportsOfModule(barrelSymbol)) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (target.flags & ts.SymbolFlags.Class) classes.push(exported.name);
  }
  return classes.sort(byCodeUnit);
}

/**
 * @typedef {object} ValueExport One runtime export of the public barrel.
 * @property {string} name The name an embedder would import.
 * @property {string} kind What {@link kindOf} makes of its value.
 */

/**
 * @typedef {object} ValueSurface
 * @property {string} entry The resolved barrel, as Node's own resolution answered it.
 * @property {ValueExport[]} exports Every runtime export, sorted by name.
 * @property {string[]} declaredClasses Names the emitted declarations call classes.
 */

/**
 * Refuse a derivation that is degenerate rather than merely small.
 *
 * Called by {@link deriveValueSurface} **before it memoises**, so every consumer inherits it —
 * including the generator, which must never write a collapsed probe into the golden and thereby
 * launder the collapse into the reviewed expectation.
 *
 * Its reach is exactly these three checks: they refuse a probe that imported the wrong thing or a
 * classifier that collapsed, not a surface that came back smaller than it should have. That second
 * case is the golden's job. Keeping both is not redundancy — they fail for different reasons and
 * say different sentences.
 *
 * @param {ValueSurface} surface
 */
export function assertNonDegenerate(surface) {
  const relative = path.relative(DIST_DIR, surface.entry);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `${PACKAGE_NAME} resolved to ${surface.entry}, which is outside ${DIST_DIR} — the probe is not reading the built barrel, so it says nothing about what an embedder gets`
    );
  }
  if (surface.exports.length < MIN_VALUE_EXPORTS) {
    throw new Error(
      `the value-surface probe found only ${surface.exports.length} runtime exports, below the floor of ${MIN_VALUE_EXPORTS} — this is a broken probe, not a small API`
    );
  }
  const kinds = new Set(surface.exports.map((entry) => entry.kind));
  const missing = REQUIRED_KINDS.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    throw new Error(
      `the value-surface probe classified no export as ${missing.join(', ')} — the kind classifier has collapsed, and a collapsed classifier compares clean against its own golden forever`
    );
  }
}

/** @type {Promise<ValueSurface> | undefined} */
let derived;

/**
 * Import the built barrel the way a consumer does and answer what it hands out at runtime.
 *
 * The promise is memoised rather than the value, so a derivation that was refused stays refused:
 * no consumer can retry its way past {@link assertNonDegenerate} into a degenerate surface.
 *
 * @returns {Promise<ValueSurface>}
 */
export function deriveValueSurface() {
  derived ??= deriveValueSurfaceUncached();
  return derived;
}

/** @returns {Promise<ValueSurface>} */
async function deriveValueSurfaceUncached() {
  requireBuiltBarrel();
  const entry = resolveBarrelEntry();
  // `pathToFileURL` rather than the bare path: on win32 an absolute path is not a valid import
  // specifier, and the failure there looks like a missing module rather than a bad specifier.
  const namespace = await import(pathToFileURL(entry).href);

  const exports = Object.keys(namespace)
    .sort(byCodeUnit)
    .map((name) => ({ name, kind: kindOf(namespace[name]) }));

  /** @type {ValueSurface} */
  const surface = { entry, exports, declaredClasses: deriveDeclaredClasses() };
  // Before the memo, so no consumer can ever read a degenerate surface.
  assertNonDegenerate(surface);
  return surface;
}

/**
 * Order by code units rather than by locale.
 *
 * `localeCompare` depends on the ICU data the platform ships, and a golden regenerated on Windows
 * and compared on Linux must be byte-identical. The file's order is fixed here and never inherited
 * from the platform.
 */
function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Order two golden entries totally, over both pinned fields. */
function byNameKind(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return byCodeUnit(a.kind, b.kind);
}

/**
 * Project a derivation onto the shape that gets committed.
 *
 * **What is in.** `name` is the point: an export that disappears breaks an embedder at runtime and
 * is invisible to every type-level check. `kind` catches the same name surviving as something an
 * embedder cannot use the same way — a class demoted to a plain object, a function replaced by a
 * string constant.
 *
 * **What is deliberately out.** `entry` is a machine-specific absolute path and has its own
 * assertion. `declaredClasses` is the expectation source for the cross-check, not a property of
 * the runtime surface, and freezing it would turn a live failure into an accepted state. Function
 * arity, object key sets and class member lists are SHAPE rather than surface: an embedder's own
 * compiler checks those against the shipped declarations, and pinning them here would churn the
 * golden on every internal refactor while adding nothing the type surface does not already hold.
 *
 * @param {ValueSurface} surface
 */
export function toGoldenDocument(surface) {
  return {
    $comment: GOLDEN_COMMENT,
    exports: surface.exports
      .map((entry) => ({ name: entry.name, kind: entry.kind }))
      .sort(byNameKind),
  };
}

/** Read the committed golden. Throws with the regeneration command if it is not there at all. */
export function readGoldenDocument() {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(`${GOLDEN_PATH} is missing — regenerate it with: ${REGENERATE_COMMAND}`);
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

/** `name (kind)` — how one entry is named in a drift report. */
function label(entry) {
  return `${entry.name} (${entry.kind})`;
}

/** Index one golden document's export list by name. */
function indexByName(document) {
  const index = new Map();
  for (const entry of document.exports ?? []) index.set(entry.name, entry);
  return index;
}

/**
 * Say, in words a reader can act on, how the runtime surface differs from the committed golden —
 * or `null` when it does not.
 *
 * **Why this is not a bare deep-equality assertion:** the situations behind an equality failure
 * demand opposite responses, and `toEqual` renders them identically. Adding a public export is
 * ordinary work whose only correct answer is to regenerate the golden and commit it. Losing one is
 * the failure this pin exists to catch. A name that survived with a different KIND was neither
 * lost nor added, and told it is an addition a reader regenerates and ships the break.
 *
 * The loss branch names the cause that is hardest to see, because it is the one that leaves every
 * other check in this repository green.
 *
 * @param {ReturnType<typeof toGoldenDocument>} committed
 * @param {ReturnType<typeof toGoldenDocument>} current
 * @returns {string | null}
 */
export function describeValueSurfaceDrift(committed, current) {
  const before = indexByName(committed);
  const after = indexByName(current);

  const gone = [];
  const added = [];
  const changed = [];

  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name);
    const is = after.get(name);
    if (!is) gone.push(was);
    else if (!was) added.push(is);
    else if (was.kind !== is.kind) changed.push(`${name}: ${was.kind} -> ${is.kind}`);
  }

  const names = (entries) => entries.map(label).sort(byCodeUnit).join(', ');
  const sections = [];
  if (gone.length > 0) {
    sections.push(`GONE from the runtime surface (${gone.length}): ${names(gone)}`);
  }
  if (changed.length > 0) {
    sections.push(`KIND CHANGED (${changed.length}): ${[...changed].sort(byCodeUnit).join('; ')}`);
  }
  if (added.length > 0) {
    sections.push(`ADDED to the runtime surface (${added.length}): ${names(added)}`);
  }
  if (sections.length === 0) return null;

  let headline;
  /** @type {string[]} */
  let advice;
  if (gone.length > 0) {
    headline =
      'The public RUNTIME surface LOST exports the committed golden lists. Investigate before you regenerate.';
    advice = [
      'An export vanishing from the built barrel breaks an embedder at runtime, and no type-level',
      'check in this repository can see it. Three causes to rule out first — a STALE dist/ (this',
      `probe reads the built barrel as-is, so rebuild and run again: ${BUILD_COMMAND}), a`,
      'deliberate narrowing of the public API, and the one that looks like neither: an `export *`',
      'in src/index.ts rewritten as `export type *`, which keeps every declaration and every type',
      'cell green while removing the values. Only once you have established which it is, and the',
      `removal is intended, regenerate the golden and commit it: ${REGENERATE_COMMAND}`,
    ];
  } else if (changed.length > 0) {
    headline =
      'The public RUNTIME surface kept every name but BOUND one or more to a different KIND. That is neither a loss nor an addition, so neither of the usual answers fits it.';
    advice = [
      'A class demoted to a plain object, or a function replaced by a constant, breaks every',
      'embedder that constructs or calls it while leaving the name importable — which is why the',
      'name set alone cannot see this. Establish that the new kind is what you meant, then',
      `regenerate the golden and commit it: ${REGENERATE_COMMAND}`,
    ];
  } else {
    headline =
      'The public runtime surface no longer matches the committed golden, and nothing was lost.';
    advice = [
      'That is what a deliberate API addition looks like from here. Regenerate the golden and',
      `commit it alongside the change: ${REGENERATE_COMMAND}`,
    ];
  }

  return [headline, '', ...sections, '', advice.join('\n')].join('\n');
}
