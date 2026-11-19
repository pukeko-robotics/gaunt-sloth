import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandTarget, EvalSuite } from '@gaunt-sloth/batch';
import type { CommandRunResult, CommandSpawnRequest } from '#src/commands/commandEvalRunner.js';

/**
 * BATCH-62 — **a `command` suite that does not declare `grade_when` produces exactly the output it
 * did before the key existed.** Every artefact the run writes or prints is compared, as a whole
 * serialized string, with a golden copy captured from the code BEFORE `grade_when` landed: the
 * parsed suite, `results.json`, every per-case `<id>.json` and the text reporter's lines.
 *
 * The cases are the ones the key touches: a finished run, a run capped by `--max-turns` (exit 1
 * and exit 0), a finished transcript with a non-zero exit, output that is not a transcript, a run
 * killed by a signal, and a repeated case. Without the key, every non-finished one is a harness
 * error with exactly the reason it had before.
 *
 * The comparison is a string equality on purpose: a partial matcher would let a new key, such as
 * an `outcome` on a harness error, ride along unnoticed.
 *
 * The command is a fake behind the spawn seam rather than a real process, so the parsed suite
 * carries no machine-specific path and the golden is the same on every platform.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);
// The text reporter frames failure reasons to the terminal width; pin it.
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stdout: { columns: 100 },
}));

const GOLDEN_DIR = join(import.meta.dirname, 'golden', 'command-default');
const CAPTURE = readFileSync(
  fileURLToPath(
    new URL('../../batch/spec/fixtures/claude-stream-json/capture.jsonl', import.meta.url)
  ),
  'utf8'
);

/** The capture cut after its two tool rounds and ended the way `--max-turns` ends it. Synthetic,
 * built here so the committed capture stays exactly what Claude Code printed. */
function cappedTranscript(): string {
  const lines = CAPTURE.trimEnd().split('\n').slice(0, 7);
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 3,
      usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 },
    })
  );
  return `${lines.join('\n')}\n`;
}

const SUITE_YAML = `
target:
  type: command
  run: fake-agent -p --output-format stream-json --verbose --max-turns 3
  transcript: claude-stream-json
cases:
  - id: finished
    prompt: finished
    must_call: [Read, Bash]
  - id: capped-exit-1
    prompt: capped-exit-1
    must_call: [Read]
  - id: capped-exit-0
    prompt: capped-exit-0
    must_call: [Read]
  - id: finished-exit-1
    prompt: finished-exit-1
    must_call: [Read]
  - id: garbage
    prompt: garbage
    must_call: [Read]
  - id: killed
    prompt: killed
    must_call: [Read]
  - id: repeated
    prompt: finished
    repeat: 2
    must_call: [Bash]
`;

/** What the fake command prints for each prompt. */
function fakeRun(prompt: string): CommandRunResult {
  switch (prompt) {
    case 'finished':
      return { stdout: CAPTURE, stderr: '', exitCode: 0, timedOut: false };
    case 'capped-exit-1':
      return {
        stdout: cappedTranscript(),
        stderr: 'fake: stopped at the turn limit',
        exitCode: 1,
        timedOut: false,
      };
    case 'capped-exit-0':
      return { stdout: cappedTranscript(), stderr: '', exitCode: 0, timedOut: false };
    case 'finished-exit-1':
      return { stdout: CAPTURE, stderr: 'fake: failing on purpose', exitCode: 1, timedOut: false };
    case 'garbage':
      return { stdout: 'not a transcript\n', stderr: '', exitCode: 0, timedOut: false };
    case 'killed':
      return { stdout: cappedTranscript(), stderr: '', exitCode: null, timedOut: false };
    default:
      throw new Error(`no fake for ${prompt}`);
  }
}

let scratch: string;

describe('BATCH-62 — a command suite without grade_when keeps its exact output', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    scratch = mkdtempSync(join(tmpdir(), 'batch62-golden-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('the parsed suite, every output file and the text lines match the golden', async () => {
    const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
    const { runEvalSuite } = await import('@gaunt-sloth/batch/evalRunner.js');
    const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
    const { createTextReporter } = await import('@gaunt-sloth/batch/reporters/textReporter.js');
    const { decodeClaudeStreamJson } = await import(
      '@gaunt-sloth/batch/transcripts/claudeStreamJson.js'
    );
    const { buildCommandRunCell } = await import('#src/commands/commandEvalRunner.js');

    const suite: EvalSuite = parseEvalSuite(SUITE_YAML, 'command-default.yaml');
    const runCell = buildCommandRunCell(
      suite.target as CommandTarget,
      suite,
      decodeClaudeStreamJson,
      {
        cwd: scratch,
        spawnCommand: async (request: CommandSpawnRequest) => fakeRun(request.prompt),
      }
    );
    const summary = await runEvalSuite(suite, { runCell });
    const outputDir = join(scratch, 'out');
    writeEvalOutput(outputDir, summary);

    const ctx = { suitePath: 'command-default.yaml', outputDir: 'out/command-default' };
    const reporter = createTextReporter();
    await reporter.onSuiteStart?.(ctx);
    for (const result of summary.cases) await reporter.onCellResult?.(result, ctx);
    await reporter.onSuiteEnd?.(summary, ctx);

    const lines: string[] = [];
    for (const [channel, mock] of Object.entries(consoleUtilsMock)) {
      mock.mock.calls.forEach((call, index) => {
        lines.push(`${mock.mock.invocationCallOrder[index]}\t${channel}\t${String(call[0])}`);
      });
    }
    lines.sort((a, b) => Number(a.split('\t')[0]) - Number(b.split('\t')[0]));
    const text = lines.map((line) => line.split('\t').slice(1).join('\t'));

    await expect(`${JSON.stringify(suite, null, 2)}\n`).toMatchFileSnapshot(
      join(GOLDEN_DIR, 'parsed-suite.json')
    );
    const files = readdirSync(outputDir).sort();
    await expect(`${files.join('\n')}\n`).toMatchFileSnapshot(join(GOLDEN_DIR, 'file-list.txt'));
    for (const file of files) {
      await expect(readFileSync(join(outputDir, file), 'utf-8')).toMatchFileSnapshot(
        join(GOLDEN_DIR, 'output', file)
      );
    }
    await expect(`${text.join('\n')}\n`).toMatchFileSnapshot(
      join(GOLDEN_DIR, 'text-reporter.txt')
    );
  });
});
