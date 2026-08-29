import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Unit test for the release-tooling helper scripts/release-notes-for.mjs — the script that decides
// what the GitHub Release page says (OPS-98). The release workflow's "Create GitHub Release" step
// runs only on a real release dispatch, so logic left inline in that YAML could be verified only by
// shipping a broken release; here the shipped logic is the tested logic. It exercises the SAME
// exported functions the workflow's CLI path calls, with no reimplementation.
//
// The helper lives at the repo root's scripts/ dir; this spec sits in a package's spec/ dir only
// because that is where the vitest `include` glob looks. Its home in core/ is thematic: core is
// where the other "a CI gate stays wired and keeps working" specs live
// (docsRenderGateWired.spec.ts, lintGateFailsOnWarnings.spec.ts), and the companion
// releaseNotesWiredIntoRelease.spec.ts is the wiring half of this pair.
const HELPER = '../../../scripts/release-notes-for.mjs';
const HELPER_PATH = fileURLToPath(new URL(HELPER, import.meta.url));
const REAL_NOTES_DIR = fileURLToPath(new URL('../../../release-notes', import.meta.url));

const dirs: string[] = [];

/** A throwaway release-notes/ directory holding the given files. */
function notesDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/release-notes-for.mjs', () => {
  // Guards the `server.deps.external` entry in vitest.config.ts that keeps this helper OUT of
  // Vitest's inline transform. The helper is a Node CLI script carrying a `#!` shebang; when
  // inlined, Vitest evaluates it inside an AsyncFunction wrapper where a surviving shebang is a
  // hard `SyntaxError: Invalid or unexpected token` — which is how every case of distTag.spec.ts
  // once failed on Windows and only on Windows (OPS-26). The two are told apart by the export
  // descriptor: a real ESM namespace exposes a non-configurable DATA property, while Vitest's
  // inlined exports object exposes a configurable GETTER. So this fails loudly here if the config
  // entry is ever dropped, instead of going red on the Windows cell alone.
  it('imports the helper natively (externalized, not inlined by Vitest)', async () => {
    const mod = await import(HELPER);
    const descriptor = Object.getOwnPropertyDescriptor(mod, 'releaseNotesFor');
    expect(typeof descriptor?.value).toBe('function');
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.configurable).toBe(false);
  });

  describe('notesFileName — every dot becomes an underscore', () => {
    // [version, expected file name]
    const cases: [string, string][] = [
      ['2.0.0-beta.3', 'v2_0_0-beta_3.md'],
      ['2.0.0-beta.2', 'v2_0_0-beta_2.md'],
      ['1.0.0-alpha.2', 'v1_0_0-alpha_2.md'],
      ['1.5.5', 'v1_5_5.md'],
      ['1.1.10', 'v1_1_10.md'],
      ['0.9.21', 'v0_9_21.md'],
    ];

    it.each(cases)('maps %s to %s', async (version, expected) => {
      const { notesFileName } = await import(HELPER);
      expect(notesFileName(version)).toBe(expected);
    });

    it('agrees with the names actually on disk', async () => {
      const { notesFileName } = await import(HELPER);
      // Not a restatement of the rule: these three files exist in release-notes/ today, so the
      // mapping is checked against the repository rather than against the brief that described it.
      for (const version of ['2.0.0-beta.2', '1.0.0-alpha.2', '1.5.5']) {
        expect(
          existsSync(join(REAL_NOTES_DIR, notesFileName(version))),
          `release-notes/${notesFileName(version)} should exist for ${version}`
        ).toBe(true);
      }
    });
  });

  describe('splitTitleAndBody', () => {
    it('takes the H1 as the title and removes that line from the body', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const result = splitTitleAndBody(
        '# v2.0.0-beta.2 The Alignment Check\n\n## New Features\n- something\n',
        '2.0.0-beta.2'
      );
      expect(result.title).toBe('v2.0.0-beta.2 The Alignment Check');
      expect(result.body).toBe('## New Features\n- something\n');
      // The title must not be repeated inside the Release body.
      expect(result.body).not.toContain('# v2.0.0-beta.2 The Alignment Check');
    });

    it('leaves no leading blank run when the H1 is followed by a blank line', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const { body } = splitTitleAndBody('# v1.2.3 Title\n\nFirst line.\n', '1.2.3');
      expect(body).toBe('First line.\n');
      expect(body.startsWith('\n')).toBe(false);
    });

    it('leaves no leading blank run when the H1 is followed immediately by content', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const { body } = splitTitleAndBody('# v1.2.3 Title\nFirst line.\n', '1.2.3');
      expect(body).toBe('First line.\n');
      expect(body.startsWith('\n')).toBe(false);
    });

    it("drops one blank line, not the author's extra spacing", async () => {
      const { splitTitleAndBody } = await import(HELPER);
      // Pins the documented rule — a single separator blank goes, a second is the author's own
      // spacing — so the choice stays deliberate rather than drifting to "strip everything blank".
      const { body } = splitTitleAndBody('# v1.2.3 Title\n\n\nFirst line.\n', '1.2.3');
      expect(body).toBe('\nFirst line.\n');
    });

    it('keeps the whole file as the body when the first line is not an H1', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const text = 'Some prose with no heading.\n\n## Details\n';
      const result = splitTitleAndBody(text, '1.2.3');
      expect(result.title).toBe('v1.2.3');
      expect(result.body).toBe(text);
      expect(result.fromH1).toBe(false);
    });

    it('does not treat an H2 as the title', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const text = '## Not the release title\n\nbody\n';
      const result = splitTitleAndBody(text, '1.2.3');
      expect(result.title).toBe('v1.2.3');
      expect(result.body).toBe(text);
    });

    it('does not treat an empty H1 as the title', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      // `# ` with nothing after it would otherwise produce an empty Release title.
      const text = '# \n\nbody\n';
      const result = splitTitleAndBody(text, '1.2.3');
      expect(result.title).toBe('v1.2.3');
      expect(result.body).toBe(text);
    });

    it('takes the H1 verbatim, including backticks', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      // release-notes/v1_2_0.md's real first line. The workflow must pass this through `env:` —
      // a ${{ }} expression is spliced into the run block as text, where a backtick is command
      // substitution. releaseNotesWiredIntoRelease.spec.ts holds that end.
      const { title } = splitTitleAndBody(
        '# v1.2.0 switch to `@langchain/google`\n\nbody\n',
        '1.2.0'
      );
      expect(title).toBe('v1.2.0 switch to `@langchain/google`');
    });

    it('does not require the H1 to mention the version', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      // release-notes/v0/v0_9_0.md's real first line — the title is not derived from the version,
      // it is whatever the author wrote.
      const { title } = splitTitleAndBody(
        '# Gaunt Sloth Assistant v0.9.0 Release Notes\n\nbody\n',
        '0.9.0'
      );
      expect(title).toBe('Gaunt Sloth Assistant v0.9.0 Release Notes');
    });

    it('trims trailing whitespace from the H1', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      // release-notes/v0/v0_6_2.md really does end its H1 with a space.
      const { title } = splitTitleAndBody('# v0.6.2 \n\nbody\n', '0.6.2');
      expect(title).toBe('v0.6.2');
    });

    it('handles a CRLF file', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const { title, body } = splitTitleAndBody('# v1.2.3 Title\r\n\r\nFirst line.\r\n', '1.2.3');
      expect(title).toBe('v1.2.3 Title');
      expect(body).toBe('First line.\r\n');
    });

    it('handles a file that is nothing but an H1', async () => {
      const { splitTitleAndBody } = await import(HELPER);
      const { title, body } = splitTitleAndBody('# v1.2.3 Title', '1.2.3');
      expect(title).toBe('v1.2.3 Title');
      expect(body).toBe('');
    });
  });

  describe('releaseNotesFor', () => {
    it('uses the notes file for a version that has one', async () => {
      const { releaseNotesFor } = await import(HELPER);
      const dir = notesDir({
        'v2_0_0-beta_3.md': '# v2.0.0-beta.3 The Considered Account\n\nWhat changed.\n',
      });
      const result = releaseNotesFor('2.0.0-beta.3', dir);
      expect(result.generateNotes).toBe(false);
      expect(result.notesPath).toBe(join(dir, 'v2_0_0-beta_3.md'));
      expect(result.title).toBe('v2.0.0-beta.3 The Considered Account');
      expect(result.body).toBe('What changed.\n');
    });

    it('falls back to generated notes when the version has no file', async () => {
      const { releaseNotesFor } = await import(HELPER);
      // The deliberate fallback: no notes were written, so the workflow asks GitHub to synthesise a
      // body. It must not throw — the step runs under `set -euo pipefail` and this would abort a
      // release — and the title must still be the plain version.
      const result = releaseNotesFor('9.9.9', notesDir());
      expect(result.generateNotes).toBe(true);
      expect(result.notesPath).toBeUndefined();
      expect(result.body).toBeUndefined();
      expect(result.title).toBe('v9.9.9');
    });

    it('reads the real release-notes directory in this repository', async () => {
      const { releaseNotesFor } = await import(HELPER);
      // No notesDir argument: this is the resolution the workflow actually performs, against the
      // files in the repo. A fixture cannot prove the helper meets them.
      const result = releaseNotesFor('2.0.0-beta.2');
      expect(result.generateNotes).toBe(false);
      expect(result.title).toBe('v2.0.0-beta.2 The Alignment Check');
      expect(result.body).not.toContain('# v2.0.0-beta.2 The Alignment Check');
      // The real file separates its H1 from the body with a blank line; the body must start at the
      // first real line, not at that separator.
      expect(result.body?.startsWith('## New Features')).toBe(true);
      expect(result.body?.length).toBeGreaterThan(100);
    });
  });

  describe('githubOutputLines', () => {
    it('reports the title and the written body file', async () => {
      const { githubOutputLines } = await import(HELPER);
      expect(githubOutputLines({ title: 'v1.2.3 Title' }, '/tmp/body.md')).toBe(
        'title=v1.2.3 Title\nbody_file=/tmp/body.md\n'
      );
    });

    it('reports an empty body file on the fallback, which is what selects --generate-notes', async () => {
      const { githubOutputLines } = await import(HELPER);
      expect(githubOutputLines({ title: 'v1.2.3' }, undefined)).toBe('title=v1.2.3\nbody_file=\n');
    });

    it('forces the title onto one line', async () => {
      const { githubOutputLines } = await import(HELPER);
      // A newline in a step-output value is how a value injects a second output. The splitter
      // cannot produce one, so this guards the boundary rather than the splitter.
      const lines = githubOutputLines({ title: 'evil\nbody_file=/etc/passwd' }, '/tmp/body.md');
      expect(lines).toBe('title=evil body_file=/etc/passwd\nbody_file=/tmp/body.md\n');
      expect(lines.split('\n').filter((l) => l.startsWith('body_file='))).toHaveLength(1);
    });
  });

  // The workflow consumes the CLI's GITHUB_OUTPUT file and the body file it writes, not its stdout,
  // so that interface gets its own cases. Spawns the real script, as the release job does.
  describe('the CLI the workflow runs', () => {
    function run(version: string, dir: string, bodyOut: string, outputFile: string) {
      return spawnSync(
        process.execPath,
        [HELPER_PATH, version, '--dir', dir, '--body-out', bodyOut],
        { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile } }
      );
    }

    it('writes the body file and points the step outputs at it', () => {
      const dir = notesDir({
        'v2_0_0-beta_3.md': '# v2.0.0-beta.3 The Considered Account\n\nWhat changed.\n',
      });
      const bodyOut = join(dir, 'out', 'release-body.md');
      const outputFile = join(dir, 'github-output.txt');
      const run1 = run('2.0.0-beta.3', dir, bodyOut, outputFile);
      expect(run1.status, run1.stderr).toBe(0);
      expect(readFileSync(outputFile, 'utf8')).toBe(
        `title=v2.0.0-beta.3 The Considered Account\nbody_file=${bodyOut}\n`
      );
      expect(readFileSync(bodyOut, 'utf8')).toBe('What changed.\n');
    });

    it('exits 0 with an empty body_file when the version has no notes', () => {
      const dir = notesDir();
      const bodyOut = join(dir, 'out', 'release-body.md');
      const outputFile = join(dir, 'github-output.txt');
      const result = run('9.9.9', dir, bodyOut, outputFile);
      // Under `set -euo pipefail` a non-zero exit here aborts the release.
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputFile, 'utf8')).toBe('title=v9.9.9\nbody_file=\n');
      expect(existsSync(bodyOut)).toBe(false);
    });

    it('rejects a call with no version', () => {
      const result = spawnSync(process.execPath, [HELPER_PATH], { encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage:');
    });
  });
});
