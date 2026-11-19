import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { classifyEvalExit, runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import { decodeClaudeStreamJson } from '@gaunt-sloth/batch/transcripts/claudeStreamJson.js';
import type { CommandTarget, EvalSuite } from '@gaunt-sloth/batch';
import {
  buildCommandRunCell,
  runCommandProcess,
  type CommandSpawnRequest,
} from '#src/commands/commandEvalRunner.js';
import {
  buildWorkspaceEnv,
  mergeWorkspaceEnv,
  resolveWorkspaceCwd,
} from '#src/commands/commandWorkspace.js';

// BATCH-63 — a workspace's `cwd` and a `null` env value end to end: the REAL parser, the REAL
// runner spawning the fake CLI, and runEvalSuite. The fake CLI's `probe` mode records, from a
// setup step, the command and an after step alike, the directory it started in and whether a
// variable is SET, so "removed" and "set to empty" read differently. Paths are compared with
// `resolve()`/`join()`, never as POSIX literals.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_CLI = resolve(HERE, 'fixtures/commandTarget/fake-cli.mjs');

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gth-command-ws-b63-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fakeLine(...args: string[]): string {
  return [process.execPath, FAKE_CLI, ...args].map((arg) => `"${arg}"`).join(' ');
}

function suiteDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

interface Probe {
  label: string;
  cwd: string;
  set: boolean;
  value: string | null;
}

function readProbes(file: string): Record<string, Probe> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Probe)
      .map((probe) => [probe.label, probe])
  );
}

describe('command workspace — cwd', () => {
  it('starts only the command in cwd; setup, after steps, file checks and {{workspace}} stay at the root', async () => {
    const dir = suiteDir('cwd-ok');
    // The subdirectory exists in the template, so a setup step started in it would succeed and
    // the recorded cwd, not an ENOENT, is what tells the two apart.
    mkdirSync(join(dir, 'fixture', 'sub', 'dir'), { recursive: true });
    writeFileSync(join(dir, 'fixture', 'root-marker.txt'), 'at the root\n');
    const probes = join(scratch, 'cwd-ok.jsonl');
    const suite = commandSuite(
      dir,
      fakeLine('probe', probes, 'command', 'GTH_B63_WS'),
      `
defaults:
  workspace:
    template: fixture
    cwd: sub/dir
    env: { GTH_B63_WS: "{{workspace}}" }
    setup:
      - ${JSON.stringify(fakeLine('probe', probes, 'setup', 'GTH_B63_WS'))}
cases:
  - id: cwd-ok
    prompt: "x"
    must_contain: [probed]
    file_contains: { "root-marker.txt": "at the root" }
    after:
      - { run: ${JSON.stringify(fakeLine('probe', probes, 'after', 'GTH_B63_WS'))}, exit_code: 0 }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].reasons).toStrictEqual([]);
    expect(summary.cases[0].verdict).toBe('PASS');

    const seen = readProbes(probes);
    const root = seen.setup.cwd;
    expect(root).toMatch(/gth-eval-cwd-ok-/);
    expect(seen.after.cwd).toBe(root);
    expect(seen.command.cwd).toBe(join(root, 'sub', 'dir'));
    // `{{workspace}}` names the root for every one of them, the command included.
    expect(seen.setup.value).toBe(root);
    expect(seen.command.value).toBe(root);
    expect(seen.after.value).toBe(root);
  });

  it('is a harness error, with the command never started, when cwd does not exist after setup', async () => {
    const dir = suiteDir('cwd-missing');
    const probes = join(scratch, 'cwd-missing.jsonl');
    const suite = commandSuite(
      dir,
      fakeLine('probe', probes, 'command', 'PATH'),
      `
cases:
  - { id: cwd-missing, prompt: "x", must_contain: [probed], workspace: { cwd: not/made } }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /the workspace cwd "not\/made" \(looked for ".*"\) does not exist after setup; the case's command was not started/
    );
    expect(classifyEvalExit(summary)).toBe(2);
    expect(readProbes(probes).command).toBeUndefined();
  });

  it('is a harness error when cwd is a link that leads outside the workspace', async () => {
    const dir = suiteDir('cwd-escape');
    const outside = join(scratch, 'cwd-escape-outside');
    mkdirSync(outside, { recursive: true });
    const probes = join(scratch, 'cwd-escape.jsonl');
    // The link is made by a setup step, as a suite's own step would make a worktree: a junction on
    // Windows, a symlink elsewhere. Lexically `escape` is inside; only realpath shows otherwise.
    const suite = commandSuite(
      dir,
      fakeLine('probe', probes, 'command', 'PATH'),
      `
cases:
  - id: cwd-escape
    prompt: "x"
    must_contain: [probed]
    workspace:
      cwd: escape
      setup:
        - ${JSON.stringify(fakeLine('link', 'dir', outside, 'escape', 'unused-prompt'))}
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /the workspace cwd "escape" resolves to ".*", which is outside the workspace/
    );
    expect(classifyEvalExit(summary)).toBe(2);
    expect(readProbes(probes).command).toBeUndefined();
  });

  it('is a harness error when cwd names a file', async () => {
    const dir = suiteDir('cwd-file');
    mkdirSync(join(dir, 'fixture'), { recursive: true });
    writeFileSync(join(dir, 'fixture', 'a-file'), 'x');
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - { id: cwd-file, prompt: "x", must_contain: [x], workspace: { template: fixture, cwd: a-file } }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(/the workspace cwd "a-file" is not a directory/);
  });
});

describe('command workspace — env null', () => {
  it('removes a parent-process variable for setup, the command and after steps, and keeps "" set', async () => {
    const dir = suiteDir('env-null');
    const probes = join(scratch, 'env-null.jsonl');
    const suite = commandSuite(
      dir,
      fakeLine('probe', probes, 'command', 'GTH_B63_SECRET'),
      `
defaults:
  workspace:
    env: { GTH_B63_SECRET: null, GTH_B63_EMPTY: "" }
    setup:
      - ${JSON.stringify(fakeLine('probe', probes, 'setup', 'GTH_B63_SECRET'))}
cases:
  - id: env-null
    prompt: "x"
    must_contain: [probed]
    after:
      - { run: ${JSON.stringify(fakeLine('probe', probes, 'after', 'GTH_B63_SECRET'))}, exit_code: 0 }
      - { run: ${JSON.stringify(fakeLine('probe', probes, 'after-empty', 'GTH_B63_EMPTY'))}, exit_code: 0 }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      env: mergeWorkspaceEnv(process.env, {
        GTH_B63_SECRET: 'parent-secret',
        GTH_B63_EMPTY: 'parent-empty',
      }),
    });
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].verdict).toBe('PASS');
    const seen = readProbes(probes);
    for (const label of ['setup', 'command', 'after']) {
      expect(seen[label], label).toMatchObject({ set: false, value: null });
    }
    expect(seen['after-empty']).toMatchObject({ set: true, value: '' });
  });

  it("under inherit, a case's null removes a variable the default set, as well as the parent's", async () => {
    const dir = suiteDir('env-null-inherit');
    const probes = join(scratch, 'env-null-inherit.jsonl');
    const suite = commandSuite(
      dir,
      fakeLine('probe', probes, 'command', 'GTH_B63_SECRET'),
      `
defaults:
  workspace:
    env: { GTH_B63_SECRET: "from-default" }
cases:
  - { id: keeps, prompt: "x", must_contain: [probed] }
  - { id: drops, prompt: "x", must_contain: [probed], workspace: { inherit: true, env: { GTH_B63_SECRET: null } } }
`
    );
    // One case at a time, so the probe lines arrive in case order.
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      env: mergeWorkspaceEnv(process.env, { GTH_B63_SECRET: 'parent-secret' }),
    });
    const summary = await runEvalSuite(suite, { runCell, concurrency: 1 });
    expect(summary.cases.map((c) => c.verdict)).toStrictEqual(['PASS', 'PASS']);
    const lines = readFileSync(probes, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Probe);
    expect(lines.map(({ set, value }) => ({ set, value }))).toStrictEqual([
      { set: true, value: 'from-default' },
      { set: false, value: null },
    ]);
  });
});

describe('command workspace — cwd is spawned at its realpath', () => {
  it('starts the command at the directory a cwd link resolves to, the one that was checked', async () => {
    const dir = suiteDir('cwd-realpath');
    mkdirSync(join(dir, 'fixture', 'real'), { recursive: true });
    // process.cwd() in the child reports the physical directory either way, so the spawn request
    // is what is observed: the path handed to spawn must be the resolved one, not `<root>/alias`.
    const requests: CommandSpawnRequest[] = [];
    const suite = commandSuite(
      dir,
      fakeLine('cwd'),
      `
cases:
  - id: cwd-realpath
    prompt: "x"
    must_contain: [real]
    workspace:
      template: fixture
      cwd: alias
      setup:
        - ${JSON.stringify(fakeLine('link', 'dir', '{{workspace}}/real', 'alias', 'unused-prompt'))}
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      spawnCommand: (request) => {
        requests.push(request);
        return runCommandProcess(request);
      },
    });
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].reasons).toStrictEqual([]);
    const [setup, command] = requests;
    expect(setup.promptDelivery).toBe('none');
    expect(command.promptDelivery).not.toBe('none');
    // The workspace is gone by now, so nothing can be resolved here. The setup step's cwd is the
    // workspace's realpath and `real` is a real directory in it, so this join is canonical.
    expect(command.cwd).toBe(join(setup.cwd, 'real'));
  });
});

describe('resolveWorkspaceCwd — why a cwd could not be resolved', () => {
  function workspace(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    return realpathSync.native(dir);
  }

  it('says a part of the path is not a directory', () => {
    const ws = workspace('why-enotdir');
    writeFileSync(join(ws, 'f'), 'x');
    expect(() => resolveWorkspaceCwd(ws, 'f/x')).toThrow(
      /the workspace cwd "f\/x" \(looked for ".*"\) does not exist after setup: a part of the path is not a directory/
    );
  });

  it('names a link loop as a loop, not as a missing directory', (ctx) => {
    if (process.platform === 'win32') ctx.skip();
    const ws = workspace('why-eloop');
    symlinkSync('loop', join(ws, 'loop'));
    expect(() => resolveWorkspaceCwd(ws, 'loop')).toThrow(
      /the workspace cwd "loop" \(looked for ".*"\) could not be resolved: its symbolic links form a loop/
    );
  });

  it('names a permission error as one, not as a missing directory', (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) ctx.skip();
    const ws = workspace('why-eacces');
    mkdirSync(join(ws, 'locked', 'inner'), { recursive: true });
    chmodSync(join(ws, 'locked'), 0o000);
    try {
      expect(() => resolveWorkspaceCwd(ws, 'locked/inner')).toThrow(
        /the workspace cwd "locked\/inner" \(looked for ".*"\) could not be resolved: permission denied \(EACCES\)/
      );
    } finally {
      chmodSync(join(ws, 'locked'), 0o755);
    }
  });
});

describe('workspace env helpers — removal', () => {
  it('removes every spelling on win32 and only the exact name elsewhere, never leaving it empty', () => {
    const base = { GitHub_Token: 'inherited', OTHER: 'kept' };
    expect(mergeWorkspaceEnv(base, { GITHUB_TOKEN: null }, 'win32')).toStrictEqual({
      OTHER: 'kept',
    });
    expect(mergeWorkspaceEnv(base, { GITHUB_TOKEN: null }, 'linux')).toStrictEqual(base);
    expect(mergeWorkspaceEnv(base, { GitHub_Token: null }, 'linux')).toStrictEqual({
      OTHER: 'kept',
    });
  });

  it('applies a later null over an earlier spelling the block set itself, on win32', () => {
    const merged = buildWorkspaceEnv(
      { suiteDir: scratch, setup: [], env: { Path: 'from-default', PATH: null } },
      scratch,
      { PATH: 'inherited', OTHER: 'kept' },
      'win32'
    );
    expect(merged).toStrictEqual({ OTHER: 'kept' });
  });

  it('still lets {{env.NAME}} read a variable the block removes', () => {
    const merged = buildWorkspaceEnv(
      { suiteDir: scratch, setup: [], env: { SECRET: null, COPY: 'saw {{env.SECRET}}' } },
      scratch,
      { SECRET: 's' },
      'linux'
    );
    expect(merged).toStrictEqual({ COPY: 'saw s' });
  });
});
