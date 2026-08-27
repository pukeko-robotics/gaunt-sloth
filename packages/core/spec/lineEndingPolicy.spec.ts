import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OPS-79 — every tracked file that carries a shebang must reach the working tree with LF endings,
 * on every platform, and genuinely binary content must reach it untouched.
 *
 * Git's default hands a Windows checkout CRLF. A script whose shebang line ends in a carriage
 * return does not run at all: the carriage return is taken as part of the interpreter name, and
 * the shell answers with an error that names neither the file nor the cause. The repository's
 * `.gitattributes` is what prevents that; this file is what keeps it honest.
 *
 * Two layers, because one of them cannot discriminate everywhere.
 *
 * The BYTE layer reads the shebang line of every tracked file that has one and refuses a carriage
 * return in it. It is the direct observation of the thing that breaks, and it is the layer that
 * means something on the Windows cells — on a POSIX checkout it cannot fail, because a POSIX
 * checkout never had CRLF to begin with. A local green is not evidence for it.
 *
 * The ATTRIBUTE layer asks git how it resolves `text` and `eol` for those same paths. That answer
 * is the policy itself rather than one checkout's outcome, so it discriminates on every platform:
 * dropping the global `eol=lf`, or adding a later rule that overrides it for scripts, turns this
 * red on Linux before it can reach a Windows cell.
 *
 * Membership is decided by the first two bytes rather than by extension, and the binary set by the
 * presence of a NUL rather than by a list of suffixes, so both stay correct for a file added
 * tomorrow under a name nobody here predicted. That is deliberate: an enumeration of names is
 * exactly the thing that silently stops covering the next case.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** `git ls-files -z` separates paths with this, so a path containing a newline stays one entry. */
const NUL = String.fromCharCode(0);

const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

/**
 * How much of a file is enough to classify it. Two bytes decide the shebang, and git's own binary
 * heuristic looks at the first 8000 — matching it keeps this test's idea of "binary" the same as
 * the one `text=auto` acts on.
 */
const CLASSIFY_BYTES = 8000;

function git(args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

/** The first `count` bytes of a file, without reading the rest of it. */
function headBytes(path: string, count: number): Buffer {
  const buffer = Buffer.alloc(count);
  const fd = openSync(path, 'r');
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, count, 0));
  } finally {
    closeSync(fd);
  }
}

let cachedHeads: Map<string, Buffer> | undefined;

/** Memoised: every test here classifies the same files, and the Windows cells pay for each read. */
function trackedHeads(): Map<string, Buffer> {
  if (cachedHeads) return cachedHeads;
  const heads = new Map<string, Buffer>();
  for (const file of git(['ls-files', '-z']).split(NUL).filter(Boolean)) {
    heads.set(file, headBytes(join(REPO_ROOT, file), CLASSIFY_BYTES));
  }
  cachedHeads = heads;
  return heads;
}

/** Tracked files whose first two bytes are a shebang, whatever they are named. */
function shebangFiles(): string[] {
  return [...trackedHeads()]
    .filter(([, head]) => head.length >= 2 && head[0] === 0x23 && head[1] === 0x21)
    .map(([file]) => file);
}

/** Tracked files git's own heuristic treats as binary: a NUL inside the classification window. */
function binaryFiles(): string[] {
  return [...trackedHeads()].filter(([, head]) => head.includes(0)).map(([file]) => file);
}

/** The detector under test: does the FIRST line of this content carry a carriage return? */
function carriageReturnInFirstLine(content: Buffer): boolean {
  const newline = content.indexOf(LINE_FEED);
  const firstLine = newline === -1 ? content : content.subarray(0, newline);
  return firstLine.includes(CARRIAGE_RETURN);
}

/** `git check-attr` over several paths and attributes, as `path -> attribute -> value`. */
function resolvedAttributes(
  paths: string[],
  attributes: string[]
): Map<string, Map<string, string>> {
  const fields = git(['check-attr', '-z', '--stdin', ...attributes], paths.join(NUL) + NUL).split(
    NUL
  );
  const resolved = new Map<string, Map<string, string>>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    if (!resolved.has(path)) resolved.set(path, new Map());
    resolved.get(path)?.set(fields[i + 1], fields[i + 2]);
  }
  return resolved;
}

describe('OPS-79 line-ending policy', () => {
  it('flags a carriage return in the shebang line and nowhere else', () => {
    // Control mutation: without this pair, a detector that always answered false would let the
    // repo-wide assertions below pass while examining nothing.
    expect(carriageReturnInFirstLine(Buffer.from('#!/usr/bin/env bash\r\nset -e\n'))).toBe(true);
    expect(carriageReturnInFirstLine(Buffer.from('#!/usr/bin/env bash\nset -e\n'))).toBe(false);
    // A carriage return on a LATER line is a different question, and not the one that stops a
    // script from starting.
    expect(carriageReturnInFirstLine(Buffer.from('#!/bin/sh\nfoo\r\n'))).toBe(false);
    // A single unterminated line is still a shebang line, and still judged.
    expect(carriageReturnInFirstLine(Buffer.from('#!/bin/sh\r'))).toBe(true);
  });

  it('finds the files it is meant to be scanning', () => {
    // Anti-vacuity: a failed git call or a wrong cwd yields empty lists, and every assertion below
    // would then pass by scanning nothing at all.
    expect(trackedHeads().size).toBeGreaterThan(200);

    const scripts = shebangFiles();
    expect(scripts.length).toBeGreaterThanOrEqual(15);
    expect(scripts).toContain('evals/harness/run-bed.sh');
    expect(scripts).toContain('publish-all.sh');
    expect(scripts).toContain('packages/app/cli.js');

    const binaries = binaryFiles();
    expect(binaries.length).toBeGreaterThanOrEqual(4);
    expect(binaries).toContain('packages/app/integration-tests/workdir/image.png');
  });

  it('no tracked file has a carriage return in its shebang line', () => {
    const offenders = shebangFiles().filter((file) =>
      carriageReturnInFirstLine(readFileSync(join(REPO_ROOT, file)))
    );
    expect(offenders).toEqual([]);
  });

  it('git resolves every shebang file to LF in the working tree', () => {
    const scripts = shebangFiles();
    const resolved = resolvedAttributes(scripts, ['text', 'eol']);
    const offenders = scripts
      .map((file) => ({ file, attrs: resolved.get(file) }))
      .filter(({ attrs }) => attrs?.get('eol') !== 'lf' || attrs?.get('text') === 'unset')
      // `eol=lf` only bites while the path is still treated as text, so both halves are required:
      // a later `-text` or `binary` rule covering scripts would leave a Windows checkout free to
      // keep whatever endings the file happened to be committed with.
      .map(({ file, attrs }) => `${file}: text=${attrs?.get('text')} eol=${attrs?.get('eol')}`);
    expect(offenders).toEqual([]);
  });

  it('leaves genuinely binary content unconverted', () => {
    const binaries = binaryFiles();
    const resolved = resolvedAttributes(binaries, ['text']);
    const offenders = binaries
      .filter((file) => resolved.get(file)?.get('text') !== 'unset')
      // A binary file needs its own rule turning `text` off. Auto-detection would spare it in
      // practice, but nothing then stops a future edit to the policy from reaching it, and a
      // mangled fixture is a worse outcome than the defect this file exists to prevent.
      .map((file) => `${file}: text=${resolved.get(file)?.get('text')} (needs a binary rule)`);
    expect(offenders).toEqual([]);
  });
});
