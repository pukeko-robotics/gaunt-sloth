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

// Mock systemUtils
const mockRlQuestion = vi.fn();
const mockRlClose = vi.fn();
const systemUtilsMock = {
  stdout: {
    write: vi.fn(),
  },
  stdin: {
    isTTY: false,
    isRaw: false,
    setRawMode: vi.fn(),
  },
  createInterface: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('GthCustomToolkit', () => {
  let GthCustomToolkit: typeof import('#src/tools/GthCustomToolkit.js').default;
  let toolkit: InstanceType<typeof import('#src/tools/GthCustomToolkit.js').default>;

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

    systemUtilsMock.stdin.isTTY = false;
    systemUtilsMock.stdin.isRaw = false;

    // Default readline mock - reject by default
    mockRlQuestion.mockResolvedValue('n');
    mockRlClose.mockImplementation(() => {});
    systemUtilsMock.createInterface.mockReturnValue({
      question: mockRlQuestion,
      close: mockRlClose,
    });

    ({ default: GthCustomToolkit } = await import('#src/tools/GthCustomToolkit.js'));
  });

  describe('constructor', () => {
    it('should initialize with provided custom tools', () => {
      const customTools = {
        deploy_staging: {
          command: 'npm run deploy:staging',
          description: 'Deploy to staging environment',
        },
      };
      toolkit = new GthCustomToolkit(customTools);
      expect(toolkit).toBeDefined();
      expect(toolkit.tools).toBeDefined();
      expect(toolkit.tools.length).toBe(1);
    });

    it('should initialize with empty tools when no config provided', () => {
      toolkit = new GthCustomToolkit({});
      expect(toolkit.tools.length).toBe(0);
    });

    it('should create tools for custom commands with parameters', () => {
      toolkit = new GthCustomToolkit({
        run_migration: {
          command: 'npm run migrate -- ${migrationName}',
          description: 'Run a specific database migration',
          parameters: {
            migrationName: {
              description: 'Name of the migration to run',
            },
          },
        },
      });

      expect(toolkit.tools.length).toBe(1);
      expect(toolkit.tools[0].name).toBe('run_migration');
    });

    it('should create multiple custom command tools', () => {
      toolkit = new GthCustomToolkit({
        deploy_staging: {
          command: 'npm run deploy:staging',
          description: 'Deploy to staging',
        },
        deploy_prod: {
          command: 'npm run deploy:prod',
          description: 'Deploy to production',
        },
        run_e2e: {
          command: 'npm run e2e',
          description: 'Run E2E tests',
        },
      });

      expect(toolkit.tools.length).toBe(3);
      const toolNames = toolkit.tools.map((t) => t.name);
      expect(toolNames).toContain('deploy_staging');
      expect(toolNames).toContain('deploy_prod');
      expect(toolNames).toContain('run_e2e');
    });
  });

  describe('validateParameterValue', () => {
    beforeEach(() => {
      toolkit = new GthCustomToolkit({});
    });

    it('should allow valid parameter values', () => {
      expect(toolkit.validateParameterValue('valid_value', 'param')).toBe('valid_value');
      expect(toolkit.validateParameterValue('some/path/file.txt', 'param')).toBe(
        path.normalize('some/path/file.txt')
      );
    });

    it('should throw on absolute paths', () => {
      expect(() => toolkit.validateParameterValue('/absolute/path', 'myParam')).toThrow(
        "Absolute paths are not allowed for parameter 'myParam'"
      );
    });

    it('should throw on directory traversal attempts', () => {
      expect(() => toolkit.validateParameterValue('../secret', 'myParam')).toThrow(
        "Directory traversal attempts are not allowed in parameter 'myParam'"
      );
      expect(() => toolkit.validateParameterValue('dir/../../secret', 'myParam')).toThrow(
        "Directory traversal attempts are not allowed in parameter 'myParam'"
      );
    });

    it('should throw on shell injection attempts', () => {
      expect(() => toolkit.validateParameterValue('value|evil', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
      expect(() => toolkit.validateParameterValue('value;evil', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
      expect(() => toolkit.validateParameterValue('value&evil', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
      expect(() => toolkit.validateParameterValue('value`evil`', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
      expect(() => toolkit.validateParameterValue('value$VAR', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
      expect(() => toolkit.validateParameterValue('value$(cmd)', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
    });

    it('should throw on null bytes', () => {
      expect(() => toolkit.validateParameterValue('value\0evil', 'param')).toThrow(
        "Null bytes are not allowed in parameter 'param'"
      );
    });

    it('should throw on newlines', () => {
      expect(() => toolkit.validateParameterValue('value\nevil', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
      expect(() => toolkit.validateParameterValue('value\revil', 'param')).toThrow(
        "Shell injection attempts are not allowed in parameter 'param'"
      );
    });

    describe('with allow list', () => {
      it('should allow absolute paths when absolute-paths is in allow list', () => {
        const result = toolkit.validateParameterValue('/dev/ttyUSB0', 'device', ['absolute-paths']);
        expect(result).toBe('/dev/ttyUSB0');
      });

      it('should still block directory traversal when only absolute-paths is allowed', () => {
        expect(() =>
          toolkit.validateParameterValue('/dev/../etc/passwd', 'device', ['absolute-paths'])
        ).toThrow("Directory traversal attempts are not allowed in parameter 'device'");
      });

      it('should allow directory traversal when directory-traversal is in allow list', () => {
        const result = toolkit.validateParameterValue('dir/../file.txt', 'param', [
          'directory-traversal',
        ]);
        expect(result).toBe(path.normalize('dir/../file.txt'));
      });

      it('should allow shell metacharacters when shell-injection is in allow list', () => {
        const result = toolkit.validateParameterValue('value|other', 'param', ['shell-injection']);
        expect(result).toBe('value|other');
      });

      it('should allow null bytes when null-bytes is in allow list', () => {
        const result = toolkit.validateParameterValue('value\0other', 'param', ['null-bytes']);
        expect(result).toBe(path.normalize('value\0other'));
      });

      it('should allow multiple checks to be skipped simultaneously', () => {
        const result = toolkit.validateParameterValue('/dev/ttyUSB0', 'device', [
          'absolute-paths',
          'shell-injection',
        ]);
        expect(result).toBe('/dev/ttyUSB0');
      });

      it('should still enforce checks not in allow list', () => {
        expect(() =>
          toolkit.validateParameterValue('/dev/ttyUSB0;evil', 'device', ['absolute-paths'])
        ).toThrow("Shell injection attempts are not allowed in parameter 'device'");
      });
    });
  });

  describe('buildCustomCommand', () => {
    beforeEach(() => {
      toolkit = new GthCustomToolkit({});
    });

    it('should build command without parameters', () => {
      const result = toolkit.buildCustomCommand('npm run deploy', {}, undefined);
      expect(result).toBe('npm run deploy');
    });

    it('should build command with placeholder interpolation', () => {
      const result = toolkit.buildCustomCommand(
        'npm run migrate -- ${migrationName}',
        { migrationName: 'add_users_table' },
        { migrationName: { description: 'Migration name' } }
      );
      expect(result).toBe('npm run migrate -- add_users_table');
    });

    it('should build command with multiple placeholder interpolations', () => {
      const result = toolkit.buildCustomCommand(
        'docker run ${imageName}:${tag}',
        { imageName: 'myapp', tag: 'latest' },
        { imageName: { description: 'Image name' }, tag: { description: 'Image tag' } }
      );
      expect(result).toBe('docker run myapp:latest');
    });

    it('should append parameters when no placeholders present', () => {
      const result = toolkit.buildCustomCommand(
        'npm run script',
        { arg1: 'value1', arg2: 'value2' },
        { arg1: { description: 'First arg' }, arg2: { description: 'Second arg' } }
      );
      expect(result).toBe('npm run script value1 value2');
    });

    it('should validate parameters before interpolation', () => {
      expect(() =>
        toolkit.buildCustomCommand(
          'npm run migrate -- ${name}',
          { name: '../evil' },
          { name: { description: 'Name' } }
        )
      ).toThrow("Directory traversal attempts are not allowed in parameter 'name'");
    });

    it('should handle repeated placeholders', () => {
      const result = toolkit.buildCustomCommand(
        'echo ${value} and ${value} again',
        { value: 'test' },
        { value: { description: 'Value' } }
      );
      expect(result).toBe('echo test and test again');
    });

    it('should use parameter-level allow list for validation', () => {
      const result = toolkit.buildCustomCommand(
        'mpremote connect ${usbDevice} fs cp ${lesson} :main.py',
        { usbDevice: '/dev/ttyUSB0', lesson: 'fixed/lesson5/Move_Dance1.py' },
        {
          usbDevice: { description: 'USB device', allow: ['absolute-paths'] },
          lesson: { description: 'Lesson file' },
        }
      );
      expect(result).toBe(
        'mpremote connect /dev/ttyUSB0 fs cp fixed/lesson5/Move_Dance1.py :main.py'
      );
    });

    it('should use parameter-level allow list for appended parameters', () => {
      const result = toolkit.buildCustomCommand(
        'mpremote connect',
        { device: '/dev/ttyUSB0' },
        { device: { description: 'Device', allow: ['absolute-paths'] } }
      );
      expect(result).toBe('mpremote connect /dev/ttyUSB0');
    });
  });

  describe('custom command tool invocation', () => {
    it('should invoke custom command without parameters', async () => {
      toolkit = new GthCustomToolkit({
        deploy: {
          command: 'npm run deploy',
          description: 'Deploy the application',
        },
      });

      const tool = toolkit.tools.find((t) => t.name === 'deploy')!;
      const result = await tool.invoke({});
      expect(result).toContain("Command 'npm run deploy' completed successfully");
      expect(childProcessMock.spawn).toHaveBeenCalledWith('npm run deploy', { shell: true });
    });

    it('should invoke custom command with parameters using placeholders', async () => {
      toolkit = new GthCustomToolkit({
        run_migration: {
          command: 'npm run migrate -- ${migrationName}',
          description: 'Run migration',
          parameters: {
            migrationName: { description: 'Migration name' },
          },
        },
      });

      const tool = toolkit.tools.find((t) => t.name === 'run_migration')!;
      const result = await tool.invoke({ migrationName: 'add_users' });
      expect(result).toContain("Command 'npm run migrate -- add_users' completed successfully");
    });

    it('should invoke custom command with multiple parameters', async () => {
      toolkit = new GthCustomToolkit({
        docker_build: {
          command: 'docker build -t ${imageName}:${tag} .',
          description: 'Build Docker image',
          parameters: {
            imageName: { description: 'Image name' },
            tag: { description: 'Image tag' },
          },
        },
      });

      const tool = toolkit.tools.find((t) => t.name === 'docker_build')!;
      const result = await tool.invoke({ imageName: 'myapp', tag: 'v1.0.0' });
      expect(result).toContain("Command 'docker build -t myapp:v1.0.0 .' completed successfully");
    });

    it('should prompt user when validation fails and reject on denial', async () => {
      toolkit = new GthCustomToolkit({
        run_script: {
          command: 'npm run ${scriptName}',
          description: 'Run a script',
          parameters: {
            scriptName: { description: 'Script name' },
          },
        },
      });

      mockRlQuestion.mockResolvedValue('n');

      const tool = toolkit.tools.find((t) => t.name === 'run_script')!;
      await expect(tool.invoke({ scriptName: 'evil;rm -rf /' })).rejects.toThrow(
        "Execution of 'run_script' was rejected by user"
      );

      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed')
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('The agent is trying to execute:')
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('"allow"')
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('.gsloth.config.json')
      );
    });

    it('should execute command when user approves validation override', async () => {
      toolkit = new GthCustomToolkit({
        deploy_lesson: {
          command: 'mpremote connect ${usbDevice} fs cp ${lesson} :main.py',
          description: 'Deploy lesson to robot',
          parameters: {
            usbDevice: { description: 'USB device' },
            lesson: { description: 'Lesson file' },
          },
        },
      });

      mockRlQuestion.mockResolvedValue('y');

      const tool = toolkit.tools.find((t) => t.name === 'deploy_lesson')!;
      const result = await tool.invoke({
        usbDevice: '/dev/ttyUSB0',
        lesson: 'fixed/lesson5/Move_Dance1.py',
      });

      expect(result).toContain('completed successfully');
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed')
      );
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        'mpremote connect /dev/ttyUSB0 fs cp fixed/lesson5/Move_Dance1.py :main.py',
        { shell: true }
      );
    });

    it('should skip validation and not prompt when parameter-level allow config is provided', async () => {
      toolkit = new GthCustomToolkit({
        deploy_lesson: {
          command: 'mpremote connect ${usbDevice} fs cp ${lesson} :main.py',
          description: 'Deploy lesson to robot',
          parameters: {
            usbDevice: { description: 'USB device', allow: ['absolute-paths'] },
            lesson: { description: 'Lesson file' },
          },
        },
      });

      const tool = toolkit.tools.find((t) => t.name === 'deploy_lesson')!;
      const result = await tool.invoke({
        usbDevice: '/dev/ttyUSB0',
        lesson: 'fixed/lesson5/Move_Dance1.py',
      });

      expect(result).toContain('completed successfully');
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(systemUtilsMock.createInterface).not.toHaveBeenCalled();
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        'mpremote connect /dev/ttyUSB0 fs cp fixed/lesson5/Move_Dance1.py :main.py',
        { shell: true }
      );
    });

    it('should include command in tool description', () => {
      toolkit = new GthCustomToolkit({
        my_command: {
          command: 'echo hello',
          description: 'Say hello',
        },
      });

      const tool = toolkit.tools.find((t) => t.name === 'my_command')!;
      expect(tool.description).toContain('Say hello');
      expect(tool.description).toContain('[echo hello]');
    });
  });

  describe('promptUserForValidationOverride', () => {
    beforeEach(() => {
      toolkit = new GthCustomToolkit({});
    });

    it('should return true when user answers y', async () => {
      mockRlQuestion.mockResolvedValue('y');
      const result = await toolkit.promptUserForValidationOverride(
        'some command',
        'tool_name',
        'validation error'
      );
      expect(result).toBe(true);
      expect(mockRlClose).toHaveBeenCalled();
    });

    it('should return true when user answers yes', async () => {
      mockRlQuestion.mockResolvedValue('yes');
      const result = await toolkit.promptUserForValidationOverride(
        'some command',
        'tool_name',
        'validation error'
      );
      expect(result).toBe(true);
    });

    it('should return false when user answers n', async () => {
      mockRlQuestion.mockResolvedValue('n');
      const result = await toolkit.promptUserForValidationOverride(
        'some command',
        'tool_name',
        'validation error'
      );
      expect(result).toBe(false);
    });

    it('should return false when user answers empty string', async () => {
      mockRlQuestion.mockResolvedValue('');
      const result = await toolkit.promptUserForValidationOverride(
        'some command',
        'tool_name',
        'validation error'
      );
      expect(result).toBe(false);
    });

    it('should display warnings with command and config advice', async () => {
      mockRlQuestion.mockResolvedValue('n');
      await toolkit.promptUserForValidationOverride(
        'mpremote connect /dev/ttyUSB0 fs cp lesson.py :main.py',
        'deploy_lesson',
        'Absolute paths are not allowed'
      );

      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining("Validation failed for tool 'deploy_lesson'")
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('mpremote connect /dev/ttyUSB0 fs cp lesson.py :main.py')
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('"allow"')
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('.gsloth.config.json')
      );
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('"absolute-paths"')
      );
      // Verify (permanent) label on the config advice
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('(permanent)')
      );
      // Verify (one-time) label on the interactive prompt written to stdout
      expect(systemUtilsMock.stdout.write).toHaveBeenCalledWith(
        expect.stringContaining('(one-time)')
      );
      // Verify rl.question is called with empty string (prompt written separately)
      expect(mockRlQuestion).toHaveBeenCalledWith('');
    });

    it('should temporarily disable raw mode while asking for approval', async () => {
      systemUtilsMock.stdin.isTTY = true;
      systemUtilsMock.stdin.isRaw = true;
      mockRlQuestion.mockResolvedValue('y');

      const result = await toolkit.promptUserForValidationOverride('cmd', 'tool', 'error');

      expect(result).toBe(true);
      expect(systemUtilsMock.stdin.setRawMode).toHaveBeenNthCalledWith(1, false);
      expect(systemUtilsMock.stdin.setRawMode).toHaveBeenNthCalledWith(2, true);
    });

    it('should not change raw mode when stdin is not currently raw', async () => {
      systemUtilsMock.stdin.isTTY = true;
      systemUtilsMock.stdin.isRaw = false;
      mockRlQuestion.mockResolvedValue('y');

      await toolkit.promptUserForValidationOverride('cmd', 'tool', 'error');

      expect(systemUtilsMock.stdin.setRawMode).not.toHaveBeenCalled();
    });

    it('should restore raw mode even if question throws', async () => {
      systemUtilsMock.stdin.isTTY = true;
      systemUtilsMock.stdin.isRaw = true;
      mockRlQuestion.mockRejectedValue(new Error('readline error'));

      await expect(toolkit.promptUserForValidationOverride('cmd', 'tool', 'error')).rejects.toThrow(
        'readline error'
      );

      expect(mockRlClose).toHaveBeenCalled();
      expect(systemUtilsMock.stdin.setRawMode).toHaveBeenNthCalledWith(1, false);
      expect(systemUtilsMock.stdin.setRawMode).toHaveBeenNthCalledWith(2, true);
    });

    it('should close readline interface even if question throws', async () => {
      mockRlQuestion.mockRejectedValue(new Error('readline error'));
      await expect(toolkit.promptUserForValidationOverride('cmd', 'tool', 'error')).rejects.toThrow(
        'readline error'
      );
      expect(mockRlClose).toHaveBeenCalled();
    });
  });

  describe('executeCommand', () => {
    beforeEach(() => {
      toolkit = new GthCustomToolkit({});
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

    it('should kill command after timeout and report timeout message', async () => {
      vi.useFakeTimers();
      const mockKill = vi.fn();
      let closeCallback: ((_code: number | null) => void) | undefined;
      const mockChild = {
        on: vi.fn((event: string, callback: (_arg: any) => void) => {
          if (event === 'close') closeCallback = callback;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        kill: mockKill,
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      const resultPromise = toolkit['executeCommand']('slow cmd', 'test_tool', 10);

      // Advance past timeout
      vi.advanceTimersByTime(10_000);

      // Simulate the close event that follows child.kill()
      expect(mockKill).toHaveBeenCalled();
      closeCallback?.(null);

      const result = await resultPromise;
      expect(result).toContain("Command 'slow cmd' timed out after 10 seconds");

      vi.useRealTimers();
    });

    it('should not timeout when timeoutSeconds is not provided', async () => {
      const result = await toolkit['executeCommand']('echo test', 'test_tool');
      expect(result).toContain("Command 'echo test' completed successfully");
      expect(result).not.toContain('timed out');
    });
  });

  describe('custom command tool invocation with timeout', () => {
    it('should pass timeout from config to executeCommand', async () => {
      vi.useFakeTimers();
      const mockKill = vi.fn();
      let closeCallback: ((_code: number | null) => void) | undefined;
      const mockChild = {
        on: vi.fn((event: string, callback: (_arg: any) => void) => {
          if (event === 'close') closeCallback = callback;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        kill: mockKill,
      };
      childProcessMock.spawn.mockReturnValueOnce(mockChild as any);

      toolkit = new GthCustomToolkit({
        slow_deploy: {
          command: 'npm run deploy',
          description: 'Deploy (slow)',
          timeout: 5,
        },
      });

      const tool = toolkit.tools.find((t) => t.name === 'slow_deploy')!;
      const resultPromise = tool.invoke({});

      // advanceTimersByTimeAsync flushes microtasks (LangChain async chain) before advancing
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockKill).toHaveBeenCalled();
      closeCallback?.(null);

      const result = await resultPromise;
      expect(result).toContain('timed out after 5 seconds');

      vi.useRealTimers();
    });
  });
});
