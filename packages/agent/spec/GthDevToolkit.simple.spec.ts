import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// Mock child_process
const childProcessMock = {
  spawn: vi.fn(),
};
vi.mock('child_process', () => childProcessMock);

// Mock consoleUtils
const consoleUtilsMock = {
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Sentinel fs-backend root: distinct from process.cwd() so the S4 assertion below proves the spawn
// cwd comes from getCurrentWorkDir() and not from bare process.cwd().
const FAKE_WORKDIR = '/fake/fs-backend-root';

// Mock systemUtils (env is consumed by the shell credential-scrub helper; getCurrentWorkDir is the
// EXT-22/S4 spawn cwd). `#src/utils/systemUtils.js` and `@gaunt-sloth/core/utils/systemUtils.js`
// resolve to the same core module under the vitest workspace plugin, so this intercepts the toolkit.
const systemUtilsMock = {
  stdout: {
    write: vi.fn(),
  },
  env: { PATH: '/usr/bin', HOME: '/home/test' },
  getCurrentWorkDir: vi.fn(() => FAKE_WORKDIR),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('GthDevToolkit - Basic Tests', () => {
  let GthDevToolkit: typeof import('#src/tools/GthDevToolkit.js').default;
  let toolkit: InstanceType<typeof import('#src/tools/GthDevToolkit.js').default>;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Mock spawn to simulate successful command
    const mockChild = {
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0); // Success
        }
        if (event === 'error') {
          callback(new Error('Test error'));
        }
      }),
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') callback(Buffer.from('Test output\n'));
        }),
      },
      stderr: {
        on: vi.fn((event, callback) => {
          if (event === 'data') callback(Buffer.from('Test error\n'));
        }),
      },
    };
    childProcessMock.spawn.mockReturnValue(mockChild as any);

    ({ default: GthDevToolkit } = await import('#src/tools/GthDevToolkit.js'));
  });

  describe('constructor', () => {
    it('should initialize with provided commands', () => {
      const commands = {
        run_tests: 'npm test',
        run_single_test: 'npm test -- ${testPath}',
        run_lint: 'npm run lint',
        run_build: 'npm run build',
      };
      toolkit = new GthDevToolkit(commands);
      expect(toolkit).toBeDefined();
      expect(toolkit.tools).toBeDefined();
      expect(toolkit.tools.length).toBe(4); // All four tools
    });

    it('should initialize only available tools', () => {
      const commands = {
        run_tests: 'npm test',
      };
      toolkit = new GthDevToolkit(commands);
      expect(toolkit.tools.length).toBe(1);
      expect(toolkit.tools[0].name).toBe('run_tests');
    });

    it('should have all expected tools when all commands provided', () => {
      const commands = {
        run_tests: 'npm test',
        run_single_test: 'npm test -- ${testPath}',
        run_lint: 'npm run lint',
        run_build: 'npm run build',
      };
      toolkit = new GthDevToolkit(commands);
      const toolNames = toolkit.tools.map((t) => t.name);

      expect(toolNames).toContain('run_tests');
      expect(toolNames).toContain('run_single_test');
      expect(toolNames).toContain('run_lint');
      expect(toolNames).toContain('run_build');
    });
  });

  describe('getFilteredTools', () => {
    it('should return tools filtered by type', () => {
      const commands = {
        run_tests: 'npm test',
        run_single_test: 'npm test -- ${testPath}',
      };
      toolkit = new GthDevToolkit(commands);
      const filtered = toolkit.getFilteredTools(['execute']);
      expect(filtered.length).toBe(2);
      expect(filtered.every((tool) => (tool as any).gthDevType === 'execute')).toBe(true);
    });
  });

  describe('run_shell_command (opt-in shell tool)', () => {
    it('is NOT emitted by default (shell omitted)', () => {
      toolkit = new GthDevToolkit({ run_tests: 'npm test' });
      expect(toolkit.tools.map((t) => t.name)).not.toContain('run_shell_command');
    });

    it('is NOT emitted when shell is false', () => {
      toolkit = new GthDevToolkit({ shell: false });
      expect(toolkit.tools.map((t) => t.name)).not.toContain('run_shell_command');
    });

    it('is emitted when shell is true (bare boolean)', () => {
      toolkit = new GthDevToolkit({ shell: true });
      const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command');
      expect(shellTool).toBeDefined();
      expect((shellTool as any).gthDevType).toBe('execute');
    });

    it('is emitted when shell is { enabled: true } (object form)', () => {
      toolkit = new GthDevToolkit({ shell: { enabled: true } });
      expect(toolkit.tools.map((t) => t.name)).toContain('run_shell_command');
    });

    it('is NOT emitted when shell is { enabled: false }', () => {
      toolkit = new GthDevToolkit({ shell: { enabled: false } });
      expect(toolkit.tools.map((t) => t.name)).not.toContain('run_shell_command');
    });

    it('runs the model-supplied command verbatim (no parameter sanitizing)', async () => {
      toolkit = new GthDevToolkit({ shell: true });
      const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;
      // A legitimate shell command with a pipe + $ — would be rejected by the path sanitizer,
      // but the shell tool must pass it through (confirmation, not filtering, is the guardrail).
      const result = await shellTool.invoke({ command: 'echo $HOME | cat' });
      expect(result).toContain("Command 'echo $HOME | cat' completed successfully");
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        'echo $HOME | cat',
        // EXT-15: `detached` is POSIX-only (Windows uses taskkill /T, not process groups).
        expect.objectContaining({
          shell: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });
  });

  describe('buildSingleTestCommand', () => {
    it('should build command with placeholder', () => {
      toolkit = new GthDevToolkit({ run_single_test: 'npm test -- ${testPath}' });
      expect(toolkit['buildSingleTestCommand']('spec/test.ts')).toBe('npm test -- spec/test.ts');
    });

    it('should build command without placeholder', () => {
      toolkit = new GthDevToolkit({ run_single_test: 'npm test' });
      expect(toolkit['buildSingleTestCommand']('spec/test.ts')).toBe('npm test spec/test.ts');
    });

    it('should throw if no command configured', () => {
      toolkit = new GthDevToolkit({});
      expect(() => toolkit['buildSingleTestCommand']('test.ts')).toThrow(
        'No test command configured'
      );
    });
  });

  describe('executeCommand', () => {
    beforeEach(() => {
      toolkit = new GthDevToolkit({});
    });

    it('should execute command successfully', async () => {
      const result = await toolkit['executeCommand']('echo test', 'test_tool');
      expect(result).toContain("Executing 'echo test'...");
      expect(result).toContain('<COMMAND_OUTPUT>');
      expect(result).toContain("Command 'echo test' completed successfully");
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        '\n🔧 Executing test_tool: echo test'
      );
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        'echo test',
        // EXT-15: `detached` is POSIX-only (Windows uses taskkill /T, not process groups).
        // EXT-22 (S4): cwd is the fs-backend root (getCurrentWorkDir()), not bare process.cwd().
        expect.objectContaining({
          shell: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: FAKE_WORKDIR,
        })
      );
    });

    it('EXT-22 (S4): spawns with cwd === getCurrentWorkDir() (the fs-backend root)', async () => {
      await toolkit['executeCommand']('echo hi', 'run_shell_command');
      // The shell must spawn in the same directory the deepagents FilesystemBackend is rooted at
      // (getCurrentWorkDir()), so the shell tool and the fs tools share one path namespace.
      expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
      const [, options] = childProcessMock.spawn.mock.calls[0];
      expect((options as { cwd?: string }).cwd).toBe(FAKE_WORKDIR);
      expect((options as { cwd?: string }).cwd).toBe(systemUtilsMock.getCurrentWorkDir());
    });

    it('should throw ShellCommandFailedError on a non-zero exit (was resolve)', async () => {
      const mockChild = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1); // Failure
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      // EXT-20: a non-zero exit REJECTS (was resolve) so the softening middleware can flip the
      // ToolMessage to status:'error' (✗). The message carries the full failure body.
      await expect(toolkit['executeCommand']('failing cmd', 'test_tool')).rejects.toThrow(
        'exited with code 1'
      );
    });

    it('preserves stdout/stderr and metadata on the ShellCommandFailedError', async () => {
      const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
      const mockChild = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(3);
        }),
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('captured-stdout\n'));
          }),
        },
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('captured-stderr\n'));
          }),
        },
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      const error = (await toolkit['executeCommand']('failing cmd', 'run_build').catch(
        (e) => e
      )) as InstanceType<typeof ShellCommandFailedError>;

      expect(error).toBeInstanceOf(ShellCommandFailedError);
      expect(error.exitCode).toBe(3);
      expect(error.command).toBe('failing cmd');
      expect(error.toolName).toBe('run_build');
      // The full model-facing body is preserved verbatim (output + both streams + the exit tail).
      expect(error.output).toContain('<COMMAND_OUTPUT>');
      expect(error.output).toContain('captured-stdout');
      expect(error.output).toContain('captured-stderr');
      expect(error.output).toContain("Command 'failing cmd' exited with code 3");
      // Error.message mirrors the body so a generic logger still surfaces the real output.
      expect(error.message).toBe(error.output);
    });

    it('throws ShellCommandFailedError (exitCode null) when the command is killed on timeout', async () => {
      vi.useFakeTimers();
      try {
        const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
        const mockKill = vi.fn();
        let closeCallback: ((_code: number | null) => void) | undefined;
        const mockChild = {
          // No numeric pid → killProcessGroup is a no-op (we only exercise the timeout→reject path,
          // not a real process-group signal).
          on: vi.fn((event: string, callback: (_arg: any) => void) => {
            if (event === 'close') closeCallback = callback;
          }),
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          kill: mockKill,
        };
        childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

        const timeoutToolkit = new GthDevToolkit({ shell: { enabled: true, timeout: 50 } });
        const resultPromise = (
          timeoutToolkit as unknown as {
            executeCommand(_c: string, _n: string): Promise<string>;
          }
        ).executeCommand('sleep 999', 'run_shell_command');
        // Attach a catch synchronously so the rejection is never unhandled.
        const captured = resultPromise.catch((e) => e);

        // Trip the timeout timer, then simulate the process closing after the kill.
        await vi.advanceTimersByTimeAsync(50);
        closeCallback?.(null);

        const error = (await captured) as InstanceType<typeof ShellCommandFailedError>;
        expect(error).toBeInstanceOf(ShellCommandFailedError);
        expect(error.exitCode).toBeNull();
        expect(error.output).toContain('was killed after exceeding');
      } finally {
        vi.useRealTimers();
      }
    });

    it('GS2-36: a spawn-level failure rejects a ShellCommandFailedError (softenable), not a plain Error', async () => {
      // Previously the 'error' event rejected a plain Error, which neither shell-exit softener
      // recognises → a fatal `Stream processing failed` that aborted the whole run. Now it rejects a
      // ShellCommandFailedError (exitCode null, like a timeout-kill), so BOTH softeners convert it
      // into a recoverable status:'error' ToolMessage and the model can route around it.
      const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
      const mockChild = {
        on: vi.fn((event, callback) => {
          if (event === 'error') callback(new Error('Spawn error'));
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      const error = (await toolkit['executeCommand']('error cmd', 'run_shell_command').catch(
        (e) => e
      )) as InstanceType<typeof ShellCommandFailedError>;

      expect(error).toBeInstanceOf(ShellCommandFailedError);
      expect(error.exitCode).toBeNull();
      expect(error.command).toBe('error cmd');
      expect(error.toolName).toBe('run_shell_command');
      expect(error.output).toContain("Failed to start command 'error cmd'");
      expect(error.output).toContain('Spawn error');
      expect(error.output).toContain('working directory is valid');
      expect(consoleUtilsMock.displayError).toHaveBeenCalled();
    });

    it('streams child stdout/stderr to raw stdout by default (the headless path, TUI-C17)', async () => {
      // No tool-output subscriber: the channel's default sink must reproduce the historical
      // behaviour — the notice via displayInfo, each child chunk via stdout.write, verbatim.
      await toolkit['executeCommand']('echo test', 'test_tool');
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        '\n🔧 Executing test_tool: echo test'
      );
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('Test output\n');
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith('Test error\n');
    });
  });

  describe('tool-output channel routing (TUI-C17)', () => {
    it('routes the notice + streamed chunks to a subscriber, attributed to the tool call id, with NO raw stdout', async () => {
      const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
      const received: unknown[] = [];
      const unsubscribe = subscribeToolOutput((chunk) => received.push(chunk));
      try {
        toolkit = new GthDevToolkit({ run_tests: 'npm test' });
        const tool = toolkit.tools.find((t) => t.name === 'run_tests')!;
        // Invoke as a real ToolCall so LangChain threads `config.toolCall.id` into the fn —
        // the same shape the agent's ToolNode uses, which is where attribution comes from.
        await tool.invoke({ id: 'call-42', name: 'run_tests', args: {}, type: 'tool_call' });

        expect(received).toEqual([
          {
            toolCallId: 'call-42',
            toolName: 'run_tests',
            kind: 'notice',
            text: '🔧 Executing run_tests: npm test',
          },
          { toolCallId: 'call-42', toolName: 'run_tests', kind: 'output', text: 'Test output\n' },
          { toolCallId: 'call-42', toolName: 'run_tests', kind: 'output', text: 'Test error\n' },
        ]);
        // While managed, nothing leaks to the raw console/stdout (the Ink-frame corruption bug).
        expect(systemUtilsMock.stdout.write).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('emits without a toolCallId when invoked with plain args (no ToolCall context)', async () => {
      const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
      const received: Array<{ toolCallId?: string; kind: string }> = [];
      const unsubscribe = subscribeToolOutput((chunk) => received.push(chunk));
      try {
        toolkit = new GthDevToolkit({ run_tests: 'npm test' });
        const tool = toolkit.tools.find((t) => t.name === 'run_tests')!;
        await tool.invoke({});
        expect(received.length).toBeGreaterThan(0);
        expect(received.every((c) => c.toolCallId === undefined)).toBe(true);
      } finally {
        unsubscribe();
      }
    });

    it('TUI-C31 (a): a hardline refusal routes to the subscriber as a warning chunk, NOT raw displayWarning', async () => {
      const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
      const received: Array<{ kind: string; text: string; toolCallId?: string }> = [];
      const unsubscribe = subscribeToolOutput((chunk) => received.push(chunk));
      try {
        toolkit = new GthDevToolkit({ run_tests: 'npm test' });
        // A hardline command is refused WITHOUT spawning; the refusal used to hit raw displayWarning.
        const refusal = await toolkit['executeCommand'](
          'rm -rf /',
          'run_shell_command',
          'call-hard'
        );
        expect(refusal).toContain('blocked by hardline safety policy');

        const warning = received.find((c) => c.kind === 'warning');
        expect(warning).toBeDefined();
        expect(warning!.text).toContain('⛔');
        expect(warning!.text).toContain('blocked by hardline safety policy');
        expect(warning!.toolCallId).toBe('call-hard');
        // Under the managed frame the refusal must NOT leak to raw displayWarning.
        expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('TUI-C31 (a): a spawn-level failure routes to the subscriber as an error chunk, NOT raw displayError', async () => {
      const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
      const received: Array<{ kind: string; text: string; toolCallId?: string }> = [];
      const unsubscribe = subscribeToolOutput((chunk) => received.push(chunk));
      try {
        const mockChild = {
          on: vi.fn((event: string, callback: (_arg: any) => void) => {
            if (event === 'error') callback(new Error('spawn ENOENT'));
          }),
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
        };
        childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

        toolkit = new GthDevToolkit({ run_tests: 'npm test' });
        await toolkit['executeCommand']('nope', 'run_shell_command', 'call-err').catch(() => {});

        const err = received.find((c) => c.kind === 'error');
        expect(err).toBeDefined();
        expect(err!.text).toContain("Failed to start command 'nope'");
        expect(err!.toolCallId).toBe('call-err');
        // Under the managed frame the advisory must NOT leak to raw displayError.
        expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });

  describe('tool invocation', () => {
    beforeEach(() => {
      const commands = {
        run_tests: 'npm test',
        run_single_test: 'npm test -- ${testPath}',
      };
      toolkit = new GthDevToolkit(commands);
    });

    it('should invoke run_tests tool', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'run_tests')!;
      const result = await tool.invoke({});
      expect(result).toContain("Command 'npm test' completed successfully");
    });

    it('should invoke run_single_test with valid path', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'run_single_test')!;
      const inputPath = 'spec/test.spec.ts';
      const normalizedPath = path.normalize(inputPath);
      const result = await tool.invoke({ testPath: inputPath });
      expect(result).toContain(`Command 'npm test -- ${normalizedPath}' completed successfully`);
    });

    it('should reject directory traversal in run_single_test', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'run_single_test')!;
      await expect(tool.invoke({ testPath: '../invalid' })).rejects.toThrow(
        "Directory traversal attempts are not allowed in parameter 'testPath'"
      );
      await expect(tool.invoke({ testPath: 'dir/../../secret' })).rejects.toThrow(
        "Directory traversal attempts are not allowed in parameter 'testPath'"
      );
    });

    it('should reject absolute paths in run_single_test', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'run_single_test')!;
      await expect(tool.invoke({ testPath: '/absolute/path/test.ts' })).rejects.toThrow(
        "Absolute paths are not allowed for parameter 'testPath'"
      );
    });

    it('should reject shell injection in run_single_test', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'run_single_test')!;
      await expect(tool.invoke({ testPath: 'test|rm -rf' })).rejects.toThrow(
        "Shell injection attempts are not allowed in parameter 'testPath'"
      );
      await expect(tool.invoke({ testPath: 'test; evil' })).rejects.toThrow(
        "Shell injection attempts are not allowed in parameter 'testPath'"
      );
      await expect(tool.invoke({ testPath: 'test`evil`' })).rejects.toThrow(
        "Shell injection attempts are not allowed in parameter 'testPath'"
      );
    });
  });
});
