import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunResult, CommandSpawnRequest } from '#src/commands/commandEvalRunner.js';

// BATCH-65 — the run-level total of the cost agents reported, printed beside `EVAL TOTAL:` for a
// multi-suite run. Every command is faked behind the spawn seam, and the decoder reads a one-line
// JSON `{ answer, cost? }`, so no agent is started.

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
    loadTranscriptDecoder: async () => (stdout: string) => {
      const run = JSON.parse(stdout) as { answer: string; cost?: number };
      return {
        answer: run.answer,
        toolCalls: [],
        toolResults: [],
        ...(run.cost !== undefined ? { costUsd: run.cost } : {}),
      };
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
  env: {},
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const introspectionMock = { getAskSystemPrompt: vi.fn() };
vi.mock('#src/commands/commandIntrospection.js', () => introspectionMock);

const configMock = {
  initConfig: vi.fn(),
  resolveIdentityProfileConfigPath: vi.fn(),
  loadRunLevelEvalConfig: vi.fn(),
};
vi.mock('@gaunt-sloth/core/config.js', () => configMock);

const commandSuite = (...prompts: string[]): string => `
target:
  type: command
  run: agent -p
  transcript: claude-stream-json
cases:
${prompts.map((prompt) => `  - { id: ${prompt}, prompt: ${prompt}, must_contain: [done] }`).join('\n')}
`;

const FILES: Record<string, string> = {
  'one.yaml': commandSuite('costed-a', 'free-a'),
  'two.yaml': commandSuite('costed-b'),
  'free.yaml': commandSuite('free-b'),
  'agent.yaml': `
target: { type: gth-agent }
cases:
  - { id: agent-case, prompt: hi, must_contain: [done] }
`,
};

const RUNS: Record<string, CommandRunResult> = {
  'costed-a': { stdout: '{"answer":"done","cost":0.1}', stderr: '', exitCode: 0, timedOut: false },
  'costed-b': { stdout: '{"answer":"done","cost":0.2}', stderr: '', exitCode: 0, timedOut: false },
  'free-a': { stdout: '{"answer":"done"}', stderr: '', exitCode: 0, timedOut: false },
  'free-b': { stdout: '{"answer":"done"}', stderr: '', exitCode: 0, timedOut: false },
};

describe('gth eval — the agent-reported cost across suites', () => {
  let projectRoot: string;
  let outputRoot: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    projectRoot = mkdtempSync(join(tmpdir(), 'gth-batch65-project-'));
    outputRoot = mkdtempSync(join(tmpdir(), 'gth-batch65-out-'));
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
    batchCommandMock.buildProductionRunCell.mockResolvedValue(async () => ({
      ok: true,
      answer: 'done',
    }));
    batchCommandMock.buildProductionRunConversation.mockResolvedValue(async () => []);
    spawnMock.mockImplementation(async (request: CommandSpawnRequest) => RUNS[request.prompt]);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  async function runEval(...files: string[]): Promise<string[]> {
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', ...files, '-o', join(outputRoot, 'run')]);
    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    const ordered: Array<[number, string]> = [];
    for (const mock of Object.values(consoleUtilsMock)) {
      mock.mock.calls.forEach((call, index) => {
        ordered.push([mock.mock.invocationCallOrder[index], String(call[0])]);
      });
    }
    return ordered.sort((a, b) => a[0] - b[0]).map(([, line]) => line);
  }

  it('prints each suite its own line, then the total across suites right after EVAL TOTAL', async () => {
    const lines = await runEval('one.yaml', 'two.yaml', 'free.yaml', 'agent.yaml');
    expect(lines.filter((line) => line.startsWith('COST'))).toEqual([
      'COST (reported by agent): 0.1 USD for 1 of 2 case(s)',
      'COST (reported by agent): 0.2 USD for 1 of 1 case(s)',
      'COST TOTAL (reported by agent): 0.3 USD for 2 of 5 case(s)',
    ]);
    const total = lines.indexOf('EVAL TOTAL: 5/5 across 4 suites, 0 failed');
    expect(total).toBeGreaterThan(-1);
    expect(lines[total + 1]).toBe('COST TOTAL (reported by agent): 0.3 USD for 2 of 5 case(s)');
  });

  it('prints no cost line at all when no case in any suite reported one', async () => {
    const lines = await runEval('free.yaml', 'agent.yaml');
    expect(lines).toContain('EVAL TOTAL: 2/2 across 2 suites, 0 failed');
    expect(lines.some((line) => /^COST|reported by agent/.test(line))).toBe(false);
  });

  it('prints no TOTAL cost line for a single suite, whose own line already is the total', async () => {
    const lines = await runEval('one.yaml');
    expect(lines.filter((line) => line.startsWith('COST'))).toEqual([
      'COST (reported by agent): 0.1 USD for 1 of 2 case(s)',
    ]);
  });
});
