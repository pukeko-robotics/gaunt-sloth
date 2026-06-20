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
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock systemUtils
const systemUtilsMock = {
  stdout: {
    write: vi.fn(),
  },
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
      expect(childProcessMock.spawn).toHaveBeenCalledWith('echo test', { shell: true });
    });

    it('should handle command failure', async () => {
      const mockChild = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1); // Failure
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      const result = await toolkit['executeCommand']('failing cmd', 'test_tool');
      expect(result).toContain('exited with code 1');
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
