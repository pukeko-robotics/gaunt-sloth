import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OPS-34 — no tracked text file may contain a raw C0 control character in its source.
 *
 * NUL is the one that does real damage: it makes a search tool classify a file as binary. Measured
 * on the three engines in use here, ripgrep and ugrep **silently omit** such a file from a
 * recursive search — no match, no warning, exit 0 — while GNU grep prints "binary file matches"
 * with no line. An empty result then reads as proof of absence, which is how one stray byte in
 * `GthLangChainAgent.ts` produced three separate false conclusions about code that was there all
 * along. Using a control character as a data delimiter is fine; writing it as a raw byte in SOURCE
 * is not — use the escape form, as `TOOL_CALL_SIGNATURE_DELIMITER` does.
 *
 * ESC (U+001B) is the one deliberate exemption, on measurement rather than taste: it is the only
 * other C0 byte present in the repo (6 of them, in two TUI specs asserting ANSI colour sequences),
 * and — checked against the same three engines — a file containing ESC is found normally by all of
 * them. Banning it would cost real assertions and prevent nothing. Every other C0 byte is refused:
 * none is present today, and a BEL or FF appearing in source is an accident by definition.
 *
 * The file list comes from `git ls-files`, so this covers every tracked file in every package and
 * untracked build output can never trip it.
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

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
/** Allowed on measurement — see the header. */
const ESCAPE = 0x1b;

const ALLOWED_CONTROL_BYTES = new Set([TAB, LINE_FEED, CARRIAGE_RETURN, ESCAPE]);

function isDisallowedControlByte(byte: number): boolean {
  return byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte);
}

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

/** The detector under test: every disallowed control byte in a buffer, as `0xNN at <offset>`. */
function controlByteHits(buffer: Buffer): string[] {
  const hits: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (isDisallowedControlByte(buffer[i])) {
      hits.push(`0x${buffer[i].toString(16).padStart(2, '0')} at ${i}`);
    }
  }
  return hits;
}

describe('OPS-34 no raw control bytes in tracked text files', () => {
  it('flags the bytes it must and passes the ones it must allow', () => {
    // Control mutation: without this pair a detector that always returned [] would let every
    // assertion below pass while scanning nothing meaningful.
    const withNul = Buffer.concat([Buffer.from('a'), Buffer.from([0x00]), Buffer.from('b')]);
    const withBel = Buffer.concat([Buffer.from('a'), Buffer.from([0x07]), Buffer.from('b')]);
    const withEsc = Buffer.concat([Buffer.from('a'), Buffer.from([ESCAPE]), Buffer.from('[31m')]);
    const withWhitespace = Buffer.from('a\tb\r\nc', 'utf8');
    // The escape FORM that source must use is six ordinary characters, not a control byte.
    const escapedForm = Buffer.from('const d = "\\u0000";\n', 'utf8');

    expect(controlByteHits(withNul)).toEqual(['0x00 at 1']);
    expect(controlByteHits(withBel)).toEqual(['0x07 at 1']);
    expect(controlByteHits(withEsc)).toEqual([]);
    expect(controlByteHits(withWhitespace)).toEqual([]);
    expect(controlByteHits(escapedForm)).toEqual([]);
  });

  it('scans a plausible number of tracked files', () => {
    // Anti-vacuity: a failed git call or a wrong cwd would yield an empty list, and every
    // per-file assertion would then pass by scanning nothing.
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('packages/core/src/core/GthLangChainAgent.ts');
  });

  it('no tracked text file contains a raw control byte', () => {
    const offenders: string[] = [];
    for (const file of trackedTextFiles()) {
      const hits = controlByteHits(readFileSync(join(REPO_ROOT, file)));
      if (hits.length > 0) offenders.push(`${file}: ${hits[0]}`);
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
