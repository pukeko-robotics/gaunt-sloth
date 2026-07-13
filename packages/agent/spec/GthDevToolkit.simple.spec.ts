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

    it('keeps the same single-parameter schema in both plain and virtualFs mode', () => {
      // The virtualMode awareness is description-only: no extra tool parameter is added, so there is
      // nothing unusual for a provider's tool-schema validation (or the model) to trip over.
      for (const virtualFs of [false, true]) {
        const t = new GthDevToolkit({ shell: true }, 'code', { virtualFs });
        const shellTool = t.tools.find((x) => x.name === 'run_shell_command')!;
        expect(Object.keys((shellTool.schema as any).shape ?? {})).toEqual(['command']);
      }
    });

    it('by default (virtualFs off) uses the plain description (no path-namespace warning)', () => {
      toolkit = new GthDevToolkit({ shell: true });
      const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;
      expect(shellTool.description).not.toContain('VIRTUAL');
    });

    it('in virtualFs mode augments the description with the fs-vs-shell path warning', () => {
      toolkit = new GthDevToolkit({ shell: true }, 'code', { virtualFs: true });
      const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;
      // Warns that fs paths are virtual and steers the model to verify the real cwd (pwd/cd).
      expect(shellTool.description).toContain('VIRTUAL');
      expect(shellTool.description).toContain(process.platform === 'win32' ? '`cd`' : '`pwd`');
    });

    it('in virtualFs mode runs the command normally (schema unchanged)', async () => {
      toolkit = new GthDevToolkit({ shell: true }, 'code', { virtualFs: true });
      const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;
      const result = await shellTool.invoke({ command: 'echo hi' });
      expect(result).toContain("Command 'echo hi' completed successfully");
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

    it('should handle execution error', async () => {
      const mockChild = {
        on: vi.fn((event, callback) => {
          if (event === 'error') callback(new Error('Spawn error'));
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      await expect(toolkit['executeCommand']('error cmd', 'test_tool')).rejects.toThrow(
        'Failed to execute command'
      );
      expect(consoleUtilsMock.displayError).toHaveBeenCalled();
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
