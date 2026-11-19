import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { classifyEvalExit, runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import { decodeClaudeStreamJson } from '@gaunt-sloth/batch/transcripts/claudeStreamJson.js';
import type { CommandTarget, EvalSuite, EvalSuiteSummary } from '@gaunt-sloth/batch';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { buildCommandRunCell } from '#src/commands/commandEvalRunner.js';
import { isInsideDir, listWorkspaceEntries } from '#src/commands/commandWorkspaceChecks.js';

// BATCH-59 — a `command` case's workspace assertions end to end: the REAL parser (with a real suite
// directory and template), the REAL runner spawning the fake CLI for the case and for each `after`
// step, and runEvalSuite with its exit classification. Paths are built with `join`/`resolve`, so the
// Windows cells read the same assertions.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_CLI = resolve(HERE, 'fixtures/commandTarget/fake-cli.mjs');
const CAPTURE = resolve(HERE, '../../batch/spec/fixtures/claude-stream-json/capture.jsonl');

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gth-command-wschecks-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A command line starting the fake CLI under this node, each element quoted. */
function fakeLine(...args: string[]): string {
  return [process.execPath, FAKE_CLI, ...args].map((arg) => `"${arg}"`).join(' ');
}

/** A fresh suite directory under scratch, with `files` written into its `fixture/` template. */
function suiteDir(name: string, files: Record<string, string> = {}): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'fixture'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, 'fixture', ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/**
 * Parse a one-case command suite whose file lives in `dir`, with `fixture/` as the workspace
 * template and the given extra case keys. By default the case's command answers with its cwd and
 * writes nothing, so the workspace holds exactly the template; `agent` names another fake-CLI mode.
 */
function suiteWith(dir: string, caseKeys: string, defaults = '', agent = ['cwd']): EvalSuite {
  return parseEvalSuite(
    `
target:
  type: command
  run: ${JSON.stringify(fakeLine(...agent))}
  transcript: claude-stream-json
defaults:
  workspace:
    template: fixture
${defaults}
cases:
  - id: ws
    prompt: "x"
${caseKeys
  .trim()
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
`,
    join(dir, 'suite.yaml'),
    { suiteDir: dir }
  );
}

function targetOf(suite: EvalSuite): CommandTarget {
  if (suite.target.type !== 'command') throw new Error('not a command suite');
  return suite.target;
}

async function run(suite: EvalSuite): Promise<EvalSuiteSummary> {
  const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
  return runEvalSuite(suite, { runCell });
}

/** An `after` entry running the fake CLI, as one YAML flow mapping. */
function afterStep(check: string, ...args: string[]): string {
  return `- { run: ${JSON.stringify(fakeLine(...args))}, ${check} }`;
}

describe('file_contains', () => {
  it('passes when the file holds every string', async () => {
    const dir = suiteDir('fc-pass', { 'src/greet.mjs': '// welcome banner\nexport {};\n' });
    const summary = await run(
      suiteWith(dir, 'file_contains: { "src/greet.mjs": ["welcome banner", "export"] }')
    );
    expect(summary.cases[0].reasons).toEqual([]);
    expect(summary.cases[0].verdict).toBe('PASS');
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('fails, as a product signal, when a string is missing', async () => {
    const dir = suiteDir('fc-fail', { 'src/greet.mjs': '// welcom banner\n' });
    const summary = await run(
      suiteWith(dir, 'file_contains: { "src/greet.mjs": "welcome banner" }')
    );
    expect(summary.cases[0].sutOk).toBe(true);
    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toEqual([
      'file_contains "src/greet.mjs": the file does not contain "welcome banner"',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('fails a missing file with its own reason, not as "no match"', async () => {
    const dir = suiteDir('fc-missing', { 'other.txt': 'welcome banner\n' });
    const summary = await run(
      suiteWith(dir, 'file_contains: { "src/greet.mjs": "welcome banner" }')
    );
    expect(summary.cases[0].reasons).toEqual([
      'file_contains "src/greet.mjs": the file does not exist in the workspace',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('refuses to read a file that a symbolic link leads out of the workspace', async (ctx) => {
    // The outside file HOLDS the needle, so reading through the link would pass the case.
    const outsideDir = join(scratch, 'fc-outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'OUTSIDE-NEEDLE\n');
    const dir = suiteDir('fc-symlink');
    try {
      // Absolute targets, made at run time: the template copy keeps them as written, so the
      // workspace's links lead out of it exactly as an agent-made link would.
      symlinkSync(outsideFile, join(dir, 'fixture', 'leak.txt'), 'file');
      symlinkSync(outsideDir, join(dir, 'fixture', 'leakdir'), 'dir');
    } catch (error) {
      // Windows needs the create-symlink privilege (or Developer Mode) for this; without it there
      // is no link to follow, so the case is skipped there and only there.
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
      }
      throw error;
    }
    const summary = await run(
      suiteWith(
        dir,
        'file_contains: { "leak.txt": "OUTSIDE-NEEDLE", "leakdir/secret.txt": "OUTSIDE-NEEDLE" }'
      )
    );
    expect(summary.cases[0].verdict).toBe('FAIL');
    expect(summary.cases[0].reasons).toHaveLength(2);
    expect(summary.cases[0].reasons[0]).toMatch(
      /^file_contains "leak\.txt": it resolves outside the workspace .* so it was not read$/
    );
    expect(summary.cases[0].reasons[1]).toMatch(
      /^file_contains "leakdir\/secret\.txt": it resolves outside the workspace/
    );
  });

  it('reads a link that stays inside the workspace', async (ctx) => {
    const dir = suiteDir('fc-inner-link', { 'real.txt': 'inner needle\n' });
    try {
      symlinkSync('real.txt', join(dir, 'fixture', 'alias.txt'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
      }
      throw error;
    }
    const summary = await run(suiteWith(dir, 'file_contains: { "alias.txt": "inner needle" }'));
    expect(summary.cases[0].reasons).toEqual([]);
  });
});

/** The checker's own source, run in a child process by the FIFO spec. */
const CHECKS_SOURCE = resolve(HERE, '../src/commands/commandWorkspaceChecks.ts');

describe('file_contains — entries that are not regular files', () => {
  it('fails a named pipe without opening it, within a bounded time', (ctx) => {
    // POSIX only: Windows has no `mkfifo`, and a machine without the tool cannot make the entry.
    if (process.platform === 'win32') ctx.skip();
    const dir = mkdtempSync(join(scratch, 'fifo-'));
    const made = spawnSync('mkfifo', [join(dir, 'greet.mjs')]);
    if (made.error !== undefined) ctx.skip();
    expect(made.status).toBe(0);
    // A read of a FIFO with no writer blocks synchronously, and a vitest timeout cannot interrupt a
    // blocked event loop, so the check runs in a CHILD with a deadline. A regression to opening the
    // pipe fails here in seconds instead of hanging the suite. The child imports the checker's
    // TypeScript source (Node strips the types), so it grades the code under test.
    const script =
      `const { checkFileContains } = await import(${JSON.stringify(pathToFileURL(CHECKS_SOURCE).href)});` +
      `process.stdout.write(JSON.stringify(checkFileContains(process.argv[1], ` +
      `[{ path: 'greet.mjs', substrings: ['welcome'] }])));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    expect(child.error, 'the check blocked on the pipe and was killed').toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([
      'file_contains "greet.mjs": it is a named pipe (FIFO), not a regular file',
    ]);
  }, 30_000);

  it('fails a directory with a reason naming it, as a FAIL rather than a harness error', async () => {
    const dir = suiteDir('fc-dir', { 'src/greet.mjs': 'welcome banner\n' });
    const summary = await run(suiteWith(dir, 'file_contains: { "src": "welcome banner" }'));
    expect(summary.cases[0].sutOk).toBe(true);
    expect(summary.cases[0].reasons).toEqual([
      'file_contains "src": it is a directory, not a regular file',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });
});

describe('workspace entries the checks cannot read', () => {
  /**
   * Run a case whose agent leaves a mode-000 entry, and return the summary. The workspace is the
   * run's own, recorded through the inspection seam; it is removed by the runner, and restored and
   * removed here only if that failed, so a run never leaks it.
   */
  async function runUnreadable(name: string, caseKeys: string, kind: 'file' | 'dir') {
    const dir = suiteDir(name);
    const suite = suiteWith(dir, caseKeys, '', ['unreadable', kind, 'locked']);
    let workspace: string | undefined;
    const removeFailures: string[] = [];
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      inspectWorkspace: (ws, outcome) => {
        workspace = ws.dir;
        return outcome;
      },
      onWorkspaceRemoveFailed: (_caseId, _dir, reason) => removeFailures.push(reason),
    });
    try {
      const summary = await runEvalSuite(suite, { runCell });
      // A mode-000 FILE is removed with its directory. A mode-000 DIRECTORY cannot be listed, so
      // the runner's removal fails and is reported (BATCH-58's notice); the finally below cleans up.
      if (kind === 'file') expect(removeFailures).toEqual([]);
      return summary;
    } finally {
      if (workspace !== undefined && existsSync(workspace)) {
        chmodSync(join(workspace, 'locked'), 0o700);
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }

  /** Mode 000 means nothing to root, and Windows has no such mode. */
  const cannotLock = process.platform === 'win32' || process.getuid?.() === 0;

  it('grades an unreadable file_contains file as a harness error naming the path and code', async (ctx) => {
    if (cannotLock) ctx.skip();
    const summary = await runUnreadable(
      'unreadable-file',
      'file_contains: { "locked": "welcome banner" }',
      'file'
    );
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons).toHaveLength(1);
    expect(summary.cases[0].reasons[0]).toMatch(
      /^SUT run failed: file_contains "locked": the workspace entry could not be read \(EACCES\)/
    );
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it('grades a must_not_exist walk into an unreadable directory as a harness error', async (ctx) => {
    if (cannotLock) ctx.skip();
    const summary = await runUnreadable('unreadable-dir', 'must_not_exist: ["**/*.log"]', 'dir');
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /^SUT run failed: must_not_exist could not list "locked": the workspace entry could not be read \(EACCES\)/
    );
    expect(classifyEvalExit(summary)).toBe(2);
  });
});

describe('must_not_exist', () => {
  it('passes when nothing matches', async () => {
    const dir = suiteDir('mne-pass', { 'src/a.mjs': 'x', 'keep/notes.txt': 'x' });
    const summary = await run(suiteWith(dir, 'must_not_exist: ["notes/*", "**/*.log"]'));
    expect(summary.cases[0].reasons).toEqual([]);
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('catches a dotfile under notes/*, the only entry there', async () => {
    const dir = suiteDir('mne-dot', { 'notes/.hidden': 'x' });
    const summary = await run(suiteWith(dir, 'must_not_exist: ["notes/*"]'));
    expect(summary.cases[0].sutOk).toBe(true);
    expect(summary.cases[0].reasons).toEqual([
      'must_not_exist "notes/*": the workspace has notes/.hidden',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('matches a directory as well as a file', async () => {
    const dir = suiteDir('mne-dir', { 'build/out/x.js': 'x' });
    const summary = await run(suiteWith(dir, 'must_not_exist: ["build"]'));
    expect(summary.cases[0].reasons).toEqual(['must_not_exist "build": the workspace has build']);
  });

  it('lists the entries with / on every platform and never walks through a link', async (ctx) => {
    const dir = suiteDir('mne-walk', { 'a/b/c.txt': 'x' });
    try {
      symlinkSync(scratch, join(dir, 'fixture', 'a', 'up'), 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
      }
      throw error;
    }
    expect(listWorkspaceEntries(join(dir, 'fixture'))).toEqual(['a', 'a/b', 'a/b/c.txt', 'a/up']);
  });
});

describe('after', () => {
  it('passes each kind, run in the workspace with the workspace env and expanded tokens', async () => {
    // marker.txt exists ONLY in the workspace, and the variable is set ONLY by the suite's env, so
    // a step run in gth's cwd or with gth's own environment fails.
    const dir = suiteDir('after-pass', { 'marker.txt': 'WORKSPACE-MARK\n' });
    expect(existsSync(join(getCurrentWorkDir(), 'marker.txt'))).toBe(false);
    expect(process.env.GTH_B59_MARK).toBeUndefined();
    const summary = await run(
      suiteWith(
        dir,
        `after:
  ${afterStep('equals: "WORKSPACE-MARK"', 'print-file', 'marker.txt')}
  ${afterStep('equals: "from-suite"', 'print-env', 'GTH_B59_MARK')}
  ${afterStep(`equals: ${JSON.stringify(`x${delimiter}y`)}`, 'print', 'x{{path_delimiter}}y')}
  ${afterStep('contains: "MARK"', 'print-file', 'marker.txt')}
  ${afterStep('exit_code: 3', 'print', 'anything', '3')}
  ${afterStep('equals: "line one\\nline two"', 'print', 'line one\r\nline two\r\n')}`,
        '    env: { GTH_B59_MARK: "from-suite" }'
      )
    );
    expect(summary.cases[0].reasons).toEqual([]);
    expect(summary.cases[0].verdict).toBe('PASS');
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('fails a step whose output does not match, and still runs the steps after it', async () => {
    const dir = suiteDir('after-fail');
    const summary = await run(
      suiteWith(
        dir,
        `after:
  ${afterStep('equals: ""', 'print', ' M src/other.mjs\n')}
  ${afterStep('contains: "clean"', 'print', 'dirty')}
  ${afterStep('exit_code: 0', 'print', 'x', '4')}`
      )
    );
    const [result] = summary.cases;
    expect(result.sutOk).toBe(true);
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons[0]).toMatch(
      // `s`: the step's own command line holds the newline it prints.
      /^after step 1 of 3 \(.*\): expected stdout "", got "M src\/other\.mjs"$/s
    );
    expect(result.reasons[1]).toMatch(
      /^after step 2 of 3 \(.*\): stdout does not contain "clean"; it was "dirty"$/
    );
    expect(result.reasons[2]).toMatch(
      /^after step 3 of 3 \(.*\): expected exit code 0, got 4; stderr: fake-cli: stderr tail$/
    );
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('fails a step that exits non-zero under equals or contains, whatever it printed', async () => {
    // Each step prints exactly what its check asks for, and exits 3: it must not pass on that.
    const dir = suiteDir('after-crash');
    const summary = await run(
      suiteWith(
        dir,
        `after:
  ${afterStep('equals: ""', 'print', '', '3')}
  ${afterStep('contains: "ok"', 'print', 'ok', '3')}`
      )
    );
    const [result] = summary.cases;
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toMatch(
      /^after step 1 of 2 \(.*\) exited with code 3, so its output was not compared \(equals\); stderr: fake-cli: stderr tail$/
    );
    expect(result.reasons[1]).toMatch(/exited with code 3, so its output was not compared/);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('grades a step that cannot start as a harness error (exit 2)', async () => {
    const dir = suiteDir('after-missing');
    const summary = await run(
      suiteWith(
        dir,
        `after:
  - { run: "gth-eval-no-such-after-59", equals: "" }`
      )
    );
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /^SUT run failed: after step 1 of 1 \("gth-eval-no-such-after-59"\) could not start/
    );
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it('kills a step that outlives the case timeout, and grades it as a harness error', async () => {
    const dir = suiteDir('after-hang');
    const pidFile = join(scratch, 'after-hang.pid');
    const summary = await run(
      suiteWith(
        dir,
        `timeout_ms: 400
after:
  ${afterStep('equals: ""', 'hang', pidFile)}`
      )
    );
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /after step 1 of 1 .* did not finish within the case's 400ms timeout/
    );
    expect(classifyEvalExit(summary)).toBe(2);
  }, 20_000);
});

describe('workspace assertions — when they are not graded', () => {
  it('grades nothing in the workspace when the case command itself failed', async () => {
    const dir = suiteDir('not-graded');
    const marker = join(scratch, 'not-graded-after-ran.txt');
    const suite = parseEvalSuite(
      `
target:
  type: command
  run: ${JSON.stringify(fakeLine('exit', '5', CAPTURE))}
  transcript: claude-stream-json
cases:
  - id: ws
    prompt: "x"
    workspace: {}
    file_contains: { "nothing.txt": "x" }
    after:
      - { run: ${JSON.stringify(fakeLine('write', marker, 'ran'))}, exit_code: 0 }
`,
      join(dir, 'suite.yaml'),
      { suiteDir: dir }
    );
    const summary = await run(suite);
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons).toHaveLength(1);
    expect(summary.cases[0].reasons[0]).toMatch(/^SUT run failed: the command exited with code 5/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('isInsideDir', () => {
  it('tells a sibling that starts with the same name, or with "..", from a child', () => {
    const root = resolve(scratch, 'root');
    expect(isInsideDir(root, root)).toBe(true);
    expect(isInsideDir(root, join(root, 'a', 'b'))).toBe(true);
    expect(isInsideDir(root, join(root, '..cache'))).toBe(true);
    expect(isInsideDir(root, resolve(scratch, 'root-sibling'))).toBe(false);
    expect(isInsideDir(root, scratch)).toBe(false);
    expect(isInsideDir(root, resolve(scratch, 'other', 'x'))).toBe(false);
  });
});
