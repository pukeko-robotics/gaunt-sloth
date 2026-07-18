import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// B5: execCommand resolves the backend factory (default lean) and passes it to runSingleShot.
const resolvedFactory = vi.fn();
const resolveAgentFactoryMock = {
  resolveAgentFactory: vi.fn(() => resolvedFactory),
};
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => resolveAgentFactoryMock);

const runSingleShot = vi.fn();
const singleShotModule = { runSingleShot };
vi.mock('@gaunt-sloth/core/runtime/singleShot.js', () => singleShotModule);

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

const fileUtilsMock = {
  readMultipleFilesFromProjectDir: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => fileUtilsMock);

const systemUtilsMock = {
  getStringFromStdin: vi.fn().mockReturnValue(''),
  setExitCode: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const consoleUtilsMock = {
  displayError: vi.fn(),
  displayWarning: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const mockConfig = {
  llm: { invoke: vi.fn(), temperature: 0.7 },
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

describe('execCommand', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();

    configMock.initConfig.mockResolvedValue({ ...mockConfig, llm: { ...mockConfig.llm } });
    runSingleShot.mockResolvedValue({ ok: true, answer: 'test answer', tools: [] });
    resolversMock.createResolvers.mockReturnValue({ resolveTools: vi.fn(), cleanupTools: vi.fn() });

    // The introspection prompt is built via buildSystemMessages (flattened to a string).
    prompt.readExecPrompt.mockReturnValue('EXEC MODE PROMPT');
    prompt.buildSystemMessages.mockReturnValue([{ content: 'EXEC SYSTEM PROMPT' }]);

    fileUtilsMock.readMultipleFilesFromProjectDir.mockImplementation((files: string | string[]) => {
      const list = Array.isArray(files) ? files : [files];
      if (list.includes('script.md')) return 'SCRIPT BODY';
      if (list.includes('context.md')) return 'CONTEXT BODY';
      return '';
    });
  });

  it('registers the exec command with description', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    expect(program.commands[0].name()).toEqual('exec');
    expect(program.commands[0].description()).toContain('prompt-executable');
  });

  it('runs a .md script file via runSingleShot with the exec command and prompt', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md']);

    expect(runSingleShot).toHaveBeenCalledTimes(1);
    const [source, preamble, content, , , command, agentFactory] = runSingleShot.mock.calls[0];
    expect(source).toEqual('EXEC');
    expect(preamble).toEqual('EXEC SYSTEM PROMPT');
    expect(command).toEqual('exec');
    // Script is wrapped (alwaysWrap) with deterministic block id.
    expect(content).toContain('SCRIPT BODY');
    expect(content).toContain('prompt-executable script');
    expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    // B5: exec defaults to the lean backend; the resolved factory is threaded through.
    expect(resolveAgentFactoryMock.resolveAgentFactory).toHaveBeenCalledWith(
      expect.anything(),
      'lean'
    );
    expect(agentFactory).toBe(resolvedFactory);
  });

  it('reads the script from stdin when no path argument is given', async () => {
    systemUtilsMock.getStringFromStdin.mockReturnValue('PIPED SCRIPT');
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec']);

    expect(runSingleShot).toHaveBeenCalledTimes(1);
    const content = runSingleShot.mock.calls[0][2];
    expect(content).toContain('PIPED SCRIPT');
  });

  it('prepends -f context files before the script', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md', '-f', 'context.md']);

    const content = runSingleShot.mock.calls[0][2];
    expect(content.indexOf('CONTEXT BODY')).toBeLessThan(content.indexOf('SCRIPT BODY'));
  });

  it('configures pipe-friendly, non-interactive determinism defaults', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md']);

    const passedConfig = runSingleShot.mock.calls[0][3];
    // Result goes to stdout for piping, not a md report, by default.
    expect(passedConfig.writeOutputToFile).toBe(false);
    // Non-interactive: ESC interrupt disabled.
    expect(passedConfig.canInterruptInferenceWithEsc).toBe(false);
  });

  it('applies the --temperature determinism knob to the llm', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md', '--temperature', '0']);

    const passedConfig = runSingleShot.mock.calls[0][3];
    expect(passedConfig.llm.temperature).toBe(0);
  });

  it('sets a non-zero exit code when the run fails', async () => {
    runSingleShot.mockResolvedValue({ ok: false, answer: '', tools: [] });
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md']);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('sets a non-zero exit code when the run throws', async () => {
    runSingleShot.mockRejectedValue(new Error('boom'));
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md']);

    expect(consoleUtilsMock.displayError).toHaveBeenCalled();
    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('throws when no script is provided (no path, stdin, or file)', async () => {
    systemUtilsMock.getStringFromStdin.mockReturnValue('');
    fileUtilsMock.readMultipleFilesFromProjectDir.mockReturnValue('');
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});

    await expect(program.parseAsync(['na', 'na', 'exec'])).rejects.toThrow('A script is required');
  });

  it('uses -m/--message inline text as the prompt instead of reading a file', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', '-m', 'do the thing']);

    expect(runSingleShot).toHaveBeenCalledTimes(1);
    const [, , content, , , command] = runSingleShot.mock.calls[0];
    expect(command).toEqual('exec');
    expect(content).toContain('do the thing');
    expect(content).toContain('prompt-executable script');
    // No file path was read for the prompt itself.
    expect(fileUtilsMock.readMultipleFilesFromProjectDir).not.toHaveBeenCalledWith(['script.md']);
  });

  it('-m wins over stdin (explicit inline text takes precedence)', async () => {
    systemUtilsMock.getStringFromStdin.mockReturnValue('PIPED SCRIPT');
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', '-m', 'inline wins']);

    const content = runSingleShot.mock.calls[0][2];
    expect(content).toContain('inline wins');
    expect(content).not.toContain('PIPED SCRIPT');
  });

  it('errors when both a [script] path and -m are given (no ambiguity)', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});

    await expect(
      program.parseAsync(['na', 'na', 'exec', 'script.md', '-m', 'inline'])
    ).rejects.toThrow('either a [script] path or -m/--message');
  });

  it('threads --allow-dir into config.allowDirs and warns loudly (repeatable)', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'exec',
      'script.md',
      '--allow-dir',
      '../shared',
      '--allow-dir',
      '/tmp/out',
    ]);

    const passedConfig = runSingleShot.mock.calls[0][3];
    expect(passedConfig.allowDirs).toEqual(['../shared', '/tmp/out']);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('../shared, /tmp/out')
    );
  });

  it('does not set allowDirs when --allow-dir is absent', async () => {
    const { execCommand } = await import('#src/commands/execCommand.js');
    const program = new Command();
    execCommand(program, {});
    await program.parseAsync(['na', 'na', 'exec', 'script.md']);

    const passedConfig = runSingleShot.mock.calls[0][3];
    expect(passedConfig.allowDirs).toBeUndefined();
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });
});
