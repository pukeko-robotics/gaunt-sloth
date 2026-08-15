import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * [[EXT-105]] acceptance e2e — **which file descriptor a dialog line actually lands on**, measured
 * in a REAL process whose stdout is a pipe.
 *
 * The in-process suite (`packages/agent/spec/interactiveSessionDialogStream.spec.ts`) drives the
 * whole dialog but has to restore a real `Console` first, because Vitest swaps the global one for a
 * reporter. This is the same claim with nothing restored and nothing patched: a plain `node`
 * importing the BUILT module, its two streams piped, so "on stderr" means the operating system
 * agreed. Piped stdout is also the condition the defect needs — on a terminal both descriptors go to
 * the same place and no ordering difference is observable.
 *
 * The fixture imports the built file by absolute file: URL (not a bare `@gaunt-sloth/core`
 * specifier) so it resolves without workspace node_modules; its transitive `#src/*` imports resolve
 * via core's own package.json `imports` map because the file lives inside packages/core.
 */
const here = dirname(fileURLToPath(import.meta.url));
const consoleUtilsDist = resolve(here, '../dist/utils/consoleUtils.js');
const systemUtilsDist = resolve(here, '../dist/utils/systemUtils.js');

/**
 * A stream's own lines, with anything **Node itself** printed removed.
 *
 * Node writes its warnings to stderr — `(node:1234) ExperimentalWarning: …`, followed by a
 * `(Use \`node --trace-warnings …\`)` line — and a new one appears the moment an API the runtime
 * touches is newly flagged, which is what the `node: latest` CI cell exists to find early. Exact
 * equality on the whole line list is the assertion worth keeping here, so the runtime's noise is
 * filtered out rather than the assertion loosened into "contains". Both patterns are Node's own
 * prefixes and cannot match a dialog line, every one of which is a literal in this file.
 */
const NODE_NOISE = /^\((?:node:\d+\)|Use )/;
const linesOf = (stream: string): string[] =>
  stream.split('\n').filter((line) => Boolean(line) && !NODE_NOISE.test(line));

function runFixture(body: string): { status: number | null; stdout: string; stderr: string } {
  const script = `
import { display, displayDialogLine, displayError, displayInfo, displayWarning } from ${JSON.stringify(
    pathToFileURL(consoleUtilsDist).href
  )};
import { createInterface } from ${JSON.stringify(pathToFileURL(systemUtilsDist).href)};
${body}
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    // Closes stdin at once, so a fixture that opens readline still ends.
    input: '',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('displayDialogLine — process-level stream discipline ([[EXT-105]])', () => {
  /**
   * CONTROL FIRST, because it is what makes the next case an assertion that can fail: the ordinary
   * helpers are split across both descriptors, which is the defect this node exists to fix and the
   * proof that this fixture can see a line on stdout at all.
   */
  it('CONTROL: the ordinary display helpers land on BOTH descriptors', () => {
    const { status, stdout, stderr } = runFixture(`
display('plain-line');
displayInfo('info-line');
displayError('error-line');
displayWarning('warn-line');
`);
    expect(status).toBe(0);
    expect(linesOf(stdout)).toEqual(['plain-line', 'info-line', 'error-line']);
    expect(linesOf(stderr)).toEqual(['warn-line']);
  });

  it('every tone goes to stderr, in order, and nothing at all to stdout', () => {
    const { status, stdout, stderr } = runFixture(`
displayDialogLine('plain-tone');
displayDialogLine('notice-tone', 'notice');
displayDialogLine('warn-tone', 'warn');
displayDialogLine('danger-tone', 'danger');
displayDialogLine('prompt-tone', 'prompt');
`);
    expect(status).toBe(0);
    // Content, not call count: an empty write is still a write, so "never called" would be the
    // weaker claim and the one a zero-byte flush could satisfy.
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual([
      'plain-tone',
      'notice-tone',
      'warn-tone',
      'danger-tone',
      'prompt-tone',
    ]);
  });

  /**
   * The menu line, which is the one the surface can only keep on stderr by NOT handing it to
   * readline: `rl.question(prompt)` writes the prompt to readline's own output, which is stdout.
   * With an empty prompt it writes nothing there, so the dialog's own copy of the question is the
   * only one — and it is on stderr with the rest of the dialog.
   */
  it('readline writes nothing to stdout when the prompt is empty', () => {
    const { status, stdout, stderr } = runFixture(`
displayDialogLine('Approve? [o]nce / [N]o:', 'prompt');
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('').catch(() => {});
rl.close();
`);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Approve? [o]nce / [N]o:');
  });

  /** The control for it: a non-empty prompt DOES reach stdout, which is what is being avoided. */
  it('CONTROL: a non-empty readline prompt does reach stdout', () => {
    const { status, stdout } = runFixture(`
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Approve? [o]nce / [N]o: ').catch(() => {});
rl.close();
`);
    expect(status).toBe(0);
    expect(stdout).toContain('Approve? [o]nce / [N]o: ');
  });
});
