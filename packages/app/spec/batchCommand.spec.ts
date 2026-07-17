import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Make randomUUID deterministic across this spec (used by wrapContent block ids)
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
  };
});

const resolversMock = {
  createResolvers: vi.fn(),
};
vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

const resolvedFactory = vi.fn();
const resolveAgentFactoryMock = {
  resolveAgentFactory: vi.fn(() => resolvedFactory),
};
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => resolveAgentFactoryMock);

const runSingleShot = vi.fn();
vi.mock('@gaunt-sloth/core/runtime/singleShot.js', () => ({ runSingleShot }));

const prompt = {
  readExecPrompt: vi.fn(),
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readSystemPrompt: vi.fn(),
  buildSystemMessages: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async () => {
  const actual = await vi.importActual<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>(
    '@gaunt-sloth/core/utils/llmUtils.js'
  );
  return {
    ...actual,
    readExecPrompt: prompt.readExecPrompt,
    readBackstory: prompt.readBackstory,
    readGuidelines: prompt.readGuidelines,
    readSystemPrompt: prompt.readSystemPrompt,
    buildSystemMessages: prompt.buildSystemMessages,
  };
});

// A safe (non-root, cleaned-up-per-test) stand-in for where getGslothFilePath would place a
// default-named report/dir in a real project.
const defaultOutputRoot = join(tmpdir(), 'gth-batch-command-default-output');

const fileUtilsMock = {
  readMultipleFilesFromProjectDir: vi.fn(),
  readFileFromProjectDir: vi.fn(),
  getGslothFilePath: vi.fn((name: string) => join(defaultOutputRoot, name)),
  fileSafeLocalDate: vi.fn(() => '2026-07-18_00-00-00'),
};
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => fileUtilsMock);

const consoleUtilsMock = {
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  setExitCode: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const mockConfig = {
  llm: { invoke: vi.fn(), model: 'base-model' },
  projectGuidelines: '.gsloth.guidelines.md',
  streamOutput: true,
  writeOutputToFile: true,
  canInterruptInferenceWithEsc: true,
  commands: { exec: { filesystem: 'all' } },
};

const configMock = {
  initConfig: vi.fn(),
};
vi.mock('@gaunt-sloth/core/config.js', () => configMock);

describe('batchCommand', () => {
  let outputDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();

    outputDir = mkdtempSync(join(tmpdir(), 'gth-batch-command-'));

    // Mirrors the real initConfig({ model }) -> tryJsonConfig -> processJsonConfig path (BATCH-1
    // fix): a `model` override in the call produces a genuinely fresh config/llm for that model,
    // rather than the base config being cloned/mutated. Reacting to the override here is what lets
    // the fan-out tests below prove `initConfig` is actually invoked per distinct model.
    configMock.initConfig.mockImplementation(async (overrides: { model?: string } = {}) => {
      if (overrides.model) {
        return {
          ...mockConfig,
          llm: { invoke: vi.fn(), model: overrides.model },
          modelDisplayName: overrides.model,
        };
      }
      return { ...mockConfig, llm: { ...mockConfig.llm } };
    });
    runSingleShot.mockResolvedValue(true);
    // A fresh resolvers object (with its own spy-able cleanupTools) per call, so per-cell
    // cleanup tests below can tell which cell's resolvers were cleaned up.
    resolversMock.createResolvers.mockImplementation(() => ({
      resolveTools: vi.fn(),
      cleanupTools: vi.fn(),
    }));

    prompt.readExecPrompt.mockReturnValue('EXEC MODE PROMPT');
    prompt.buildSystemMessages.mockReturnValue([{ content: 'EXEC SYSTEM PROMPT' }]);

    fileUtilsMock.readMultipleFilesFromProjectDir.mockImplementation((files: string | string[]) => {
      const list = Array.isArray(files) ? files : [files];
      if (list.includes('script.md')) return 'Greet {{name}}.';
      return '';
    });
    fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
      if (file === 'cases.csv') return 'name\nalice\nbob\n';
      throw new Error(`unexpected file read: ${file}`);
    });
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(defaultOutputRoot, { recursive: true, force: true });
  });

  it('registers the batch command with description', async () => {
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    expect(program.commands[0].name()).toEqual('batch');
    expect(program.commands[0].description()).toContain('matrix');
  });

  it('runs a single cell (no --models, no --over) through runSingleShot with the exec command', async () => {
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    await program.parseAsync(['na', 'na', 'batch', 'script.md', '-o', outputDir]);

    expect(runSingleShot).toHaveBeenCalledTimes(1);
    const [source, preamble, content, config, , command, agentFactory] =
      runSingleShot.mock.calls[0];
    expect(source).toEqual('BATCH-cell-0-0');
    expect(preamble).toEqual('EXEC SYSTEM PROMPT');
    expect(content).toContain('Greet {{name}}.');
    expect(command).toEqual('exec');
    expect(config.writeOutputToFile).toBe(false);
    expect(config.canInterruptInferenceWithEsc).toBe(false);
    expect(agentFactory).toBe(resolvedFactory);

    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      cells: [{ id: 'cell-0-0', model: undefined, inputIndex: 0, ok: true, retries: 0 }],
    });
  });

  it('fans out over --models, one runSingleShot call per model with an overridden llm.model', async () => {
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'batch',
      'script.md',
      '--models',
      'model-a,model-b',
      '-o',
      outputDir,
    ]);

    expect(runSingleShot).toHaveBeenCalledTimes(2);
    const modelsPassed = runSingleShot.mock.calls.map((call) => call[3].llm.model).sort();
    expect(modelsPassed).toEqual(['model-a', 'model-b']);
    // BATCH-1 fix: each distinct model must be built via a genuinely fresh initConfig() call
    // (which threads through tryJsonConfig -> processJsonConfig, the provider-factory path),
    // not by cloning the base config's llm instance.
    expect(configMock.initConfig).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model-a' })
    );
    expect(configMock.initConfig).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model-b' })
    );
    // The original base config's llm instance must be untouched (no shared-instance mutation).
    expect(mockConfig.llm.model).toEqual('base-model');
  });

  it(
    'regression (BATCH-1 finding 1): builds one fresh config per DISTINCT model, not per cell — ' +
      'a matrix that reuses a model across several --over rows must not re-run initConfig for it',
    async () => {
      const { batchCommand } = await import('#src/commands/batchCommand.js');
      const program = new Command();
      batchCommand(program, {});
      // 2 models x 2 rows = 4 cells, but only 2 DISTINCT models.
      await program.parseAsync([
        'na',
        'na',
        'batch',
        'script.md',
        '--models',
        'model-a,model-b',
        '--over',
        'cases.csv',
        '-o',
        outputDir,
      ]);

      expect(runSingleShot).toHaveBeenCalledTimes(4);
      // 1 base initConfig() call (command entry) + 1 per distinct model = 3, not 1 + 4.
      expect(configMock.initConfig).toHaveBeenCalledTimes(3);

      const cellsForModelA = runSingleShot.mock.calls.filter(
        (call) => call[3].llm.model === 'model-a'
      );
      expect(cellsForModelA).toHaveLength(2);
      // Both cells sharing `model-a` must have been handed the SAME fresh llm instance (the
      // cache hit), not two independently-built ones.
      expect(cellsForModelA[0][3].llm).toBe(cellsForModelA[1][3].llm);
    }
  );

  it('fans out over --over rows, interpolating {{field}} into the script content', async () => {
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'batch',
      'script.md',
      '--over',
      'cases.csv',
      '-o',
      outputDir,
    ]);

    expect(runSingleShot).toHaveBeenCalledTimes(2);
    const contents = runSingleShot.mock.calls.map((call) => call[2]).sort();
    expect(contents[0]).toContain('Greet alice.');
    expect(contents[1]).toContain('Greet bob.');
  });

  it('never sets a non-zero exit code just because a cell failed (exit-code contract)', async () => {
    runSingleShot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'batch',
      'script.md',
      '--models',
      'model-a,model-b',
      '-o',
      outputDir,
    ]);

    expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson.total).toBe(2);
    expect(resultsJson.passed).toBe(1);
    expect(resultsJson.failed).toBe(1);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('1 cell(s) failed')
    );
  });

  it(
    'regression (BATCH-1 finding 2): calls cleanupTools() exactly once per cell on the success ' +
      'path — createResolvers() must not be passed inline and discarded',
    async () => {
      const { batchCommand } = await import('#src/commands/batchCommand.js');
      const program = new Command();
      batchCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'batch',
        'script.md',
        '--models',
        'model-a,model-b',
        '-o',
        outputDir,
      ]);

      expect(resolversMock.createResolvers).toHaveBeenCalledTimes(2);
      const resolversInstances = resolversMock.createResolvers.mock.results.map((r) => r.value);
      for (const resolvers of resolversInstances) {
        expect(resolvers.cleanupTools).toHaveBeenCalledTimes(1);
      }
    }
  );

  it(
    'regression (BATCH-1 finding 2): calls cleanupTools() exactly once per cell even when the ' +
      'cell throws',
    async () => {
      runSingleShot.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
      const { batchCommand } = await import('#src/commands/batchCommand.js');
      const program = new Command();
      batchCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'batch',
        'script.md',
        '--models',
        'model-a,model-b',
        '-o',
        outputDir,
      ]);

      expect(resolversMock.createResolvers).toHaveBeenCalledTimes(2);
      const resolversInstances = resolversMock.createResolvers.mock.results.map((r) => r.value);
      for (const resolvers of resolversInstances) {
        expect(resolvers.cleanupTools).toHaveBeenCalledTimes(1);
      }

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson.passed).toBe(1);
      expect(resultsJson.failed).toBe(1);
    }
  );

  it(
    'regression (BATCH-1 finding 2): a cleanupTools() failure never masks or overrides the ' +
      "cell's real result (exit-code contract must survive a cleanup failure too)",
    async () => {
      resolversMock.createResolvers.mockImplementation(() => ({
        resolveTools: vi.fn(),
        cleanupTools: vi.fn().mockRejectedValue(new Error('cleanup boom')),
      }));
      const { batchCommand } = await import('#src/commands/batchCommand.js');
      const program = new Command();
      batchCommand(program, {});
      await program.parseAsync(['na', 'na', 'batch', 'script.md', '-o', outputDir]);

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson.passed).toBe(1); // real cell result preserved despite cleanup failure
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up tools')
      );
    }
  );

  it('propagates a malformed --over file as a harness-level throw (uncaught by the action)', async () => {
    fileUtilsMock.readFileFromProjectDir.mockImplementation(() => '');
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});

    await expect(
      program.parseAsync(['na', 'na', 'batch', 'script.md', '--over', 'cases.csv', '-o', outputDir])
    ).rejects.toThrow(/empty CSV/);

    expect(runSingleShot).not.toHaveBeenCalled();
  });

  it('respects -j/--concurrency and --retry pass-through to the runner', async () => {
    // Every cell fails once then succeeds on retry — proves --retry actually reruns cells.
    let calls = 0;
    runSingleShot.mockImplementation(async () => {
      calls++;
      return calls > 1;
    });
    const { batchCommand } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'batch',
      'script.md',
      '-j',
      '2',
      '--retry',
      '1',
      '-o',
      outputDir,
    ]);

    expect(calls).toBe(2); // 1 failed attempt + 1 retry
    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson.passed).toBe(1);
  });

  it('uses the default timestamped output dir when -o is omitted', async () => {
    const { batchCommand, defaultBatchOutputDir } = await import('#src/commands/batchCommand.js');
    const program = new Command();
    batchCommand(program, {});
    await program.parseAsync(['na', 'na', 'batch', 'script.md']);

    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      expect.stringContaining(defaultBatchOutputDir())
    );
  });
});
