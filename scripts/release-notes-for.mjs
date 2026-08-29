#!/usr/bin/env node
// Resolve the GitHub Release title and body for one version from the hand-written notes in
// release-notes/, for the "Create GitHub Release" step of .github/workflows/release.yml.
//
// Without this the Release page shows `--generate-notes` output — a list of merged pull requests —
// while the considered account of the release sits unread in release-notes/. In this repo that list
// is also partial by construction: branches land by local merge and usually never open a PR, so the
// generated body can only show whatever happened to arrive as one.
//
// The logic lives here rather than inline in the YAML because that step runs only during a real
// release dispatch: inline bash could be verified only by shipping a broken release, while a script
// is covered by the ordinary unit suite (packages/core/spec/releaseNotesFor.spec.ts, and
// packages/core/spec/releaseNotesWiredIntoRelease.spec.ts for the wiring). scripts/dist-tag.mjs is
// the same arrangement for the publish channel.
//
// NO dependencies beyond node: builtins — the release job runs this under `set -euo pipefail`
// before anything has proven the workspace resolves, and an import that failed to hoist would abort
// a release (the reason scripts/dist-tag.mjs avoids `semver`).
//
// The rules:
//   - File name: `v` + the version with every dot replaced by an underscore, + `.md`, directly
//     under release-notes/. So `2.0.0-beta.3` -> `release-notes/v2_0_0-beta_3.md`.
//   - First line is an ATX H1 -> that line, minus the leading `# `, is the Release TITLE, and the
//     line is removed from the body so the title is not repeated inside it. A single blank line
//     immediately after it is dropped too.
//   - First line is not an H1 -> the title stays `v<version>` and the WHOLE file is the body.
//   - No file for the version -> no body; the caller falls back to `--generate-notes`. That
//     fallback is deliberate: a Release with an empty body is worse than a partial PR list, and the
//     path only fires when someone dispatched a release without writing notes.
//
// The H1 is taken VERBATIM. It is not required to contain the version (release-notes/v0/v0_9_0.md
// opens `# Gaunt Sloth Assistant v0.9.0 Release Notes`) and it may contain any markdown, including
// backticks (release-notes/v1_2_0.md). That is also why the workflow must pass the title through
// `env:` and reference it as a quoted shell variable: a `${{ }}` expression is spliced into the run
// block as TEXT before bash parses it, so a backtick in a title would be command substitution.
//
// CLI:
//   node scripts/release-notes-for.mjs <version> [--dir <notes dir>] [--body-out <path>]
// Writes the resolved body to --body-out when there is one, prints a summary on stdout, and — when
// GITHUB_OUTPUT is set — appends the step outputs `title` and `body_file` (empty on the fallback).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repo root, one level up from scripts/. */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The directory the release notes live in, used when --dir is not given. */
export const DEFAULT_NOTES_DIR = join(REPO_ROOT, 'release-notes');

/**
 * The notes file name for a version: `v` + the version with every dot replaced by an underscore.
 * @param {string} version e.g. "2.0.0-beta.3"
 * @returns {string} e.g. "v2_0_0-beta_3.md"
 */
export function notesFileName(version) {
  return 'v' + String(version ?? '').replaceAll('.', '_') + '.md';
}

/**
 * The path to a version's notes file, or undefined when it does not exist.
 *
 * Only the flat path is searched. 0.x notes are archived one level down in release-notes/v0/, but
 * archiving happens long after a release ships, so a dispatch's own notes are always flat.
 * @param {string} version
 * @param {string} [notesDir]
 * @returns {string | undefined}
 */
export function resolveNotesPath(version, notesDir = DEFAULT_NOTES_DIR) {
  const path = join(notesDir, notesFileName(version));
  return existsSync(path) ? path : undefined;
}

/**
 * Split a notes file into the Release title and the Release body.
 *
 * @param {string} text the whole notes file
 * @param {string} version used for the title when the file does not open with an H1
 * @returns {{ title: string, body: string, fromH1: boolean }}
 */
export function splitTitleAndBody(text, version) {
  const source = String(text ?? '');
  const newline = source.indexOf('\n');
  // Strip a CR so a CRLF file behaves like an LF one; only the first line needs it, the body is
  // handed to `gh` unchanged.
  const firstLine = (newline === -1 ? source : source.slice(0, newline)).replace(/\r$/, '');
  // An ATX H1 needs the space after the `#`, and needs something after that: a bare `# ` is not a
  // usable title, and `## ` is not an H1 at all. Trailing whitespace is trimmed
  // (release-notes/v0/v0_6_2.md ends its H1 with a space).
  const h1 = /^# +(\S.*?)\s*$/.exec(firstLine);
  if (!h1) {
    return { title: `v${version}`, body: source, fromH1: false };
  }
  let body = newline === -1 ? '' : source.slice(newline + 1);
  // Drop ONE blank line after the H1, so a file written with the usual blank separator and one
  // written without it both start at the first real line. A second blank line is left alone — it is
  // the author's spacing, not the separator this rule is about.
  body = body.replace(/^[ \t]*\r?\n/, '');
  return { title: h1[1], body, fromH1: true };
}

/**
 * Everything the release workflow needs for one version.
 *
 * @param {string} version
 * @param {string} [notesDir]
 * @returns {{ version: string, title: string, notesPath: string | undefined, body: string | undefined, generateNotes: boolean }}
 */
export function releaseNotesFor(version, notesDir = DEFAULT_NOTES_DIR) {
  const notesPath = resolveNotesPath(version, notesDir);
  if (!notesPath) {
    // The documented fallback: no notes were written for this version, so the caller asks GitHub to
    // synthesise a body. Title still comes from here, so the workflow has one source for it.
    return {
      version,
      title: `v${version}`,
      notesPath: undefined,
      body: undefined,
      generateNotes: true,
    };
  }
  const { title, body } = splitTitleAndBody(readFileSync(notesPath, 'utf8'), version);
  return { version, title, notesPath, body, generateNotes: false };
}

/**
 * The `key=value` lines for GITHUB_OUTPUT.
 *
 * The title is forced onto one line. It already is one by construction, but a newline in a value is
 * how a step output injects a second output, and this is the boundary where that would matter.
 * @param {{ title: string }} result
 * @param {string | undefined} bodyFile the written body file, or undefined on the fallback
 * @returns {string}
 */
export function githubOutputLines(result, bodyFile) {
  const title = String(result.title).replace(/[\r\n]+/g, ' ');
  return `title=${title}\nbody_file=${bodyFile ?? ''}\n`;
}

// CLI.
// Guarded so importing this module (e.g. from the vitest spec) never runs it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usage = 'usage: release-notes-for.mjs <version> [--dir <notes dir>] [--body-out <path>]\n';
  const args = process.argv.slice(2);
  let version;
  let notesDir = DEFAULT_NOTES_DIR;
  let bodyOut = join(tmpdir(), 'gth-release-body.md');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') {
      notesDir = args[++i];
    } else if (args[i] === '--body-out') {
      bodyOut = args[++i];
    } else if (version === undefined) {
      version = args[i];
    } else {
      process.stderr.write(usage);
      process.exit(2);
    }
  }
  if (!version || !notesDir || !bodyOut) {
    process.stderr.write(usage);
    process.exit(2);
  }

  const result = releaseNotesFor(version, notesDir);
  let bodyFile;
  if (!result.generateNotes) {
    mkdirSync(dirname(resolve(bodyOut)), { recursive: true });
    writeFileSync(bodyOut, result.body, 'utf8');
    bodyFile = bodyOut;
    process.stdout.write(`Release notes for ${version}: ${result.notesPath}\n`);
    process.stdout.write(`title: ${result.title}\n`);
    process.stdout.write(`body written to: ${bodyFile}\n`);
  } else {
    process.stdout.write(
      `No release notes file for ${version} (looked for ` +
        `${join(notesDir, notesFileName(version))}) — falling back to GitHub's generated notes.\n`
    );
    process.stdout.write(`title: ${result.title}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, githubOutputLines(result, bodyFile), 'utf8');
  }
}
