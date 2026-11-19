import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { classifyEvalExit, runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import { decodeClaudeStreamJson } from '@gaunt-sloth/batch/transcripts/claudeStreamJson.js';
import type { CommandTarget, EvalSuite } from '@gaunt-sloth/batch';
import {
  getCurrentWorkDir,
  peekProjectDir,
  setProjectDir,
} from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  buildCommandRunCell,
  killLiveCommandChildren,
  type CommandSpawnRequest,
} from '#src/commands/commandEvalRunner.js';
import { mergeWorkspaceEnv, readEnvVar, resolveSuiteDir } from '#src/commands/commandWorkspace.js';

// BATCH-58 — a `command` case's workspace end to end: the REAL parser (with a real suite directory
// and template), the REAL runner spawning the fake CLI, and runEvalSuite. Paths are compared with
// `resolve()`, never as POSIX literals, so the Windows cells read the same assertions.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_CLI = resolve(HERE, 'fixtures/commandTarget/fake-cli.mjs');
const CAPTURE = resolve(HERE, '../../batch/spec/fixtures/claude-stream-json/capture.jsonl');

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gth-command-workspace-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A command line starting the fake CLI under this node, each element quoted. */
function fakeLine(...args: string[]): string {
  return [process.execPath, FAKE_CLI, ...args].map((arg) => `"${arg}"`).join(' ');
}

/** A fresh suite directory under scratch. */
function suiteDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse a command suite whose file lives in `dir`. */
function commandSuite(dir: string, run: string, rest: string): EvalSuite {
  return parseEvalSuite(
    `
target:
  type: command
  run: ${JSON.stringify(run)}
  transcript: claude-stream-json
${rest}
`,
    join(dir, 'suite.yaml'),
    { suiteDir: dir }
  );
}

function targetOf(suite: EvalSuite): CommandTarget {
  if (suite.target.type !== 'command') throw new Error('not a command suite');
  return suite.target;
}

/** A digest of every file under `dir`, by relative path, so any change to the tree shows. */
function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        hash.update(relative(dir, full));
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

describe('command workspace — isolation', () => {
  it('gives two concurrent cases their own copy of the fixture, and leaves the fixture alone', async () => {
    const dir = suiteDir('isolation');
    mkdirSync(join(dir, 'fixture', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'fixture', 'shared.txt'), 'base\n');
    writeFileSync(join(dir, 'fixture', 'nested', 'keep.txt'), 'untouched\n');
    const barrierDir = join(scratch, 'isolation-barrier');
    mkdirSync(barrierDir);
    const before = hashTree(join(dir, 'fixture'));

    const suite = commandSuite(
      dir,
      fakeLine('edit-shared', barrierDir, 'shared.txt'),
      `
defaults:
  workspace: { template: fixture }
cases:
  - { id: a, prompt: "A", must_contain: [base] }
  - { id: b, prompt: "B", must_contain: [base] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell, concurrency: 2 });

    // Both cases met at both barriers, so they really did run at the same time: a barrier that
    // gave up waiting writes a `.timedout` file, which would appear in this listing.
    expect(readdirSync(barrierDir).sort()).toEqual([
      'A.ready',
      'A.written',
      'B.ready',
      'B.written',
    ]);
    const answers = Object.fromEntries(summary.cases.map((c) => [c.id, c.answer]));
    expect(answers).toEqual({ a: 'base\nA\n', b: 'base\nB\n' });
    expect(hashTree(join(dir, 'fixture'))).toBe(before);
    expect(classifyEvalExit(summary)).toBe(0);
  }, 30_000);

  it('BATCH-60: gives every run of a repeated case its own fresh copy of the fixture', async () => {
    const dir = suiteDir('repeat-isolation');
    mkdirSync(join(dir, 'fixture'));
    writeFileSync(join(dir, 'fixture', 'shared.txt'), 'base\n');
    const before = hashTree(join(dir, 'fixture'));

    const suite = commandSuite(
      dir,
      fakeLine('append', 'shared.txt'),
      `
defaults:
  workspace: { template: fixture }
cases:
  - { id: again, prompt: "A", repeat: 3, must_contain: [base] }
`
    );
    const seen: Array<{ caseId: string; dir: string; content: string }> = [];
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      inspectWorkspace: (workspace, outcome) => {
        seen.push({
          caseId: workspace.caseId,
          dir: resolve(workspace.dir),
          content: readFileSync(join(workspace.dir, 'shared.txt'), 'utf8'),
        });
        return outcome;
      },
    });
    const summary = await runEvalSuite(suite, { runCell, concurrency: 3 });

    // Three runs, each looked up under the case's own id (so each got the case's workspace), in
    // three distinct directories, and each saw only its own write: a shared or reused workspace
    // would show a second "A" line in a later run.
    expect(seen).toHaveLength(3);
    expect(seen.every((entry) => entry.caseId === 'again')).toBe(true);
    expect(new Set(seen.map((entry) => entry.dir)).size).toBe(3);
    expect(seen.map((entry) => entry.content)).toEqual(['base\nA\n', 'base\nA\n', 'base\nA\n']);
    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0].repeat).toMatchObject({ runs: 3, passed: 3 });
    expect(summary.cases[0].runs?.map((run) => run.answer)).toEqual([
      'base\nA\n',
      'base\nA\n',
      'base\nA\n',
    ]);
    expect(seen.every((entry) => !existsSync(entry.dir))).toBe(true);
    expect(hashTree(join(dir, 'fixture'))).toBe(before);
    expect(classifyEvalExit(summary)).toBe(0);
  }, 30_000);

  it('removes the workspace after the case, and runs the case there rather than in the cwd', async () => {
    const dir = suiteDir('removal');
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - { id: where, prompt: "x", workspace: {}, must_contain: [gth-eval-where-] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    const workspace = summary.cases[0].answer!;
    expect(summary.cases[0].verdict).toBe('PASS');
    expect(resolve(workspace)).not.toBe(resolve(getCurrentWorkDir()));
    expect(existsSync(workspace)).toBe(false);
  });

  it('keeps the workspace with keepWorkspaces, and reports its path before the command runs', async () => {
    const dir = suiteDir('keep');
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - { id: kept, prompt: "x", workspace: {}, must_contain: [gth-eval-kept-] }
`
    );
    const kept: Array<[string, string]> = [];
    const events: string[] = [];
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      keepWorkspaces: true,
      onWorkspaceKept: (caseId, keptDir) => {
        kept.push([caseId, keptDir]);
        events.push('kept');
      },
      inspectWorkspace: (_workspace, outcome) => {
        events.push('ran');
        return outcome;
      },
    });
    const summary = await runEvalSuite(suite, { runCell });
    try {
      // Reported as the case starts, so an interrupted case's path is still printed.
      expect(events).toEqual(['kept', 'ran']);
      expect(kept).toHaveLength(1);
      expect(kept[0][0]).toBe('kept');
      expect(resolve(kept[0][1])).toBe(resolve(summary.cases[0].answer!));
      expect(existsSync(kept[0][1])).toBe(true);
    } finally {
      for (const [, keptDir] of kept) rmSync(keptDir, { recursive: true, force: true });
    }
  });

  it('hands BATCH-59 the workspace after the run and before removal, and reports what it returns', async () => {
    const dir = suiteDir('inspect');
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - { id: inspected, prompt: "x", workspace: {}, must_contain: [gth-eval-] }
`
    );
    let seen: { dir: string; existed: boolean; answer?: string } | undefined;
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      inspectWorkspace: (workspace, outcome) => {
        seen = { dir: workspace.dir, existed: existsSync(workspace.dir), answer: outcome.answer };
        return { ok: false, error: 'the inspection says no' };
      },
    });
    const summary = await runEvalSuite(suite, { runCell });
    expect(seen?.existed).toBe(true);
    expect(resolve(seen!.answer!)).toBe(resolve(seen!.dir));
    expect(existsSync(seen!.dir)).toBe(false);
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(/the inspection says no/);
  });
});

describe('command workspace — env and stubs', () => {
  it('calls the stub on the suite PATH in place of the command the inherited PATH would find', async () => {
    const dir = suiteDir('stubs');
    mkdirSync(join(dir, 'stubs'));
    writeFileSync(
      join(dir, 'stubs', 'fake-tool.mjs'),
      'process.stdout.write(`stub|${process.argv[2]}|${process.cwd()}`);\n'
    );
    // The same name on the INHERITED path: what runs when the suite's env does not reach the child.
    const decoy = join(scratch, 'decoy-bin');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'fake-tool.mjs'), "process.stdout.write('decoy');\n");
    const inherited = mergeWorkspaceEnv(process.env, {
      PATH: `${decoy}${delimiter}${readEnvVar(process.env, 'PATH') ?? ''}`,
    });

    const nonce = `n${process.pid}x${Date.now()}`;
    const suite = commandSuite(
      dir,
      fakeLine('call-stub', 'fake-tool'),
      `
defaults:
  workspace:
    env: { PATH: "{{suite_dir}}/stubs{{path_delimiter}}{{env.PATH}}" }
cases:
  - { id: stubbed, prompt: ${JSON.stringify(nonce)}, must_contain: [stub] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      env: inherited,
    });
    const summary = await runEvalSuite(suite, { runCell });
    const [stubAnswer, prompt, cwd] = (summary.cases[0].answer ?? '').split('|');
    // The stub ran (its own output, carrying this run's nonce), in the case's workspace.
    expect(stubAnswer).toBe('stub');
    expect(prompt).toBe(nonce);
    expect(cwd).toMatch(/gth-eval-stubbed-/);
    expect(summary.cases[0].verdict).toBe('PASS');
  });

  it('expands tokens in setup arguments and env values, with setup running in the workspace first', async () => {
    const dir = suiteDir('setup-ok');
    const suite = commandSuite(
      dir,
      fakeLine('cat', 'made.txt'),
      `
defaults:
  workspace:
    setup:
      - ${JSON.stringify(fakeLine('write', '{{workspace}}/made.txt', 'from {{env.GTH_B58_GREETING}} via {{suite_dir}}'))}
cases:
  - { id: made, prompt: "x", must_contain: [from] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      env: mergeWorkspaceEnv(process.env, { GTH_B58_GREETING: 'a value; with spaces' }),
    });
    const summary = await runEvalSuite(suite, { runCell });
    // One argument each: the expanded value with spaces and a `;` did not split or run anything.
    expect(summary.cases[0].answer).toBe(`from a value; with spaces via ${dir}`);
  });

  it('passes compact JSON in an env value to the child unchanged', async () => {
    const json = '{"a":{"b":1},"c":[{"d":"}}"}]}';
    const suite = commandSuite(
      suiteDir('env-json'),
      fakeLine('env-var', 'GTH_B58_JSON'),
      `
cases:
  - id: env-json
    prompt: "x"
    must_contain: ['"a"']
    workspace: { env: { GTH_B58_JSON: ${JSON.stringify(json)} } }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].answer).toBe(json);
  });

  it('sets the case env over the inherited one', async () => {
    const dir = suiteDir('env');
    const suite = commandSuite(
      dir,
      fakeLine('env-var', 'GTH_B58_WS'),
      `
cases:
  - id: env
    prompt: "x"
    must_contain: [gth-eval-env-]
    workspace: { env: { GTH_B58_WS: "{{workspace}}" } }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].verdict).toBe('PASS');
  });
});

describe('command workspace — setup failures', () => {
  it('grades a failing setup step as a harness error (exit 2) and never starts the command', async () => {
    const dir = suiteDir('setup-fails');
    const commandMarker = join(scratch, 'command-ran.txt');
    const laterStepMarker = join(scratch, 'later-step-ran.txt');
    const wsPathFile = join(scratch, 'broken-setup-ws.path');
    const suite = commandSuite(
      dir,
      fakeLine('record', commandMarker, CAPTURE),
      `
defaults:
  workspace:
    setup:
      - ${JSON.stringify(fakeLine('write', wsPathFile, '{{workspace}}'))}
      - ${JSON.stringify(fakeLine('exit', '5', CAPTURE))}
      - ${JSON.stringify(fakeLine('write', laterStepMarker, 'ran'))}
cases:
  - { id: broken, prompt: "x", must_call: [Read] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    const [result] = summary.cases;
    expect(result.sutOk).toBe(false);
    expect(result.reasons[0]).toMatch(
      /workspace setup step 2 of 3 \(".*exit.*"\) exited with code 5; the case's command was not started; stderr: fake-cli: failing on purpose/
    );
    expect(existsSync(laterStepMarker)).toBe(false);
    expect(existsSync(commandMarker)).toBe(false);
    expect(classifyEvalExit(summary)).toBe(2);
    // The failed case's own workspace, named by the run itself, was removed too.
    const workspace = readFileSync(wsPathFile, 'utf8');
    expect(workspace).toMatch(/gth-eval-broken-/);
    expect(existsSync(workspace)).toBe(false);
  });

  it('grades a setup step that cannot start as a harness error', async () => {
    const dir = suiteDir('setup-missing');
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - { id: a, prompt: "x", must_contain: [x], workspace: { setup: ["gth-eval-no-such-setup-58"] } }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /workspace setup step 1 of 1 \("gth-eval-no-such-setup-58"\) could not start/
    );
  });

  it('kills a setup step that outlives the case timeout', async () => {
    const dir = suiteDir('setup-hangs');
    const pidFile = join(scratch, 'setup-hang.pid');
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - id: slow
    prompt: "x"
    timeout_ms: 400
    must_contain: [x]
    workspace: { setup: [${JSON.stringify(fakeLine('hang', pidFile))}] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /workspace setup step 1 of 1 .* did not finish within the case's 400ms timeout/
    );
  }, 20_000);
});

describe('command workspace — how a setup step is started', () => {
  it('runs a setup step in the workspace, with the workspace env and no prompt', async () => {
    const dir = suiteDir('setup-start');
    // A RELATIVE output path: where it lands is decided by the step's cwd alone.
    const relativeFile = `setup-dump-${process.pid}-${Date.now()}.json`;
    const leaked = resolve(getCurrentWorkDir(), relativeFile);
    const suite = commandSuite(
      dir,
      fakeLine('cat', relativeFile),
      `
defaults:
  workspace:
    setup:
      - ${JSON.stringify(fakeLine('argv-dump', relativeFile, 'fixed-arg'))}
    env: { GTH_B58_SETUP_MARK: "mark-{{path_delimiter}}" }
cases:
  - { id: setup-start, prompt: "THE-CASE-PROMPT", must_contain: [fixed-arg] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    try {
      const summary = await runEvalSuite(suite, { runCell });
      // The case's command found the file in ITS cwd, the workspace, so setup wrote it there.
      expect(summary.cases[0].sutOk).toBe(true);
      const dump = JSON.parse(summary.cases[0].answer!);
      // The prompt is not appended to a setup step: only the step's own argument arrived.
      expect(dump.args).toEqual(['fixed-arg']);
      // The step saw the workspace env, expanded.
      expect(dump.mark).toBe(`mark-${delimiter}`);
      // And nothing was written where gth was started.
      expect(existsSync(leaked)).toBe(false);
    } finally {
      rmSync(leaked, { force: true });
    }
  });

  it('copies a relative symlink in the template as relative, so it cannot point back into the fixture', async (ctx) => {
    const dir = suiteDir('symlink');
    mkdirSync(join(dir, 'fixture'));
    writeFileSync(join(dir, 'fixture', 'real.txt'), 'fixture bytes\n');
    try {
      symlinkSync('real.txt', join(dir, 'fixture', 'link.txt'), 'file');
    } catch (error) {
      // Windows needs the create-symlink privilege (or Developer Mode) for this; without it there
      // is nothing to copy, so the case is skipped there and only there.
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
      }
      throw error;
    }
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - { id: symlink, prompt: "x", must_contain: [gth-eval-], workspace: { template: fixture } }
`
    );
    let seen: { target: string; resolved: string; inside: string } | undefined;
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      inspectWorkspace: (workspace, outcome) => {
        const link = join(workspace.dir, 'link.txt');
        seen = {
          target: readlinkSync(link),
          resolved: realpathSync(link),
          inside: realpathSync(join(workspace.dir, 'real.txt')),
        };
        return outcome;
      },
    });
    await runEvalSuite(suite, { runCell });
    expect(seen?.target).toBe('real.txt');
    expect(seen!.resolved).toBe(seen!.inside);
  });
});

describe('command workspace — an interrupted run', () => {
  it('keeps a kept workspace out of the exit hook, so an interrupt keeps it too', async () => {
    const dir = suiteDir('kept-interrupted');
    const pidFile = join(scratch, 'kept-interrupted.pid');
    const suite = commandSuite(
      dir,
      fakeLine('hang', pidFile),
      `
cases:
  - { id: kept-hang, prompt: "x", must_contain: [x], workspace: {} }
`
    );
    const kept: string[] = [];
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      keepWorkspaces: true,
      onWorkspaceKept: (_caseId, keptDir) => kept.push(keptDir),
    });
    const run = runEvalSuite(suite, { runCell });
    try {
      for (let i = 0; i < 150 && !existsSync(pidFile); i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(kept).toHaveLength(1);
      killLiveCommandChildren();
      await run;
      expect(existsSync(kept[0])).toBe(true);
    } finally {
      for (const keptDir of kept) rmSync(keptDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("removes a live workspace from the 'exit' listener, after killing its command", async () => {
    const dir = suiteDir('interrupted');
    const pidFile = join(scratch, 'interrupted-ws.pid');
    const wsPathFile = join(scratch, 'interrupted-ws.path');
    const suite = commandSuite(
      dir,
      fakeLine('hang', pidFile),
      `
cases:
  - id: hangs
    prompt: "x"
    must_contain: [x]
    workspace: { setup: [${JSON.stringify(fakeLine('write', wsPathFile, '{{workspace}}'))}] }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const run = runEvalSuite(suite, { runCell });
    for (let i = 0; i < 150 && !existsSync(pidFile); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const workspace = readFileSync(wsPathFile, 'utf8');
    expect(existsSync(workspace)).toBe(true);
    killLiveCommandChildren();
    expect(existsSync(workspace)).toBe(false);
    expect((await run).cases[0].sutOk).toBe(false);
  }, 20_000);
});

describe('command workspace — a suite without one is unchanged', () => {
  it('spawns once, in the start directory, with gth’s own environment object', async () => {
    for (const rest of [
      'cases:\n  - { id: plain, prompt: "x", must_call: [Read] }',
      // `workspace: false` against a default is the same thing.
      'defaults: { workspace: { setup: ["never-run"] } }\n' +
        'cases:\n  - { id: plain, prompt: "x", must_call: [Read], workspace: false }',
    ]) {
      const suite = commandSuite(suiteDir('unchanged'), 'claude -p', rest);
      expect(Object.keys(suite.cases[0])).not.toContain('workspace');
      const requests: CommandSpawnRequest[] = [];
      const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
        spawnCommand: async (request) => {
          requests.push(request);
          return {
            stdout: readFileSync(CAPTURE, 'utf8'),
            stderr: '',
            exitCode: 0,
            timedOut: false,
          };
        },
      });
      await runEvalSuite(suite, { runCell });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toStrictEqual({
        argv: ['claude', '-p'],
        prompt: 'x',
        promptDelivery: 'arg',
        timeoutMs: 600_000,
        cwd: getCurrentWorkDir(),
        env: process.env,
      });
      expect(requests[0].env).toBe(process.env);
    }
  });
});

describe('workspace env helpers', () => {
  it('replaces every spelling of a variable on win32, and only the exact one elsewhere', () => {
    const base = { Path: 'inherited', OTHER: 'kept' };
    expect(mergeWorkspaceEnv(base, { PATH: 'suite' }, 'win32')).toStrictEqual({
      OTHER: 'kept',
      PATH: 'suite',
    });
    expect(mergeWorkspaceEnv(base, { PATH: 'suite' }, 'linux')).toStrictEqual({
      Path: 'inherited',
      OTHER: 'kept',
      PATH: 'suite',
    });
    expect(readEnvVar(base, 'PATH', 'win32')).toBe('inherited');
    expect(readEnvVar(base, 'PATH', 'linux')).toBeUndefined();
  });
});

describe('resolveSuiteDir', () => {
  it('resolves against the project directory, not the process cwd', () => {
    const project = join(scratch, 'project-root');
    const previous = peekProjectDir();
    setProjectDir(project);
    try {
      expect(resolveSuiteDir(join('eval', 'suite.yaml'))).toBe(resolve(project, 'eval'));
    } finally {
      setProjectDir(previous);
    }
  });
});
