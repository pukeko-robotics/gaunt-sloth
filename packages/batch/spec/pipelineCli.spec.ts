import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellResult, MatrixCell, RunCellFn } from '#src/types.js';

describe('parseArgs', () => {
  beforeEach(() => vi.resetAllMocks());

  it('parses the script positional alone', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(parseArgs(['summarize.md'])).toEqual({ script: 'summarize.md' });
  });

  it('parses --over, --models, -j and --retry (space-separated form)', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(
      parseArgs(['s.md', '--over', '[{"a":1}]', '--models', 'a, b ,c', '-j', '3', '--retry', '2'])
    ).toEqual({
      script: 's.md',
      over: '[{"a":1}]',
      models: ['a', 'b', 'c'],
      concurrency: 3,
      retry: 2,
    });
  });

  it('accepts the --flag=value form and --concurrency long name', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(parseArgs(['s.md', '--models=x,y', '--concurrency=8', '--over={"k":"v"}'])).toEqual({
      script: 's.md',
      over: '{"k":"v"}',
      models: ['x', 'y'],
      concurrency: 8,
    });
  });

  it('drops empty entries in --models and yields undefined for an all-empty list', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(parseArgs(['s.md', '--models', 'a,,b']).models).toEqual(['a', 'b']);
    expect(parseArgs(['s.md', '--models', ' , ']).models).toBeUndefined();
  });

  it('throws on a missing <script>', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(() => parseArgs(['--models', 'a'])).toThrow(/Missing required <script>/);
  });

  it('throws on an unknown option', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(() => parseArgs(['s.md', '--nope'])).toThrow(/Unknown option: --nope/);
  });

  it('throws on a missing value for a flag', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(() => parseArgs(['s.md', '--over'])).toThrow(/Missing value for --over/);
  });

  it('throws on a non-integer concurrency', async () => {
    const { parseArgs } = await import('#src/pipelineCli.js');
    expect(() => parseArgs(['s.md', '-j', 'lots'])).toThrow(/expects an integer/);
  });
});

describe('parseOverData', () => {
  beforeEach(() => vi.resetAllMocks());

  it('parses a JSON array of objects into string-valued rows', async () => {
    const { parseOverData } = await import('#src/pipelineCli.js');
    expect(parseOverData('[{"name":"Alice"},{"name":"Bob"}]')).toEqual([
      { name: 'Alice' },
      { name: 'Bob' },
    ]);
  });

  it('parses YAML (JSON is a subset) and stringifies non-string values', async () => {
    const { parseOverData } = await import('#src/pipelineCli.js');
    expect(parseOverData('- name: Carol\n  n: 3\n  ok: true\n')).toEqual([
      { name: 'Carol', n: '3', ok: 'true' },
    ]);
  });

  it('throws when the data is not an array', async () => {
    const { parseOverData } = await import('#src/pipelineCli.js');
    expect(() => parseOverData('{"name":"x"}')).toThrow(/must be a JSON\/YAML array/);
  });

  it('throws on an empty array and on a non-object row', async () => {
    const { parseOverData } = await import('#src/pipelineCli.js');
    expect(() => parseOverData('[]')).toThrow(/empty array/);
    expect(() => parseOverData('[1, 2]')).toThrow(/row 0 must be an object/);
  });

  it('throws a descriptive error on malformed input', async () => {
    const { parseOverData } = await import('#src/pipelineCli.js');
    expect(() => parseOverData('[{a: }')).toThrow(/not valid JSON\/YAML/);
  });
});

describe('resolveRows', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses inline --over and does not read stdin', async () => {
    const { resolveRows } = await import('#src/pipelineCli.js');
    const readStdin = vi.fn();
    const rows = await resolveRows({ script: 's.md', over: '[{"a":"1"}]' }, readStdin);
    expect(rows).toEqual([{ a: '1' }]);
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('falls back to stdin when --over is absent', async () => {
    const { resolveRows } = await import('#src/pipelineCli.js');
    const readStdin = vi.fn().mockResolvedValue('[{"a":"2"}]');
    const rows = await resolveRows({ script: 's.md' }, readStdin);
    expect(rows).toEqual([{ a: '2' }]);
  });

  it('returns undefined (no input axis) when neither --over nor stdin has data', async () => {
    const { resolveRows } = await import('#src/pipelineCli.js');
    const rows = await resolveRows({ script: 's.md' }, vi.fn().mockResolvedValue('   \n'));
    expect(rows).toBeUndefined();
  });
});

describe('runMatrixToStream', () => {
  beforeEach(() => vi.resetAllMocks());

  it('emits one JSON CellResult line per cell, matching the gth batch output shape', async () => {
    const { runMatrixToStream } = await import('#src/pipelineCli.js');
    const lines: string[] = [];
    // Fake runCell — no live LLM; echoes the cell content back as the answer plus canned stats.
    const runCell: RunCellFn = async (cell: MatrixCell) => ({
      ok: true,
      answer: `ANSWER:${cell.content}`,
      tokensInput: 5,
      tokensOutput: 7,
      tools: ['read_file'],
    });

    const summary = await runMatrixToStream('Greet {{name}}.', undefined, [{ name: 'Alice' }], {
      runCell,
      write: (chunk) => lines.push(chunk),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    const cell: CellResult = JSON.parse(lines[0]);
    // Same structured per-cell record gth batch writes to <id>.json.
    expect(cell).toMatchObject({
      ok: true,
      answer: 'ANSWER:Greet Alice.',
      tokensInput: 5,
      tokensOutput: 7,
      tools: ['read_file'],
      id: 'cell-0-0',
      inputIndex: 0,
      inputRow: { name: 'Alice' },
      retries: 0,
    });
    expect(typeof cell.durationMs).toBe('number');
    expect(summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      cells: [{ id: 'cell-0-0', model: undefined, inputIndex: 0, ok: true, retries: 0 }],
    });
  });

  it('builds the model x input cross-product and preserves matrix order', async () => {
    const { runMatrixToStream } = await import('#src/pipelineCli.js');
    const lines: string[] = [];
    const runCell: RunCellFn = async () => ({ ok: true });

    await runMatrixToStream('Do {{x}}', ['m1', 'm2'], [{ x: 'a' }, { x: 'b' }], {
      runCell,
      write: (chunk) => lines.push(chunk),
    });

    const ids = lines.map((l) => (JSON.parse(l) as CellResult).id);
    expect(ids).toEqual(['cell-0-0', 'cell-0-1', 'cell-1-0', 'cell-1-1']);
    const models = lines.map((l) => (JSON.parse(l) as CellResult).model);
    expect(models).toEqual(['m1', 'm1', 'm2', 'm2']);
  });

  it('records a failed cell as ok:false without throwing (exit-code contract is the caller’s)', async () => {
    const { runMatrixToStream } = await import('#src/pipelineCli.js');
    const lines: string[] = [];
    const runCell: RunCellFn = async () => ({ ok: false, error: 'model unavailable' });

    const summary = await runMatrixToStream('x', undefined, undefined, {
      runCell,
      write: (chunk) => lines.push(chunk),
    });

    const cell: CellResult = JSON.parse(lines[0]);
    expect(cell).toMatchObject({ ok: false, error: 'model unavailable', id: 'cell-0-0' });
    expect(summary.failed).toBe(1);
  });
});

describe('runBatchCli', () => {
  beforeEach(() => vi.resetAllMocks());

  it('wires script + inline --over through an injected runCell and streams JSONL, returning 0', async () => {
    const { runBatchCli } = await import('#src/pipelineCli.js');
    const out: string[] = [];
    const err: string[] = [];
    const runCell: RunCellFn = async (cell) => ({ ok: true, answer: cell.content });

    const code = await runBatchCli(['script.md', '--over', '[{"name":"Alice"},{"name":"Bob"}]'], {
      readScript: (p) => {
        expect(p).toBe('script.md');
        return 'Greet {{name}}.';
      },
      runCell,
      write: (c) => out.push(c),
      logError: (c) => err.push(c),
    });

    expect(code).toBe(0);
    expect(out).toHaveLength(2);
    expect((JSON.parse(out[0]) as CellResult).inputRow).toEqual({ name: 'Alice' });
    expect((JSON.parse(out[1]) as CellResult).answer).toBe('Greet Bob.');
    // Human summary goes to the error/stderr sink, never mixed into the JSONL data channel.
    expect(err.join('')).toContain('gth-batch: 2/2 cell(s) ok');
  });

  it('reads over-data from stdin when --over is absent', async () => {
    const { runBatchCli } = await import('#src/pipelineCli.js');
    const out: string[] = [];
    const runCell: RunCellFn = async () => ({ ok: true });

    const code = await runBatchCli(['script.md'], {
      readScript: () => 'Do {{x}}',
      readStdin: async () => '[{"x":"1"},{"x":"2"}]',
      runCell,
      write: (c) => out.push(c),
      logError: () => {},
    });

    expect(code).toBe(0);
    expect(out).toHaveLength(2);
  });

  it('returns 0 even when a cell fails (exit-code contract) and 1 on an invocation error', async () => {
    const { runBatchCli } = await import('#src/pipelineCli.js');
    const out: string[] = [];
    const err: string[] = [];

    const okCode = await runBatchCli(['script.md'], {
      readScript: () => 'x',
      readStdin: async () => '',
      runCell: async () => ({ ok: false, error: 'boom' }),
      write: (c) => out.push(c),
      logError: (c) => err.push(c),
    });
    expect(okCode).toBe(0);
    expect((JSON.parse(out[0]) as CellResult).ok).toBe(false);

    // Missing <script> is a harness-level error → exit 1, message on the error sink, no JSONL.
    out.length = 0;
    err.length = 0;
    const badCode = await runBatchCli([], {
      write: (c) => out.push(c),
      logError: (c) => err.push(c),
    });
    expect(badCode).toBe(1);
    expect(out).toHaveLength(0);
    expect(err.join('')).toMatch(/Missing required <script>/);
  });

  it('builds the real runCell from initConfig only when none is injected', async () => {
    const { runBatchCli } = await import('#src/pipelineCli.js');
    const initConfig = vi.fn().mockRejectedValue(new Error('no config here'));

    const code = await runBatchCli(['script.md'], {
      readScript: () => 'x',
      readStdin: async () => '',
      initConfig,
      write: () => {},
      logError: () => {},
    });

    // No injected runCell → it must consult initConfig; our stub rejects → invocation error → 1.
    expect(initConfig).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
  });

  it('treats an EPIPE on the stdout write channel as a clean stop (exit 0), not a harness error', async () => {
    const { runBatchCli } = await import('#src/pipelineCli.js');
    const err: string[] = [];
    let writes = 0;
    // Simulate a downstream reader (e.g. `| head -1`) closing the pipe: the write channel throws
    // an EPIPE-coded error.
    const write = (): void => {
      writes++;
      const epipe = new Error('EPIPE: broken pipe, write') as NodeJS.ErrnoException;
      epipe.code = 'EPIPE';
      throw epipe;
    };

    const code = await runBatchCli(['script.md'], {
      readScript: () => 'x',
      readStdin: async () => '[{"n":"1"},{"n":"2"},{"n":"3"}]',
      runCell: async () => ({ ok: true }),
      write,
      logError: (c) => err.push(c),
    });

    expect(code).toBe(0);
    expect(writes).toBe(1); // stopped emitting further cells after the pipe closed
    expect(err.join('')).not.toMatch(/EPIPE/); // never surfaced as an error
  });

  it('still returns non-zero for a genuine (non-EPIPE) write failure', async () => {
    const { runBatchCli } = await import('#src/pipelineCli.js');
    const err: string[] = [];
    const write = (): void => {
      throw new Error('disk full');
    };

    const code = await runBatchCli(['script.md'], {
      readScript: () => 'x',
      readStdin: async () => '[{"n":"1"}]',
      runCell: async () => ({ ok: true }),
      write,
      logError: (c) => err.push(c),
    });

    expect(code).toBe(1);
    expect(err.join('')).toMatch(/disk full/);
  });
});
