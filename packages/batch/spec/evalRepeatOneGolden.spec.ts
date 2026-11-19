import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalSuite, JudgeFn, RunConversationFn } from '#src/evalTypes.js';
import type { CellRunOutcome, MatrixCell, RunCellFn } from '#src/types.js';

/**
 * BATCH-60 — **a suite that does not repeat its cases produces exactly the output it did before
 * repeats existed.** Every artefact a `repeat: 1` run writes or prints is compared, as a whole
 * serialized string, with a golden copy captured from the code BEFORE the repeat feature landed:
 * the parsed suite, `results.json`, every per-cell `<id>.json` and the text reporter's lines. The
 * JUnit and TeamCity reporter packages pin their own output against the `results.json` golden
 * written here (see their `repeatOneGolden` specs).
 *
 * The comparison is a string equality on purpose. A partial matcher would let a new key ride along
 * unnoticed, and an added key is precisely the regression this file exists to catch: every CI
 * dashboard and `jq` script reading these files would see it.
 *
 * Durations are frozen (`Date.now` is pinned), because a wall-clock number would make the golden
 * different on every run and the comparison meaningless.
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
// The text reporter frames failure reasons to the terminal width; pin it so a run in a wide
// terminal and a run in CI produce the same lines.
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stdout: { columns: 100 },
}));

const GOLDEN_DIR = join(import.meta.dirname, 'golden', 'repeat-one');

const FLAT_SUITE_YAML = `
target: { type: gth-agent }
defaults: { pass_threshold: 6 }
cases:
  - id: greets
    prompt: say hello
    must_contain: [hello]
  - id: misses
    prompt: say goodbye
    must_contain: [goodbye]
    tags: [farewell]
  - id: sut-down
    prompt: anything at all
    must_contain: [anything]
  - id: judged
    prompt: explain the file
    must_call: [read_file]
    judge: "explains the file clearly"
  - id: chat
    turns:
      - user: hi there
        must_contain: [hi]
      - user: and bye
        must_contain: [bye]
`;

const MATRIX_SUITE_YAML = `
target: { type: gth-agent }
identities: [admin, guest]
cases:
  - id: lists
    prompt: list the records
    expect:
      - identities: [admin]
        must_contain: [records]
      - identities: [guest]
        must_contain: [denied]
`;

/** The SUT's fixed answers, keyed by the cell id the runner dispatches. */
const OUTCOMES: Record<string, CellRunOutcome> = {
  greets: { ok: true, answer: 'hello world', tokensInput: 10, tokensOutput: 3 },
  misses: { ok: true, answer: 'see you', tokensInput: 11, tokensOutput: 2 },
  'sut-down': { ok: false, error: 'connection refused' },
  judged: {
    ok: true,
    answer: 'the file declares one function',
    tools: ['read_file'],
    toolResults: [{ name: 'read_file', isError: false, content: 'export function f() {}' }],
    toolCalls: [{ name: 'read_file' }],
  },
  lists__admin: { ok: true, answer: 'here are the records' },
  lists__guest: { ok: true, answer: 'here are the records' },
};

const runCell: RunCellFn = async (cell: MatrixCell) =>
  OUTCOMES[cell.id] ?? { ok: false, error: `no fixture for ${cell.id}` };

const runConversation: RunConversationFn = async (messages) =>
  messages.map((message) => ({ ok: true, answer: `echo: ${message}` }));

const judge: JudgeFn = async () => ({
  attempted: true,
  ok: true,
  verdict: { rate: 8, reason: 'clear enough' },
});

/** Run one suite end to end the way the command does: parse, run, write, report. Returns the
 * output directory and the reporter's console lines, as `<channel>\t<text>`. */
async function runPipeline(
  yaml: string,
  stem: string
): Promise<{ suite: EvalSuite; outputDir: string; lines: string[] }> {
  const { parseEvalSuite } = await import('#src/evalSuite.js');
  const { runEvalSuite } = await import('#src/evalRunner.js');
  const { writeEvalOutput } = await import('#src/evalOutput.js');
  const { createTextReporter } = await import('#src/reporters/textReporter.js');

  const suite = parseEvalSuite(yaml, `${stem}.yaml`);
  const summary = await runEvalSuite(suite, {
    runCell,
    runConversation,
    runCellByIdentity: new Map([
      ['admin', runCell],
      ['guest', runCell],
    ]),
    judge,
  });
  const outputDir = join(scratch, stem);
  writeEvalOutput(outputDir, summary);

  const ctx = { suitePath: `${stem}.yaml`, outputDir: `out/${stem}` };
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
  return { suite, outputDir, lines: lines.map((line) => line.split('\t').slice(1).join('\t')) };
}

let scratch: string;

describe('BATCH-60 — a suite that does not repeat keeps its exact output', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    scratch = mkdtempSync(join(tmpdir(), 'batch60-golden-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const [stem, yaml] of [
    ['flat', FLAT_SUITE_YAML],
    ['matrix', MATRIX_SUITE_YAML],
  ] as const) {
    it(`${stem}: the parsed suite, every output file and the text lines match the golden`, async () => {
      const { suite, outputDir, lines } = await runPipeline(yaml, stem);

      await expect(`${JSON.stringify(suite, null, 2)}\n`).toMatchFileSnapshot(
        join(GOLDEN_DIR, stem, 'parsed-suite.json')
      );
      const files = readdirSync(outputDir).sort();
      await expect(`${files.join('\n')}\n`).toMatchFileSnapshot(
        join(GOLDEN_DIR, stem, 'file-list.txt')
      );
      for (const file of files) {
        await expect(readFileSync(join(outputDir, file), 'utf-8')).toMatchFileSnapshot(
          join(GOLDEN_DIR, stem, 'output', file)
        );
      }
      await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
        join(GOLDEN_DIR, stem, 'text-reporter.txt')
      );
    });
  }
});
