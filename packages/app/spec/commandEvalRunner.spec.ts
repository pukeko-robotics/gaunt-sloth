import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { classifyEvalExit, runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import { decodeClaudeStreamJson } from '@gaunt-sloth/batch/transcripts/claudeStreamJson.js';
import type { CommandTarget, EvalSuite } from '@gaunt-sloth/batch';
import { spawn } from 'node:child_process';
import {
  buildCommandRunCell,
  killLiveCommandChildren,
  loadTranscriptDecoder,
  runCommandProcess,
} from '#src/commands/commandEvalRunner.js';

// BATCH-57 — the `command` target end to end: a REAL child process (a fake CLI that replays the
// committed, sanitised Claude Code transcript), the REAL decoder, the REAL parser and runEvalSuite.
// The real `claude` is never started here.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_CLI = resolve(HERE, 'fixtures/commandTarget/fake-cli.mjs');
const CAPTURE = resolve(HERE, '../../batch/spec/fixtures/claude-stream-json/capture.jsonl');

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gth-command-target-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A `run` line starting the fake CLI under this node, quoted so a path with spaces survives. */
function fakeRun(...args: string[]): string {
  return [process.execPath, FAKE_CLI, ...args].map((arg) => `"${arg}"`).join(' ');
}

/** A YAML suite for a command target. Values go through JSON.stringify, which YAML reads as a
 * double-quoted scalar, so Windows backslashes and quotes survive. */
function commandSuite(run: string, casesYaml: string, extraTarget = ''): EvalSuite {
  return parseEvalSuite(`
target:
  type: command
  run: ${JSON.stringify(run)}
  transcript: claude-stream-json
${extraTarget}
cases:
${casesYaml}
`);
}

/** The capture with the Bash result's payload replaced by JSON, so `tool_result_json_path` has a
 * payload it can pass on. Synthetic, and built here rather than committed, so the committed
 * fixture stays exactly what Claude Code printed. */
function captureWithJsonBashResult(): string {
  const lines = readFileSync(CAPTURE, 'utf8').trimEnd().split('\n');
  const edited = lines.map((line) => {
    const obj = JSON.parse(line);
    const block = obj.message?.content?.[0];
    if (obj.type === 'user' && block?.tool_use_id === 'toolu_018fHeu3bqBwj121qiQPRjci') {
      block.content = JSON.stringify({ files: ['present.txt'], count: 1 });
    }
    return JSON.stringify(obj);
  });
  const file = join(scratch, 'json-bash-result.jsonl');
  writeFileSync(file, edited.join('\n') + '\n');
  return file;
}

function targetOf(suite: EvalSuite): CommandTarget {
  if (suite.target.type !== 'command') throw new Error('not a command suite');
  return suite.target;
}

describe('command target — grading the replayed Claude Code transcript', () => {
  it('grades every tool assertion against the transcript, deterministically', async () => {
    const replayFile = captureWithJsonBashResult();
    const suite = commandSuite(
      fakeRun('replay', replayFile),
      `
  - id: reads-and-lists
    prompt: "Read present.txt and missing.txt, then list the directory."
    must_call: [Read, Bash]
    must_not_call: [Write, Edit]
    tool_call_json_path:
      - { tool: Read, path: file_path, equals: /workspace/present.txt }
      - { tool: Bash, path: command, equals: ls }
    tool_trajectory:
      calls: [Read, Read, Bash]
      strict: true
    must_error: [Read]
    tool_result_json_path:
      - { tool: Bash, path: "files[0]", equals: present.txt }
    must_contain: ["hello from the fixture"]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      recordToolCallArgs: true,
    });
    const summary = await runEvalSuite(suite, { runCell });
    const [result] = summary.cases;
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe('PASS');
    expect(result.sutOk).toBe(true);
    expect(result.tools).toEqual(['Read', 'Bash']);
    expect(result.toolCalls?.map((call) => call.name)).toEqual(['Read', 'Read', 'Bash']);
    expect(result.toolResults?.map((r) => [r.name, r.isError])).toEqual([
      ['Read', true],
      ['Read', false],
      ['Bash', false],
    ]);
    expect(classifyEvalExit(summary)).toBe(0);
  });

  it('fails each assertion the transcript contradicts, so the passes above can fail', async () => {
    const suite = commandSuite(
      fakeRun('replay', CAPTURE),
      `
  - id: contradicted
    prompt: "anything"
    must_call: [Write]
    must_not_call: [Bash]
    tool_call_json_path:
      - { tool: Read, path: file_path, equals: /workspace/other.txt, all_calls: true }
    tool_trajectory:
      calls: [Bash, Read]
    must_error: [Bash]
    tool_result_json_path:
      - { tool: Bash, path: "files[0]", equals: present.txt }
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      recordToolCallArgs: true,
    });
    const summary = await runEvalSuite(suite, { runCell });
    const [result] = summary.cases;
    expect(result.verdict).toBe('FAIL');
    expect(result.sutOk).toBe(true);
    // One reason per assertion, each naming what the transcript actually held.
    expect(result.reasons).toEqual([
      'did not call "Write"',
      'called forbidden tool "Bash" (matched "Bash")',
      'tool "Bash" did not return an error',
      'tool_result_json_path "files[0]" (tool "Bash"): result payload is not JSON',
      'tool_call_json_path "file_path" (tool "Read"): is "/workspace/missing.txt", expected ' +
        '"/workspace/other.txt"; is "/workspace/present.txt", expected "/workspace/other.txt"',
      'tool_trajectory: pattern 2 "Read" has no matching call after call 3 ("Bash"); expected ' +
        'in order ["Bash", "Read"], calls were ["Read", "Read", "Bash"]',
    ]);
    expect(classifyEvalExit(summary)).toBe(1);
  });

  it('drops arguments unless the run opted in, like the other targets', async () => {
    const suite = commandSuite(
      fakeRun('replay', CAPTURE),
      `
  - id: no-args
    prompt: "anything"
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].toolCalls?.every((call) => call.args === undefined)).toBe(true);
    expect(summary.cases[0].toolCalls?.[0].id).toBe('toolu_01EYU97VVHhPAj5syhGKt11e');
  });

  it('caps result payloads at the configured capture size and records the cut', async () => {
    const suite = commandSuite(
      fakeRun('replay', CAPTURE),
      `
  - id: capped
    prompt: "anything"
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson, {
      captureMaxBytes: 10,
    });
    const summary = await runEvalSuite(suite, { runCell });
    const errored = summary.cases[0].toolResults?.[0];
    expect(errored?.content).toBe('File does ');
    expect(errored?.contentTruncated).toBe(true);
  });
});

describe('command target — harness errors', () => {
  it('kills the process tree on timeout and grades the case as a harness error (exit 2)', async () => {
    const pidFile = join(scratch, 'grandchild.pid');
    const suite = commandSuite(
      fakeRun('hang', pidFile),
      `
  - id: hangs
    prompt: "anything"
    timeout_ms: 400
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const started = Date.now();
    const summary = await runEvalSuite(suite, { runCell });
    expect(Date.now() - started).toBeLessThan(15_000);
    const [result] = summary.cases;
    expect(result.sutOk).toBe(false);
    expect(result.reasons[0]).toMatch(/400ms timeout and its process tree was killed/);
    expect(classifyEvalExit(summary)).toBe(2);

    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    // The grandchild was killed with the tree; give the OS a moment to reap it.
    let alive = true;
    for (let i = 0; i < 50 && alive; i += 1) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 20_000);

  it("settles a timed-out case even when a surviving grandchild holds the pipes and 'close' never fires", async () => {
    // The EXT-15 shape: a descendant the tree kill cannot reach keeps stdout open, so waiting for
    // 'close' would hang the suite. On POSIX the grandchild leads its own process group, which the
    // negative-pid kill misses, so this exercises the settle-after-SIGKILL path: timeout + the 3 s
    // grace + the 1 s settle, about 4.3 s. On Windows `taskkill /T` reaches it and 'close' fires.
    const pidFile = join(scratch, 'pipe-holder.pid');
    const started = Date.now();
    let grandchild = 0;
    try {
      const result = await runCommandProcess({
        argv: [process.execPath, FAKE_CLI, 'hang-holding-pipes', pidFile],
        prompt: 'anything',
        promptDelivery: 'arg',
        timeoutMs: 300,
        cwd: scratch,
        env: process.env,
      });
      grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      grandchild ||= Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : 0);
      if (grandchild > 0) {
        try {
          process.kill(grandchild, 'SIGKILL');
        } catch {
          // Already gone (Windows, where the tree kill reached it).
        }
      }
    }
  }, 15_000);

  it('grades a non-zero exit as a harness error, quoting stderr', async () => {
    const suite = commandSuite(
      fakeRun('exit', '3', CAPTURE),
      `
  - id: exits
    prompt: "anything"
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(/exited with code 3/);
    expect(summary.cases[0].reasons[0]).toMatch(/failing on purpose/);
    expect(classifyEvalExit(summary)).toBe(2);
  });

  it('grades output that is not a transcript as a harness error', async () => {
    const suite = commandSuite(
      fakeRun('garbage'),
      `
  - id: garbage
    prompt: "anything"
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(
      /transcript "claude-stream-json" could not be decoded: .*no final "result" line/
    );
  });

  it('grades a command that cannot be started as a harness error', async () => {
    const suite = commandSuite(
      'gth-eval-no-such-command-57',
      `
  - id: missing
    prompt: "anything"
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].sutOk).toBe(false);
    expect(summary.cases[0].reasons[0]).toMatch(/could not start "gth-eval-no-such-command-57"/);
  });
});

/** Wait until `pid` is gone, up to ~5 s. Returns whether it went. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Best-effort cleanup so a red run does not leave processes behind. */
function reap(...pids: number[]): void {
  for (const pid of pids) {
    try {
      if (pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 150 && !existsSync(file); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('command target — an interrupted gth eval leaves no agent running', () => {
  it("kills every live command's tree from the 'exit' listener, and the run settles", async () => {
    const pidFile = join(scratch, 'exit-hook.pid');
    const run = runCommandProcess({
      argv: [process.execPath, FAKE_CLI, 'hang', pidFile],
      prompt: 'anything',
      promptDelivery: 'arg',
      timeoutMs: 120_000,
      cwd: scratch,
      env: process.env,
    });
    await waitForFile(pidFile);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const child = Number(readFileSync(`${pidFile}.self`, 'utf8'));
    try {
      expect(process.listeners('exit')).toContain(killLiveCommandChildren);
      killLiveCommandChildren();
      expect((await run).exitCode).not.toBe(0);
      expect(await gone(child)).toBe(true);
      expect(await gone(grandchild)).toBe(true);
    } finally {
      reap(child, grandchild);
    }
  }, 20_000);

  it('leaves no child running when the process running the eval is interrupted', async () => {
    // A real separate process through the BUILT runner, interrupted the way core's SIGINT handler
    // ends a run (see the driver). Needs the app build, like the other process-level specs.
    const runner = resolve(HERE, '../dist/commands/commandEvalRunner.js');
    const driver = resolve(HERE, 'fixtures/commandTarget/interrupt-driver.mjs');
    const pidFile = join(scratch, 'interrupted.pid');
    const proc = spawn(process.execPath, [driver, runner, FAKE_CLI, pidFile], {
      cwd: scratch,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((r) => proc.on('close', r));
    const grandchild = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
    const child = existsSync(`${pidFile}.self`)
      ? Number(readFileSync(`${pidFile}.self`, 'utf8'))
      : 0;
    try {
      expect(code, stderr).toBe(0);
      expect(child > 0 && grandchild > 0).toBe(true);
      expect(await gone(child)).toBe(true);
      expect(await gone(grandchild)).toBe(true);
    } finally {
      reap(child, grandchild);
    }
  }, 30_000);
});

describe('command target — the prompt is never interpreted', () => {
  // Built to do damage if it ever reached a shell: a command substitution that creates a file, a
  // backtick substitution, both quote kinds and a variable.
  const marker = (): string => join(scratch, 'INJECTED');
  const hostilePrompt = (): string =>
    `say "hi" and 'bye' $(touch ${marker()}) \`touch ${marker()}\` $HOME; echo done`;

  for (const delivery of ['arg', 'stdin'] as const) {
    it(`delivers a hostile prompt byte for byte by ${delivery}, executing nothing`, async () => {
      const received = join(scratch, `received-${delivery}.txt`);
      const result = await runCommandProcess({
        argv: [process.execPath, FAKE_CLI, 'record', received, CAPTURE],
        prompt: hostilePrompt(),
        promptDelivery: delivery,
        timeoutMs: 20_000,
        cwd: scratch,
        env: process.env,
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(received, 'utf8')).toBe(hostilePrompt());
      expect(existsSync(marker())).toBe(false);
    });
  }

  it('reaches the child through the full suite path too', async () => {
    const received = join(scratch, 'received-suite.txt');
    const suite = commandSuite(
      fakeRun('record', received, CAPTURE),
      `
  - id: hostile
    prompt: ${JSON.stringify(hostilePrompt())}
    must_call: [Read]
`
    );
    const runCell = buildCommandRunCell(targetOf(suite), suite, decodeClaudeStreamJson);
    const summary = await runEvalSuite(suite, { runCell });
    expect(summary.cases[0].verdict).toBe('PASS');
    expect(readFileSync(received, 'utf8')).toBe(hostilePrompt());
    expect(existsSync(marker())).toBe(false);
  });
});

describe('loadTranscriptDecoder', () => {
  it('resolves the built-in by name', async () => {
    expect(await loadTranscriptDecoder('claude-stream-json', 'suite.yaml')).toBe(
      decodeClaudeStreamJson
    );
  });

  it("loads a custom decoder module's default export, relative to the suite file", async () => {
    const dir = join(scratch, 'suites');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'my-decoder.mjs'),
      'export default (stdout) => ({ answer: stdout.trim(), toolCalls: [], toolResults: [] });\n'
    );
    const decoder = await loadTranscriptDecoder('./my-decoder.mjs', join(dir, 'suite.yaml'));
    expect(decoder('  plain answer \n')).toEqual({
      answer: 'plain answer',
      toolCalls: [],
      toolResults: [],
    });
  });

  it('refuses a module without a default function', async () => {
    const file = join(scratch, 'not-a-decoder.mjs');
    writeFileSync(file, 'export const decode = 1;\n');
    await expect(loadTranscriptDecoder(file, join(scratch, 'suite.yaml'))).rejects.toThrow(
      /must export a default function/
    );
  });
});
