import { Command } from 'commander';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunResult, CommandSpawnRequest } from '#src/commands/commandEvalRunner.js';
import type { MatrixCell } from '@gaunt-sloth/batch';

// BATCH-66 — `gth eval --only` and `--keep-transcripts`, driven through the command. The gth-agent
// runners are stubs that record every dispatch; the `command` target uses the REAL runner with only
// its spawn seam replaced, so the transcript files below are written by production code.

const batchCommandMock = {
  buildProductionRunCell: vi.fn(),
  buildProductionRunConversation: vi.fn(),
};
vi.mock('#src/commands/batchCommand.js', () => batchCommandMock);

const spawnMock = vi.fn();
vi.mock('#src/commands/commandEvalRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/commands/commandEvalRunner.js')>();
  return {
    ...actual,
    // The suite names `claude-stream-json`; the fake prints plain text, so a plain decoder stands
    // in for it. Everything else in the runner is the real one.
    loadTranscriptDecoder: async () => (stdout: string) => {
      if (stdout === 'garbage') throw new Error('not a transcript');
      return { answer: stdout, toolCalls: [], toolResults: [] };
    },
    buildCommandRunCell: (
      ...[target, suite, decoder, options]: Parameters<typeof actual.buildCommandRunCell>
    ) =>
      actual.buildCommandRunCell(target, suite, decoder, { ...options, spawnCommand: spawnMock }),
  };
});

const fileUtilsMock = {
  readFileFromProjectDir: vi.fn(),
  getGslothFilePath: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  importExternalFile: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => fileUtilsMock);

const consoleUtilsMock = {
  display: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  setExitCode: vi.fn(),
  getProjectDir: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  // The command runner hands this to the (fake) child as its environment; never read here.
  env: {},
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

// The gth-agent preamble reads prompt files from the project; the runners above are stubs, so the
// preamble is never used.
const introspectionMock = { getAskSystemPrompt: vi.fn() };
vi.mock('#src/commands/commandIntrospection.js', () => introspectionMock);

const configMock = {
  initConfig: vi.fn(),
  resolveIdentityProfileConfigPath: vi.fn(),
  loadRunLevelEvalConfig: vi.fn(),
};
vi.mock('@gaunt-sloth/core/config.js', () => configMock);

const AGENT_SUITE = `
target: { type: gth-agent }
cases:
  - { id: fix-null, prompt: p1, must_contain: [hello] }
  - { id: fix-loop, prompt: p2, must_contain: [hello] }
  - { id: rename-symbol, prompt: p3, must_contain: [hello] }
  - { id: other, prompt: p4, must_contain: [hello] }
`;

const MATRIX_SUITE = `
target: { type: gth-agent }
identities: [admin, guest]
cases:
  - id: picked
    prompt: p
    repeat: 2
    expect:
      - { identities: [admin], must_contain: [hello] }
      - { identities: [guest], must_contain: [hello] }
  - id: unpicked
    prompt: q
    expect:
      - { identities: [admin], must_contain: [hello] }
      - { identities: [guest], must_contain: [hello] }
`;

const SWEEP_SUITE = `
target: { type: gth-agent }
sweep:
  axes:
    - { name: m, values: [{ name: one, model: m1 }, { name: two, model: m2 }] }
cases:
  - { id: picked, prompt: p, must_contain: [hello] }
  - { id: unpicked, prompt: q, must_contain: [hello] }
`;

const COMMAND_SUITE = `
target:
  type: command
  run: agent -p
  transcript: claude-stream-json
cases:
  - { id: passes, prompt: pass, must_contain: [out] }
  - { id: times-out, prompt: timeout, must_contain: [out] }
  - { id: flaky, prompt: noisy, must_contain: [out], repeat: 2 }
`;

const FILES: Record<string, string> = {
  'agent.yaml': AGENT_SUITE,
  'matrix.yaml': MATRIX_SUITE,
  'sweep.yaml': SWEEP_SUITE,
  'command.yaml': COMMAND_SUITE,
};

const RUNS: Record<string, CommandRunResult> = {
  pass: { stdout: 'pass-out', stderr: '', exitCode: 0, timedOut: false },
  timeout: { stdout: 'partial-out', stderr: 'too slow', exitCode: null, timedOut: true },
  noisy: { stdout: 'noisy-out', stderr: 'warn', exitCode: 0, timedOut: false },
};

describe('gth eval --only and --keep-transcripts', () => {
  let projectRoot: string;
  let outputDir: string;
  let dispatched: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    projectRoot = mkdtempSync(join(tmpdir(), 'gth-batch66-project-'));
    outputDir = join(mkdtempSync(join(tmpdir(), 'gth-batch66-out-')), 'run');
    dispatched = [];
    systemUtilsMock.getProjectDir.mockReturnValue(projectRoot);
    systemUtilsMock.getCurrentWorkDir.mockReturnValue(projectRoot);
    configMock.initConfig.mockResolvedValue({ llm: { invoke: vi.fn(), model: 'm' } });
    configMock.resolveIdentityProfileConfigPath.mockReturnValue('/profile/config.json');
    configMock.loadRunLevelEvalConfig.mockResolvedValue({ found: true, layer: 'project' });
    fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
      const yaml = FILES[file];
      if (yaml === undefined) throw new Error(`unexpected file read: ${file}`);
      return yaml;
    });
    batchCommandMock.buildProductionRunCell.mockImplementation(
      async (_config: unknown, _preamble: unknown, _overrides: unknown) =>
        async (cell: MatrixCell) => {
          dispatched.push(`${cell.id}${cell.run !== undefined ? `#${cell.run}` : ''}`);
          return { ok: true, answer: 'hello' };
        }
    );
    batchCommandMock.buildProductionRunConversation.mockResolvedValue(async () => []);
    spawnMock.mockImplementation(async (request: CommandSpawnRequest) => RUNS[request.prompt]);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(join(outputDir, '..'), { recursive: true, force: true });
  });

  async function runEval(...args: string[]): Promise<void> {
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', ...args]);
  }

  const results = (dir = outputDir): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const allText = (mock: ReturnType<typeof vi.fn>): string =>
    mock.mock.calls.map((call) => String(call[0])).join('\n');

  describe('--only', () => {
    it('runs the exact and glob matches of repeated patterns, and records the filter', async () => {
      await runEval('agent.yaml', '-o', outputDir, '--only', 'fix-*', '--only', 'rename-symbol');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(dispatched.sort()).toEqual(['fix-loop', 'fix-null', 'rename-symbol']);
      const written = results();
      expect((written.cases as { id: string }[]).map((c) => c.id).sort()).toEqual([
        'fix-loop',
        'fix-null',
        'rename-symbol',
      ]);
      expect(written.only).toEqual({
        patterns: ['fix-*', 'rename-symbol'],
        selectedCases: 3,
        suiteCases: 4,
      });
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        'eval: --only runs 3 of 4 case(s) in agent.yaml: fix-null, fix-loop, rename-symbol'
      );
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('a glob is anchored at both ends', async () => {
      await runEval('agent.yaml', '-o', outputDir, '--only', 'fix');
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(dispatched).toEqual([]);
    });

    it('runs every identity and every repeat of a matched case, and none of an unmatched one', async () => {
      await runEval('matrix.yaml', '-o', outputDir, '--only', 'picked');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(dispatched.sort()).toEqual([
        'picked__admin#1',
        'picked__admin#2',
        'picked__guest#1',
        'picked__guest#2',
      ]);
    });

    it('runs a matched case in every sweep cell, and records the filter in each', async () => {
      await runEval('sweep.yaml', '-o', outputDir, '--only', 'picked');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(dispatched).toEqual(['picked', 'picked']);
      for (const cell of ['m-one', 'm-two']) {
        expect(results(join(outputDir, cell)).only).toEqual({
          patterns: ['picked'],
          selectedCases: 1,
          suiteCases: 2,
        });
      }
    });

    it('exits 2 before any agent is built when no case in any suite matches', async () => {
      await runEval('agent.yaml', 'matrix.yaml', '-o', outputDir, '--only', 'nope-*');
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'eval harness error: --only "nope-*" matched no case in 2 suite(s). Nothing was run.'
      );
      expect(batchCommandMock.buildProductionRunCell).not.toHaveBeenCalled();
      expect(configMock.initConfig).not.toHaveBeenCalled();
      expect(dispatched).toEqual([]);
      expect(existsSync(outputDir)).toBe(false);
    });

    it('skips a suite with no matching case, says so, and runs the others', async () => {
      await runEval('agent.yaml', 'matrix.yaml', '-o', outputDir, '--only', 'unpicked');
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        'eval: --only matched no case in agent.yaml; skipped it.'
      );
      expect(dispatched.sort()).toEqual(['unpicked__admin', 'unpicked__guest']);
      expect(existsSync(join(outputDir, 'agent'))).toBe(false);
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('is refused with --export-blind, before anything is read', async () => {
      await runEval('agent.yaml', '--only', 'fix-*', '--export-blind', join(projectRoot, 'b.json'));
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(allText(consoleUtilsMock.displayError)).toContain(
        '--only cannot be combined with --export-blind or --relabel-diff'
      );
      expect(fileUtilsMock.readFileFromProjectDir).not.toHaveBeenCalled();
    });

    describe('with --compare-to', () => {
      let baselineRoot: string;
      beforeEach(() => {
        baselineRoot = mkdtempSync(join(tmpdir(), 'gth-batch66-baseline-'));
      });
      afterEach(() => {
        rmSync(baselineRoot, { recursive: true, force: true });
      });

      function writeBaseline(extra: Record<string, unknown> = {}): void {
        const cases = ['fix-null', 'fix-loop', 'rename-symbol', 'other'].map((id) => ({
          id,
          passThreshold: 6,
          durationMs: 1,
          verdict: 'PASS',
          sutOk: true,
          reasons: [],
        }));
        mkdirSync(baselineRoot, { recursive: true });
        writeFileSync(
          join(baselineRoot, 'results.json'),
          JSON.stringify({ total: 4, passed: 4, failed: 0, cases, ...extra })
        );
      }

      it('compares only the selected cases and does not report the others as missing', async () => {
        writeBaseline();
        await runEval(
          'agent.yaml',
          '-o',
          outputDir,
          '--only',
          'fix-*',
          '--compare-to',
          baselineRoot
        );
        const shown = allText(consoleUtilsMock.display);
        const warned = allText(consoleUtilsMock.displayWarning);
        expect(shown).toContain('compared: 2 case(s)');
        expect(warned).not.toContain('only in the baseline');
        expect(warned).not.toContain('REGRESSED');
        expect(shown).toContain(
          '--only: the baseline was compared on the same selection of cases; its other cases ' +
            'were left out, not counted as missing.'
        );
      });

      it('says when the baseline was itself a partial run', async () => {
        writeBaseline({ only: { patterns: ['fix-*'], selectedCases: 2, suiteCases: 4 } });
        await runEval('agent.yaml', '-o', outputDir, '--compare-to', baselineRoot);
        expect(allText(consoleUtilsMock.displayWarning)).toContain(
          'was a partial run (--only fix-*: 2 of 4 cases)'
        );
      });
    });
  });

  describe('--keep-transcripts', () => {
    it("writes each run's stdout, non-empty stderr, harness errors included, with per-run names", async () => {
      await runEval('command.yaml', '-o', outputDir, '--keep-transcripts');
      expect(readdirSync(outputDir).sort()).toEqual([
        'flaky#run1.stderr.txt',
        'flaky#run1.stdout.txt',
        'flaky#run2.stderr.txt',
        'flaky#run2.stdout.txt',
        'flaky.json',
        'passes.json',
        'passes.stdout.txt',
        'results.json',
        'times-out.json',
        'times-out.stderr.txt',
        'times-out.stdout.txt',
      ]);
      const read = (name: string): string => readFileSync(join(outputDir, name), 'utf8');
      expect(read('passes.stdout.txt')).toBe('pass-out');
      expect(read('times-out.stdout.txt')).toBe('partial-out');
      expect(read('times-out.stderr.txt')).toBe('too slow');
      expect(read('flaky#run2.stdout.txt')).toBe('noisy-out');
      // The timed-out run really was a harness error, so its transcript is the kept harness-error run.
      const timedOut = (results().cases as { id: string; sutOk: boolean }[]).find(
        (c) => c.id === 'times-out'
      );
      expect(timedOut?.sutOk).toBe(false);
    });

    it('writes nothing on a non-command target and prints one notice for it', async () => {
      await runEval('sweep.yaml', '-o', outputDir, '--keep-transcripts');
      const notices = consoleUtilsMock.displayInfo.mock.calls.filter((call) =>
        String(call[0]).includes('--keep-transcripts')
      );
      expect(notices).toEqual([
        [
          'eval: --keep-transcripts writes nothing for sweep.yaml: its target is "gth-agent", ' +
            'and only a "command" target has a transcript.',
        ],
      ]);
      for (const cell of ['m-one', 'm-two']) {
        expect(readdirSync(join(outputDir, cell)).filter((f) => f.endsWith('.txt'))).toEqual([]);
      }
    });
  });

  describe('with neither flag', () => {
    it('writes exactly the per-case JSON and a results.json with no added field', async () => {
      await runEval('command.yaml', '-o', outputDir);
      expect(readdirSync(outputDir).sort()).toEqual([
        'flaky.json',
        'passes.json',
        'results.json',
        'times-out.json',
      ]);
      expect(Object.keys(results())).toEqual(['total', 'passed', 'failed', 'cases']);
    });

    it('runs every case of a gth-agent suite and records no filter', async () => {
      await runEval('agent.yaml', '-o', outputDir);
      expect(dispatched).toHaveLength(4);
      expect(Object.keys(results())).toEqual(['total', 'passed', 'failed', 'cases']);
      expect(
        consoleUtilsMock.displayInfo.mock.calls.filter((call) => String(call[0]).includes('--only'))
      ).toEqual([]);
    });
  });
});
