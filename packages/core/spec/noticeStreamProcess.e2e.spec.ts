import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * [[EXT-165]] acceptance e2e — **which file descriptor each line of a NOTICE actually lands on**,
 * measured in a REAL process whose two streams are separate pipes.
 *
 * The defect is not that a line was missing; it is *which stream* each line went to. A spec that
 * captures "output" without separating the two passes identically before and after the fix, so the
 * measurement has to be made where the operating system is the one answering. Nothing is mocked
 * here and nothing is patched: a plain `node` imports the BUILT modules and its stdout and stderr
 * are collected apart.
 *
 * Piped streams are also the condition the defect needs. On a terminal both descriptors go to the
 * same place, so a torn notice looks whole and no ordering difference is observable.
 *
 * The fixture imports the built files by absolute file: URL (not a bare `@gaunt-sloth/core`
 * specifier) so it resolves without workspace node_modules; its transitive `#src/*` imports resolve
 * via core's own package.json `imports` map because the file lives inside packages/core.
 */
const here = dirname(fileURLToPath(import.meta.url));
const consoleUtilsDist = resolve(here, '../dist/utils/consoleUtils.js');
const terminationNoticeDist = resolve(here, '../dist/core/terminationNotice.js');
const terminationReasonDist = resolve(here, '../dist/core/terminationReason.js');

/**
 * A stream's own lines, with anything **Node itself** printed removed.
 *
 * Node writes its warnings to stderr — `(node:1234) ExperimentalWarning: …`, followed by a
 * `(Use \`node --trace-warnings …\`)` line — and a new one appears the moment an API the runtime
 * touches is newly flagged, which is what the `node: latest` CI cell exists to find early. Exact
 * equality on the whole line list is the assertion worth keeping here, so the runtime's noise is
 * filtered out rather than the assertion loosened into "contains".
 */
const NODE_NOISE = /^\((?:node:\d+\)|Use )/;
const linesOf = (stream: string): string[] =>
  stream.split('\n').filter((line) => Boolean(line) && !NODE_NOISE.test(line));

function runFixture(body: string): { status: number | null; stdout: string; stderr: string } {
  const script = `
import { display, displayNotice, displayInfo, displayWarning, setConsoleLevel, NOTICE_WARN_MARKER } from ${JSON.stringify(
    pathToFileURL(consoleUtilsDist).href
  )};
import { displayTermination, terminationNotice } from ${JSON.stringify(
    pathToFileURL(terminationNoticeDist).href
  )};
import { terminationReason } from ${JSON.stringify(pathToFileURL(terminationReasonDist).href)};
import { StatusLevel } from ${JSON.stringify(
    pathToFileURL(resolve(here, '../dist/core/types.js')).href
  )};
${body}
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    input: '',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('displayNotice — process-level stream discipline ([[EXT-165]])', () => {
  /**
   * CONTROL FIRST, and it is what makes every case below an assertion that can fail: it replays the
   * exact pairing both notice renderers used — the title through `displayWarning` and each body
   * line through `display` — and shows the notice arriving in two pieces on two descriptors. It is
   * also the proof that this fixture can see a line on stdout at all, without which "nothing on
   * stdout" would hold no matter what the writer did.
   */
  it('CONTROL: the old title/body pairing tears the notice across both descriptors', () => {
    const { status, stdout, stderr } = runFixture(`
displayWarning('Run ended: the provider failed');
display('  Reason code: provider_error@runner.invoke');
`);
    expect(status).toBe(0);
    // The half a redirect would have kept...
    expect(linesOf(stdout)).toEqual(['  Reason code: provider_error@runner.invoke']);
    // ...and the half it would have discarded.
    expect(linesOf(stderr)).toEqual(['Run ended: the provider failed']);
  });

  it('puts a warn notice — title AND body — on stderr, in order, and nothing on stdout', () => {
    const { status, stdout, stderr } = runFixture(`
displayNotice('Approvals posture', ['Mode: write', 'Refusals: 1'], { tone: 'warn' });
`);
    expect(status).toBe(0);
    // Content, not call count: an empty write is still a write, so "never called" would be the
    // weaker claim and the one a zero-byte flush could satisfy.
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual(['⚠ Approvals posture', '  Mode: write', '  Refusals: 1']);
  });

  it('puts an info notice — title AND body — on stderr too, and nothing on stdout', () => {
    const { status, stdout, stderr } = runFixture(`
displayNotice('Session status', ['Mode: code', 'Turns so far: 2']);
`);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual(['Session status', '  Mode: code', '  Turns so far: 2']);
  });

  /**
   * The renderer the node was filed about, driven for real rather than replayed: the notice a user
   * sees when a run ends badly, with the token they are asked to quote in a bug report.
   *
   * The reason code and the title must reach the SAME place. Under the old pairing `gth ask … >
   * out.txt` put the title on the screen and the code in the file, so the person had a notice with
   * no code and the file they attached had a code with no notice.
   */
  it('displayTermination writes the whole notice, reason code included, to stderr', () => {
    const { status, stdout, stderr } = runFixture(`
const reason = terminationReason('runner.invoke', 'exception', 'context_overflow');
const shown = displayTermination(reason);
if (shown !== true) { console.error('EXPECTED-TRUE-GOT:' + shown); process.exit(3); }
`);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    const lines = linesOf(stderr);
    // The title, marked as a warning in the TEXT and not only in a colour that a pipe strips.
    expect(lines[0]).toBe('⚠ Run ended: the conversation outgrew the model input window');
    // The quotable token, on the same descriptor as the title that explains it.
    expect(lines).toContain('  Reason code: context_overflow@runner.invoke');
    // Nothing of the notice went anywhere else.
    expect(lines.length).toBe(3);
  });

  /**
   * The gate ruling, at the process level: a termination notice is `gate: 'always'`, so a console
   * quieted to ERROR — where every level-gated helper is silent — still delivers the whole thing.
   *
   * The `display` CONTROL is load-bearing. Without it this cell would pass just as well if
   * `setConsoleLevel` had quietly done nothing, which is the shape of an assertion that cannot
   * fail.
   */
  it('delivers the whole termination notice at consoleLevel error, where gated helpers are silent', () => {
    const { status, stdout, stderr } = runFixture(`
setConsoleLevel(StatusLevel.ERROR);
display('CONTROL-the-gated-helper');
displayInfo('CONTROL-the-gated-info-helper');
displayTermination(terminationReason('runner.invoke', 'exception', 'rate_limited'));
`);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    const lines = linesOf(stderr);
    expect(lines.join('\n')).not.toContain('CONTROL-the-gated');
    expect(lines[0]).toBe('⚠ Run ended: the provider rate-limited the request');
    expect(lines).toContain('  Reason code: rate_limited@runner.invoke');
  });

  /**
   * The other half of the gate ruling: a notice the user asked for by typing a command IS gated, at
   * its own tone's level — and gated as a WHOLE. The old rendering filtered the title and the body
   * at different levels, so at `warning` a notice printed its title with nothing under it and at
   * `display` an info notice printed its body with no title over it. Both halves are pinned here,
   * on both descriptors, so a reinstated per-line filter fails whichever way it is written.
   */
  it('gates a command notice whole: at consoleLevel warning the warn one is complete and the info one is absent', () => {
    const { status, stdout, stderr } = runFixture(`
setConsoleLevel(StatusLevel.WARNING);
displayNotice('WARN-TITLE', ['warn-body'], { tone: 'warn' });
displayNotice('INFO-TITLE', ['info-body']);
`);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(linesOf(stderr)).toEqual(['⚠ WARN-TITLE', '  warn-body']);
  });

  it('gates a command notice whole: at consoleLevel display neither half of the info notice appears', () => {
    const { status, stdout, stderr } = runFixture(`
setConsoleLevel(StatusLevel.DISPLAY);
// The CONTROL: at DISPLAY level the helper the body lines used to go through still prints, which
// is exactly how a title-less body reached the screen. If this line is missing the level never
// took effect and the assertion below would be vacuous.
display('CONTROL-display-level-is-in-effect');
displayNotice('INFO-TITLE', ['info-body']);
`);
    expect(status).toBe(0);
    expect(linesOf(stdout)).toEqual(['CONTROL-display-level-is-in-effect']);
    expect(stderr).toBe('');
  });
});
