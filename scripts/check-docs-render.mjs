/**
 * Renders the documentation site and fails on the defects a render is the only thing that can see.
 *
 * `typedoc` exits 0 with hundreds of warnings, so a job that runs it and checks the exit code is an
 * assertion that cannot fail for anything we care about. This runs the same render and then applies
 * `docs/DOC-STYLE.md` rule 10's self-check as a gate:
 *
 * - the render reports no errors, and TypeDoc's own summary line is present (a summary that stopped
 *   matching means this gate lost its input, which must be loud rather than green);
 * - no `anchor does not exist` warning — a cross-page link whose `#anchor` misses;
 * - rule 8's whole-tree sweep finds no same-page `href="#…"` pointing at no heading. TypeDoc says
 *   nothing at all about those, so the sweep, not the warning stream, is what covers them. It is
 *   ported unchanged from the sweep DOC-STYLE tells authors to run: the gate and the documented
 *   self-check must not be able to disagree.
 *
 * Whether a `docs/` page is *listed* in `typedoc.json` is a different question, already covered by
 * `packages/core/spec/typedocProjectDocuments.spec.ts`; this is about what the listing renders into.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s) => s.replace(ANSI, '');

/** `out` is read from the config rather than repeated here, so the two cannot drift apart. */
function outputDirectory() {
  const config = JSON.parse(readFileSync(join(repoRoot, 'typedoc.json'), 'utf8'));
  return resolve(repoRoot, config.out ?? './docs');
}

/**
 * Runs the real TypeDoc binary — the one `pnpm typedoc` runs — rather than driving the API, so this
 * gate cannot pass on a pipeline that differs from the one contributors and the site are built by.
 */
function render(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const typedocPackage = require.resolve('typedoc/package.json');
  const bin = resolve(
    dirname(typedocPackage),
    JSON.parse(readFileSync(typedocPackage, 'utf8')).bin.typedoc
  );
  const run = spawnSync(process.execPath, [bin], { cwd: repoRoot, encoding: 'utf8' });
  if (run.error) throw run.error;
  return { status: run.status, output: stripAnsi(`${run.stdout ?? ''}${run.stderr ?? ''}`) };
}

/** DOC-STYLE rule 8's sweep, unchanged. */
function sweepSamePageAnchors(outDir) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]
    );
  const pages = [];
  let htmlFiles = 0;
  let internalLinks = 0;
  for (const f of walk(outDir)) {
    if (!f.endsWith('.html')) continue;
    htmlFiles++;
    const h = readFileSync(f, 'utf8');
    const ids = new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [
      ...new Set([...h.matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))),
    ];
    internalLinks += anchors.length;
    const bad = anchors.filter((a) => !ids.has(a));
    if (bad.length) pages.push(`${f.slice(repoRoot.length + 1)} ${bad.join(', ')}`);
  }
  return { pages, htmlFiles, internalLinks };
}

const outDir = outputDirectory();
const { status, output } = render(outDir);
process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);

const failures = [];
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const record = (ok, name, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

console.log('\n--- docs render checks ---');

record(status === 0, 'typedoc exits 0', `exit code ${status}`);

const summary = output.match(/Found (\d+) errors? and (\d+) warnings?/);
record(
  summary !== null,
  "typedoc's summary line is present",
  summary ? summary[0] : 'no summary line in the output'
);
if (summary) {
  record(
    summary[1] === '0',
    'the render reports no errors',
    `${summary[1]} errors, ${summary[2]} warnings`
  );
}

const anchorWarnings = output.split('\n').filter((line) => line.includes('anchor does not exist'));
record(
  anchorWarnings.length === 0,
  'no cross-page link points at a missing anchor',
  count(anchorWarnings.length, 'warning')
);
for (const line of anchorWarnings) console.log(`      ${line.trim()}`);

// A render that errored out writes no output directory at all; report that as the sweep having
// nothing to read rather than as a stack trace.
const sweep = existsSync(outDir)
  ? sweepSamePageAnchors(outDir)
  : { pages: [], htmlFiles: 0, internalLinks: 0 };
record(
  sweep.htmlFiles > 0 && sweep.internalLinks > 0,
  'the sweep had something to read',
  `${count(sweep.htmlFiles, 'page')}, ${count(sweep.internalLinks, 'same-page link')}`
);
record(
  sweep.pages.length === 0,
  'no same-page link points at a missing anchor',
  `${count(sweep.pages.length, 'page')} affected`
);
for (const page of sweep.pages) console.log(`      ${page}`);

if (failures.length > 0) {
  console.error(`\nDocs render check failed: ${failures.join('; ')}.`);
  console.error('See docs/DOC-STYLE.md rules 8 and 10 for how to read and fix each of these.');
  process.exit(1);
}
console.log('\nDocs render check passed.');
