import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import type { CommandTarget, EvalSuite, MatrixCell, TranscriptDecoder } from '@gaunt-sloth/batch';
import type { CommandRunResult, CommandSpawnRequest } from '#src/commands/commandEvalRunner.js';

// BATCH-66 — `--keep-transcripts` at the runner seam: which runs hand their output to
// `onTranscript`, and how `writeCommandTranscript` names and writes the files. The spawn seam is a
// fake keyed on the prompt, so every way a run can end is reachable without a real process.

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gth-batch66-transcripts-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LONG_STDERR = `${'e'.repeat(700)}-the-end`;

/** What the fake command prints for each prompt. `nostart` rejects, as an unknown command does. */
const RUNS: Record<string, CommandRunResult> = {
  pass: { stdout: 'pass-out', stderr: '', exitCode: 0, timedOut: false },
  noisy: { stdout: 'noisy-out', stderr: LONG_STDERR, exitCode: 0, timedOut: false },
  timeout: { stdout: 'partial-out', stderr: 'slow', exitCode: null, timedOut: true },
  nonzero: { stdout: 'half-out', stderr: 'boom', exitCode: 3, timedOut: false },
  garbage: { stdout: 'garbage', stderr: '', exitCode: 0, timedOut: false },
};

const decoder: TranscriptDecoder = (stdout) => {
  if (stdout === 'garbage') throw new Error('not a transcript');
  return { answer: stdout, toolCalls: [], toolResults: [] };
};

let agentPrompts: string[];
let stepArgv: string[][];
const fakeSpawn = async (request: CommandSpawnRequest): Promise<CommandRunResult> => {
  if (request.promptDelivery === 'none') {
    stepArgv.push(request.argv);
    return { stdout: 'step-out', stderr: 'step-err', exitCode: 0, timedOut: false };
  }
  agentPrompts.push(request.prompt);
  if (request.prompt === 'nostart') throw new Error('could not start "agent": ENOENT');
  return RUNS[request.prompt];
};

function commandSuite(casesYaml: string): EvalSuite {
  return parseEvalSuite(`
target:
  type: command
  run: agent -p
  transcript: claude-stream-json
cases:
${casesYaml}
`);
}

function targetOf(suite: EvalSuite): CommandTarget {
  if (suite.target.type !== 'command') throw new Error('not a command suite');
  return suite.target;
}

describe('command runner — onTranscript', () => {
  beforeEach(() => {
    agentPrompts = [];
    stepArgv = [];
  });

  async function transcriptsOf(
    suite: EvalSuite,
    concurrency = 1
  ): Promise<{ cell: MatrixCell; run: CommandRunResult }[]> {
    const { buildCommandRunCell } = await import('#src/commands/commandEvalRunner.js');
    const seen: { cell: MatrixCell; run: CommandRunResult }[] = [];
    const runCell = buildCommandRunCell(targetOf(suite), suite, decoder, {
      spawnCommand: fakeSpawn,
      onTranscript: (cell, run) => seen.push({ cell, run }),
    });
    await runEvalSuite(suite, { runCell, concurrency });
    return seen;
  }

  it('hands over a passing run and every finished harness-error run, but not one that never started', async () => {
    const suite = commandSuite(`
  - { id: passes, prompt: pass, must_contain: [out] }
  - { id: times-out, prompt: timeout, must_contain: [out] }
  - { id: exits-3, prompt: nonzero, must_contain: [out] }
  - { id: undecodable, prompt: garbage, must_contain: [out] }
  - { id: never-starts, prompt: nostart, must_contain: [out] }
`);
    const seen = await transcriptsOf(suite);
    expect(agentPrompts).toHaveLength(5);
    expect(Object.fromEntries(seen.map(({ cell, run }) => [cell.id, run.stdout]))).toEqual({
      passes: 'pass-out',
      'times-out': 'partial-out',
      'exits-3': 'half-out',
      undecodable: 'garbage',
    });
  });

  it('hands over each run of a repeated case, with its run number, even under concurrency', async () => {
    const suite = commandSuite(`
  - { id: again, prompt: pass, must_contain: [out], repeat: 3 }
`);
    const seen = await transcriptsOf(suite, 3);
    expect(seen.map(({ cell }) => `${cell.id}:${cell.run}`).sort()).toEqual([
      'again:1',
      'again:2',
      'again:3',
    ]);
  });

  it("never hands over a workspace setup or after step's output", async () => {
    const suite = commandSuite(`
  - id: in-workspace
    prompt: pass
    workspace: { setup: ["git init -q"] }
    after:
      - { run: "git status --porcelain", equals: "step-out" }
`);
    const seen = await transcriptsOf(suite);
    // Both steps ran through the same seam, so the absence below is not for want of a step.
    expect(stepArgv).toEqual([
      ['git', 'init', '-q'],
      ['git', 'status', '--porcelain'],
    ]);
    expect(seen.map(({ run }) => run.stdout)).toEqual(['pass-out']);
  });
});

describe('command runner — transcript files', () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(scratch, 'out-'));
  });

  it('names a single run <id> and each repeat <id>#run<n>', async () => {
    const { transcriptFileBase } = await import('#src/commands/commandEvalRunner.js');
    expect(transcriptFileBase({ id: 'fix-bug' })).toBe('fix-bug');
    expect(transcriptFileBase({ id: 'fix-bug', run: 2 })).toBe('fix-bug#run2');
  });

  it('cannot give a repeat of one case the name of another case', async () => {
    const { transcriptFileBase } = await import('#src/commands/commandEvalRunner.js');
    // `a-run-1` is a valid case id; a `-run-<n>` suffix would collide with it.
    const repeatOfA = transcriptFileBase({ id: 'a', run: 1 });
    expect(repeatOfA).not.toBe(transcriptFileBase({ id: 'a-run-1' }));
    expect(() => commandSuite(`  - { id: "${repeatOfA}", prompt: x }`)).toThrow(/case id/);
  });

  it('writes stdout raw and the whole of stderr, not the tail a reason quotes', async () => {
    const { writeCommandTranscript } = await import('#src/commands/commandEvalRunner.js');
    writeCommandTranscript(outDir, { id: 'noisy' }, RUNS.noisy);
    expect(readFileSync(join(outDir, 'noisy.stdout.txt'), 'utf8')).toBe('noisy-out');
    expect(readFileSync(join(outDir, 'noisy.stderr.txt'), 'utf8')).toBe(LONG_STDERR);
  });

  it('writes no stderr file when the command printed nothing to stderr', async () => {
    const { writeCommandTranscript } = await import('#src/commands/commandEvalRunner.js');
    writeCommandTranscript(outDir, { id: 'quiet', run: 2 }, RUNS.pass);
    expect(readdirSync(outDir)).toEqual(['quiet#run2.stdout.txt']);
  });

  it("removes a previous run's stderr file when this run printed nothing to stderr", async () => {
    const { writeCommandTranscript } = await import('#src/commands/commandEvalRunner.js');
    writeCommandTranscript(outDir, { id: 'reused', run: 1 }, RUNS.noisy);
    expect(readdirSync(outDir).sort()).toEqual([
      'reused#run1.stderr.txt',
      'reused#run1.stdout.txt',
    ]);
    writeCommandTranscript(outDir, { id: 'reused', run: 1 }, RUNS.pass);
    expect(readdirSync(outDir)).toEqual(['reused#run1.stdout.txt']);
    expect(readFileSync(join(outDir, 'reused#run1.stdout.txt'), 'utf8')).toBe('pass-out');
  });

  it('creates the output directory when it does not exist yet', async () => {
    const { writeCommandTranscript } = await import('#src/commands/commandEvalRunner.js');
    const nested = join(outDir, 'not', 'yet');
    writeCommandTranscript(nested, { id: 'early' }, RUNS.nonzero);
    expect(readdirSync(nested).sort()).toEqual(['early.stderr.txt', 'early.stdout.txt']);
  });
});
