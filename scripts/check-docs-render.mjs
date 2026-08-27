/**
 * Renders the documentation site and fails on the defects a render is the only thing that can see.
 *
 * `typedoc` exits 0 with hundreds of warnings, so a job that runs it and checks the exit code is an
 * assertion that cannot fail for anything we care about. This runs the same render and then asserts
 * what `docs/DOC-STYLE.md` rules 8 and 10 tell an author to check by hand:
 *
 * - the render reports no errors, and TypeDoc's own summary line is present (a summary that stopped
 *   matching means this gate lost its input, which must be loud rather than green);
 * - **no warning that `scripts/docs-warnings.baseline.txt` does not already account for.** TypeDoc's
 *   warnings are the only signal for a whole class of defect in published output — a `{@link}` to a
 *   symbol that is not exported renders as dead text in the API reference — and the standing count
 *   is not zero, so a zero-target would red every unrelated branch. Hence a recorded set. It is a
 *   set and not a count because **a count cannot see a swap**: one warning fixed and one introduced
 *   in the same branch leaves the total unchanged while the new defect lands. Comparing the set is
 *   also what lets the failure name the offending comment, instead of printing a delta that sends
 *   the reader off to diff two logs by hand;
 * - no `anchor does not exist` warning — a cross-page link whose `#anchor` misses;
 * - no `is not a file and will not be copied` warning — a link to a page that does not exist;
 * - no markdown under `media/`. A link to a real `.md` that `projectDocuments` does not list is
 *   copied there and linked as raw markdown, so the reader gets a download instead of a page, and
 *   TypeDoc says nothing whatsoever about it — the output tree is the only place it is visible;
 * - rule 8's whole-tree sweep finds no same-page `href="#…"` pointing at no heading. TypeDoc says
 *   nothing about those either. The sweep is ported unchanged from the one DOC-STYLE tells authors
 *   to run: the gate and the documented self-check must not be able to disagree;
 * - **this run wrote the pages those last two checks read.** A timestamp taken before the render is
 *   compared with the newest mtime under `out`: a check that reads the output tree cannot tell this
 *   run's pages from the previous run's, so a render that put its output somewhere else leaves both
 *   of them green about bytes this run never produced — measured, by redirecting `out` from
 *   `tsconfig.json`. This one tests the observable fact instead of enumerating the ways it can be
 *   false, which is why it also covers a config source nobody has thought of yet.
 *
 * **What this gate does not cover**, so the boundary is written down rather than assumed:
 *
 * - whether a `docs/` page is *listed* in `typedoc.json` — that is
 *   `packages/core/spec/typedocProjectDocuments.spec.ts`, which runs in the same CI job;
 * - **whether the warnings already in the baseline are defects.** The baseline freezes them and
 *   adjudicates none of them; it asserts only that this render introduced nothing new. A passing
 *   run means zero *new* warnings, never zero warnings — do not read a green gate as a clean
 *   reference;
 * - a non-markdown file copied to `media/`, such as `LICENSE`. Handing that over as a download is
 *   what the link intends;
 * - the exact wording of the two warnings above. They are matched as substrings, so a TypeDoc
 *   reword would silence those two checks; the sweep and the summary-line check are what would
 *   still be standing. Re-read this list when bumping TypeDoc — a reword also reaches the baseline,
 *   where it reads as every affected line removed and an unfamiliar one added. That is noisy but it
 *   fails in the direction that makes someone look, and `--update-baseline` clears it once the diff
 *   has been read;
 * - `cleanOutputDir` turned off from a config source other than `typedoc.json`. The refusals below
 *   read that file only, while TypeDoc would also honour a `typedocOptions` block in `package.json`
 *   or in `tsconfig.json` — neither of which this repo uses. Measured from `tsconfig.json`: the
 *   render still writes the whole tree into `out`, so the freshness check stays green and what is
 *   stale is only a page this run had no reason to rewrite. Redirecting `out` from those same
 *   sources is a different matter — the freshness check does catch that one.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s) => s.replace(ANSI, '');

/**
 * `out` is read from the config rather than repeated here, so the two cannot drift apart.
 *
 * **This script deletes nothing, deliberately.** TypeDoc empties its own output directory before
 * writing — measured: a stray file placed in `out` is gone after a successful render — so there is
 * no delete here to make safe, and therefore no guard around one to get wrong. A guard is a claim
 * about every input it will ever see; not performing the operation is a fact. Do not re-add an
 * `rmSync` — it would delete what TypeDoc is about to delete anyway, and it would need a guard
 * that is only ever as correct as its author's list of paths worth sparing. The one thing the
 * delete did provide, as a side effect — evidence that the tree these checks read belongs to this
 * run — is asserted directly below, by comparing the newest write under `out` against a timestamp
 * taken before the render.
 *
 * Two things are still read out of the config, because the checks below rest on both:
 *
 * - **`out` must be declared.** TypeDoc's default is `./docs`, which here is the tracked
 *   documentation source — it would be emptied and refilled with HTML by the render itself.
 * - **`cleanOutputDir` must not be off.** Measured: with it off a stray file survives a successful
 *   render, and the sweep and the "had something to read" check would then be reading a previous
 *   run's pages — the vacuous pass this whole gate exists to prevent.
 *
 * On a *failing* render TypeDoc cleans nothing and the previous tree stays. That run is already red
 * on `typedoc exits 0` and `the render reports no errors`, so stale pages cannot make it green.
 */
function outputDirectory(config) {
  if (typeof config.out !== 'string' || config.out.trim() === '') {
    throw new Error(
      'typedoc.json declares no "out" directory. TypeDoc would render into ./docs and empty it ' +
        'first, and that is the documentation source. Declare "out".'
    );
  }
  if (config.cleanOutputDir === false) {
    throw new Error(
      'typedoc.json sets "cleanOutputDir" to false, so a render leaves the previous one in place ' +
        'and these checks would read stale pages. Remove it, or stop trusting this gate.'
    );
  }
  return resolve(repoRoot, config.out);
}

/**
 * Runs the real TypeDoc binary — the one `pnpm typedoc` runs — rather than driving the API, so this
 * gate cannot pass on a pipeline that differs from the one contributors and the site are built by.
 */
function render() {
  const typedocPackage = require.resolve('typedoc/package.json');
  const bin = resolve(
    dirname(typedocPackage),
    JSON.parse(readFileSync(typedocPackage, 'utf8')).bin.typedoc
  );
  const run = spawnSync(process.execPath, [bin], { cwd: repoRoot, encoding: 'utf8' });
  if (run.error) throw run.error;
  return { status: run.status, output: stripAnsi(`${run.stdout ?? ''}${run.stderr ?? ''}`) };
}

const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]
  );

const relativeToRepo = (f) => f.slice(repoRoot.length + 1);

/** DOC-STYLE rule 8's sweep, unchanged. */
function sweepSamePageAnchors(outDir) {
  const pages = [];
  let htmlFiles = 0;
  let documentPages = 0;
  let internalLinks = 0;
  for (const f of walk(outDir)) {
    if (!f.endsWith('.html')) continue;
    htmlFiles++;
    if (f.startsWith(`${outDir}/documents/`)) documentPages++;
    const h = readFileSync(f, 'utf8');
    const ids = new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [
      ...new Set([...h.matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))),
    ];
    internalLinks += anchors.length;
    const bad = anchors.filter((a) => !ids.has(a));
    if (bad.length) pages.push(`${relativeToRepo(f)} ${bad.join(', ')}`);
  }
  return { pages, htmlFiles, documentPages, internalLinks };
}

/**
 * The mtime of the most recently written file anywhere under `dir`, or 0 for an empty tree.
 *
 * Reduced rather than spread into `Math.max`, so a tree of any size stays within the argument
 * limit — this walks every page the render produced.
 */
function newestWriteUnder(dir) {
  return walk(dir).reduce((newest, f) => Math.max(newest, statSync(f).mtimeMs), 0);
}

/**
 * The recorded set of TypeDoc warnings this tree is known to produce, one per line.
 *
 * Comparing *text* is only sound because these warnings carry no line numbers, no source offsets
 * and no absolute paths — only qualified symbol names. Measured: two renders of an unchanged tree
 * produce byte-identical warning output, and editing one docblock moved exactly the two lines
 * belonging to it and nothing else. So a line changes when the symbol path or the link target
 * changes, which is precisely the event worth being told about.
 *
 * Duplicates are kept rather than collapsed, making the file a multiset: the same warning reported
 * twice is two lines. A link that starts being reported one more time than before is a change in
 * the render, and the safe reading of a change is to put it in front of someone.
 */
const BASELINE_FILE = join(repoRoot, 'scripts', 'docs-warnings.baseline.txt');
const BASELINE_FLAG = '--update-baseline';
const WARNING_PREFIX = '[warning] ';

/**
 * TypeDoc prints its end-of-run tally as a warning like any other.
 *
 * It has to be excluded or it becomes a baseline line that changes every time any *other* line
 * does, so the "one reviewable line" that a single legitimate new warning is meant to cost would
 * always be two, and every baseline diff would carry a number that restates what the diff already
 * shows. The tally is checked directly, above.
 */
const isSummaryLine = (text) => /^Found \d+ errors? and \d+ warnings?$/.test(text);

/** The warnings this render reported, in TypeDoc's order, without the prefix or the tally. */
function warningsFrom(renderOutput) {
  return renderOutput
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith(WARNING_PREFIX))
    .map((line) => line.slice(WARNING_PREFIX.length))
    .filter((text) => !isSummaryLine(text));
}

/**
 * The recorded set, or `null` when there is nothing usable to compare against.
 *
 * **A missing or empty baseline reds.** Treating it as "nothing recorded, so nothing is new" would
 * rebuild the exact vacuous pass this check exists to remove, and deleting a file is a much easier
 * way to silence a gate than fixing what it found.
 *
 * `\r` is stripped on the way in. `docs:check` runs only on ubuntu today, so CRLF is not currently
 * a live CI cell — but exact string equality between a committed file and a value produced at
 * runtime is the shape that has broken this repo's Windows cell repeatedly, and a checkout with
 * CRLF endings would otherwise report the entire baseline as removed and the entire render as new.
 * Tolerating it costs one call.
 *
 * `#` carries the header explaining the file to whoever opens it. No TypeDoc warning begins with
 * `#`; were one ever to, it would be dropped from the baseline and then reported as new on every
 * run — loud, and in the direction that makes someone look rather than the one that hides.
 */
function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  const entries = readFileSync(BASELINE_FILE, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'));
  return entries.length === 0 ? null : entries;
}

/** How many times each entry occurs. */
function tally(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  return counts;
}

/**
 * The entries of `actual` that `expected` does not account for, with multiplicity — so a warning
 * reported three times against a baseline holding two is reported once, not not at all and not
 * three times.
 */
function surplus(actual, expected) {
  const unclaimed = tally(expected);
  const extra = [];
  for (const entry of actual) {
    const left = unclaimed.get(entry) ?? 0;
    if (left > 0) unclaimed.set(entry, left - 1);
    else extra.push(entry);
  }
  return extra;
}

const BASELINE_HEADER = `\
# TypeDoc warnings this tree is known to produce, one per line, sorted.
#
# \`pnpm run docs:check\` fails when a render reports a warning this file does not account for. A new
# warning is usually a real defect in published output — most often a \`{@link}\` to a symbol that is
# not exported, which renders as dead text in the API reference — so the first move is to fix it,
# not to record it here.
#
# To accept one deliberately, regenerate with:
#
#     node scripts/check-docs-render.mjs ${BASELINE_FLAG}
#
# then read the diff before committing: every added line is a warning you are choosing to live with.
#
# Presence here is not a judgement that a warning is harmless. This records what the tree already
# produced when the gate was added. Nothing has adjudicated it.
`;

/**
 * Sorted by code unit, which is locale-independent and therefore reproducible on any machine —
 * unlike `localeCompare` or the shell's `sort`, either of which would make the committed file a
 * function of who last regenerated it.
 */
const writeBaseline = (entries) =>
  writeFileSync(BASELINE_FILE, `${BASELINE_HEADER}${[...entries].sort().join('\n')}\n`);

/** Markdown copied out verbatim is a link the reader receives as a download. */
function markdownCopiedAsMedia(outDir) {
  const media = join(outDir, 'media');
  if (!existsSync(media)) return [];
  return walk(media)
    .filter((f) => /\.(md|markdown)$/i.test(f))
    .map(relativeToRepo);
}

const config = JSON.parse(readFileSync(join(repoRoot, 'typedoc.json'), 'utf8'));
const outDir = outputDirectory(config);
// Taken before the render so the freshness check below has something a stale tree cannot satisfy.
const renderStartedAt = Date.now();
const { status, output } = render();
process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);

const failures = [];
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const record = (ok, name, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const list = (lines) => {
  for (const line of lines) console.log(`      ${line.trim()}`);
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

// The warning baseline. Every other check here is a fixed assertion about this render; this one
// compares it against a recorded set, because these warnings are real defects in published output
// and there is no prospect of the count reaching zero.
const renderWarnings = warningsFrom(output);
const renderCameBackClean = status === 0 && summary !== null && summary[1] === '0';
const updatingBaseline = process.argv.includes(BASELINE_FLAG);
const baselinePath = relativeToRepo(BASELINE_FILE);
const guidance = (text) => console.log(`      ${text}`);

if (updatingBaseline && !renderCameBackClean) {
  record(false, `${BASELINE_FLAG} refused`, 'this render did not come back clean');
  guidance(
    'Its warning list may be truncated, and recording a truncated list drops warnings that a'
  );
  guidance(
    'healthy render brings back — they would never be reported again. Fix the render first.'
  );
} else if (updatingBaseline) {
  const previous = readBaseline() ?? [];
  const added = surplus(renderWarnings, previous);
  const dropped = surplus(previous, renderWarnings);
  writeBaseline(renderWarnings);
  record(
    true,
    'the warning baseline was rewritten',
    `${count(added.length, 'warning')} added, ${dropped.length} no longer reported, ` +
      `${count(renderWarnings.length, 'warning')} recorded`
  );
  list(added);
  guidance(`Read the diff of ${baselinePath} before committing it.`);
  guidance('Every added line is a warning you are choosing to live with.');
} else {
  const baseline = readBaseline();
  if (baseline === null) {
    record(false, 'the warning baseline is readable', `${baselinePath} is missing or empty`);
    guidance('Without it this check cannot tell a new warning from a known one, and treating that');
    guidance('as "nothing recorded, so nothing is new" is the vacuous pass it exists to remove.');
    guidance(`Restore ${baselinePath}, or regenerate it with ${BASELINE_FLAG}.`);
  } else {
    const introduced = surplus(renderWarnings, baseline);
    const resolved = surplus(baseline, renderWarnings);
    record(
      introduced.length === 0,
      'no warning is new since the baseline',
      `${count(introduced.length, 'new warning')} — ` +
        `${renderWarnings.length} reported, ${baseline.length} recorded`
    );
    list(introduced);
    if (introduced.length > 0) {
      guidance('');
      guidance('Each line above is a warning this render produced that the baseline does not');
      guidance('account for. These are usually real defects in published output: a {@link} to a');
      guidance('symbol that is not exported renders as dead text in the API reference, and the');
      guidance('line names the comment it is in. Fixing that comment is the first move.');
      guidance('');
      guidance('If a new warning is legitimate and you mean to accept it, record it deliberately:');
      guidance('');
      guidance(`      node scripts/check-docs-render.mjs ${BASELINE_FLAG}`);
      guidance('');
      guidance(`then commit the changed ${baselinePath} — one added line per accepted warning.`);
    }
    if (resolved.length > 0) {
      record(
        true,
        'warnings fixed since the baseline',
        `${resolved.length} recorded ${resolved.length === 1 ? 'warning is' : 'warnings are'} ` +
          `no longer reported — ${BASELINE_FLAG} to bank that`
      );
      if (resolved.length <= 10) list(resolved);
    }
  }
}

const lines = output.split('\n');
const warningsSaying = (phrase) => lines.filter((line) => line.includes(phrase));

const anchorWarnings = warningsSaying('anchor does not exist');
record(
  anchorWarnings.length === 0,
  'no cross-page link points at a missing anchor',
  count(anchorWarnings.length, 'warning')
);
list(anchorWarnings);

const missingFileWarnings = warningsSaying('is not a file and will not be copied');
record(
  missingFileWarnings.length === 0,
  'no link points at a page that does not exist',
  count(missingFileWarnings.length, 'warning')
);
list(missingFileWarnings);

// A render that errored out writes no output directory at all; report that as the sweep having
// nothing to read rather than as a stack trace.
const rendered = existsSync(outDir);

// Every check that follows reads the output tree, and none of them can tell this run's pages from
// the last run's. TypeDoc takes `out` from places these checks do not read — a `typedocOptions`
// block in tsconfig.json or package.json, or the command line — so a render can succeed, write its
// pages somewhere else entirely, and leave all of them green about bytes this run never produced;
// measured, by redirecting `out` from tsconfig.json. Comparing the newest write under `out` against
// the moment the render started is the observation that notices, without needing to know why. The
// margin on a healthy run is a whole render — seconds, not milliseconds — so no filesystem
// timestamp granularity can flip it.
const newestWrite = rendered ? newestWriteUnder(outDir) : 0;
const wroteHere = newestWrite >= renderStartedAt;
const age = Math.round(Math.abs(newestWrite - renderStartedAt) / 1000);
let freshness = `nothing under ${relativeToRepo(outDir)} to read`;
if (newestWrite > 0) {
  freshness = wroteHere
    ? `newest page written ${age}s after the render started`
    : `newest page written ${age}s BEFORE the render started`;
}
record(wroteHere, 'this run wrote the pages these checks read', freshness);
if (!wroteHere) {
  list([
    `This render wrote nothing under ${relativeToRepo(outDir)} — the directory the page checks ` +
      'here read — so it went somewhere else, and what they report is about a previous run.',
    'TypeDoc also honours `out` from a `typedocOptions` block in tsconfig.json or package.json, ' +
      'and from the command line; typedoc.json is the only one this gate reads.',
  ]);
}

const sweep = rendered
  ? sweepSamePageAnchors(outDir)
  : { pages: [], htmlFiles: 0, documentPages: 0, internalLinks: 0 };

const downloads = rendered ? markdownCopiedAsMedia(outDir) : [];
record(
  downloads.length === 0,
  'no markdown page was copied out as a raw download',
  count(downloads.length, 'file')
);
list(downloads);

record(
  sweep.documentPages > 0 && sweep.internalLinks > 0,
  'the sweep had something to read',
  `${count(sweep.htmlFiles, 'page')} (${sweep.documentPages} from projectDocuments), ` +
    count(sweep.internalLinks, 'same-page link')
);
record(
  sweep.pages.length === 0,
  'no same-page link points at a missing anchor',
  `${count(sweep.pages.length, 'page')} affected`
);
list(sweep.pages);

if (failures.length > 0) {
  console.error(`\nDocs render check failed: ${failures.join('; ')}.`);
  console.error('See docs/DOC-STYLE.md rules 8 and 10 for how to read and fix each of these.');
  process.exit(1);
}
console.log('\nDocs render check passed.');
