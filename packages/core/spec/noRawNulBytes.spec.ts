import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OPS-34 — no tracked text file may contain a raw NUL byte.
 *
 * A NUL is what makes a search tool classify a file as binary. Measured on the three engines that
 * matter here: ripgrep and ugrep **silently omit** such a file from a recursive search — no match,
 * no warning, exit 0 — while GNU grep at least prints "binary file matches" without a line. An
 * empty result then reads as proof of absence, which is how a single stray byte in
 * `GthLangChainAgent.ts` produced three false conclusions about code that was there all along.
 *
 * Scope is deliberately NUL only, not "no C0 control characters". ESC (U+001B) appears legitimately
 * in the TUI specs that assert ANSI sequences, and — measured the same way — a file containing ESC
 * is found by every one of those engines. Banning it would cost real assertions and buy nothing.
 * A control character used as a data delimiter is fine; writing it as a raw byte in SOURCE is not.
 * Use the escape form (see `TOOL_CALL_SIGNATURE_DELIMITER` in `GthLangChainAgent.ts`).
 *
 * The file list comes from `git ls-files`, so it covers every tracked file in every package rather
 * than one directory, and untracked build output can never trip it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Tracked files that are legitimately binary and therefore exempt. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.gz',
  '.wasm',
]);

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return dot > slash ? file.slice(dot).toLowerCase() : '';
}

let cachedFiles: string[] | undefined;

/** Memoised: the list is identical for every test here, and the Windows cells pay for each spawn. */
function trackedTextFiles(): string[] {
  if (cachedFiles) return cachedFiles;
  // -z: NUL-separated, so a path containing a newline cannot split one entry into two.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  cachedFiles = out
    .split(String.fromCharCode(0))
    .filter(Boolean)
    .filter((f) => !BINARY_EXTENSIONS.has(extensionOf(f)));
  return cachedFiles;
}

/** The detector under test: the offsets of every NUL byte in a buffer. */
function nulOffsets(buffer: Buffer): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) offsets.push(i);
  }
  return offsets;
}

describe('OPS-34 no raw NUL bytes in tracked text files', () => {
  it('detects a NUL when one is present, and does not when it is absent', () => {
    // Control mutation: without this pair, a detector that always returned [] would let every
    // assertion below pass on an empty promise.
    const clean = Buffer.from('const delimiter = "\\u0000";\n', 'utf8');
    const dirty = Buffer.concat([Buffer.from('a'), Buffer.from([0]), Buffer.from('b')]);

    expect(nulOffsets(clean)).toEqual([]);
    expect(nulOffsets(dirty)).toEqual([1]);
    // The escape FORM is what source must use, and it is not itself a NUL byte.
    expect(clean.includes(0)).toBe(false);
  });

  it('scans a plausible number of tracked files', () => {
    // Anti-vacuity: a failed git call or a wrong cwd would yield an empty list, and every
    // per-file assertion would then pass by scanning nothing.
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('packages/core/src/core/GthLangChainAgent.ts');
  });

  it('no tracked text file contains a raw NUL byte', () => {
    const offenders: string[] = [];
    for (const file of trackedTextFiles()) {
      const buffer = readFileSync(join(REPO_ROOT, file));
      const offsets = nulOffsets(buffer);
      if (offsets.length > 0) {
        offenders.push(`${file} (${offsets.length} at byte ${offsets[0]})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every tracked text file is valid UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const offenders: string[] = [];
    for (const file of trackedTextFiles()) {
      try {
        decoder.decode(readFileSync(join(REPO_ROOT, file)));
      } catch {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
