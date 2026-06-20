import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

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
const systemUtilsMock = {
  stdout: {
    write: vi.fn(),
  },
  getCurrentWorkDir: vi.fn(() => '/test/project'),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

// Mock GthFileSystemToolkit
vi.mock('#src/tools/GthFileSystemToolkit.js', () => ({
  default: class MockGthFileSystemToolkit {
    getTools() {
      return [];
    }
    getFilteredTools() {
      return [];
    }
  },
}));

// Mock built-in tools
vi.mock('#src/tools/gthStatusUpdateTool.js', () => ({
  get: () => ({ name: 'gth_status_update', invoke: vi.fn() }),
}));

describe('Custom Tools Configuration', () => {
  let getDefaultTools: typeof import('#src/builtInToolsConfig.js').getDefaultTools;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Mock spawn to simulate successful command
    const mockChild = {
      on: vi.fn((event, callback) => {
        if (event === 'close') callback(0);
      }),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };
    childProcessMock.spawn.mockReturnValue(mockChild as any);

    ({ getDefaultTools } = await import('#src/builtInToolsConfig.js'));
  });

  const createMockConfig = (overrides: Partial<GthConfig> = {}): GthConfig => ({
    llm: {} as BaseChatModel,
    contentSource: 'github',
    requirementSource: 'github',
    contentProvider: 'github',
    requirementsProvider: 'github',
    projectGuidelines: '.gsloth.guidelines.md',
    includeCurrentDateAfterGuidelines: false,
    projectReviewInstructions: '',
    filesystem: 'none',
    streamOutput: true,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: true,
    useColour: true,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: true,
    ...overrides,
  });

  describe('root-level customTools', () => {
    it('should load custom tools from root config', async () => {
      const config = createMockConfig({
        customTools: {
          deploy: {
            command: 'npm run deploy',
            description: 'Deploy the application',
          },
        },
      });

      const tools = await getDefaultTools(config, 'code');
      const customTool = tools.find((t) => t.name === 'deploy');
      expect(customTool).toBeDefined();
      expect(customTool?.description).toContain('Deploy the application');
    });

    it('should load multiple custom tools', async () => {
      const config = createMockConfig({
        customTools: {
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
        },
      });

      const tools = await getDefaultTools(config, 'pr');
      const customToolNames = tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('deploy') || n === 'run_e2e');
      expect(customToolNames).toContain('deploy_staging');
      expect(customToolNames).toContain('deploy_prod');
      expect(customToolNames).toContain('run_e2e');
    });

    it('should make custom tools available to all commands by default', async () => {
      const config = createMockConfig({
        customTools: {
          my_tool: {
            command: 'echo test',
            description: 'Test tool',
          },
        },
      });

      // Test with different commands
      for (const command of ['code', 'pr', 'review', 'ask', 'chat']) {
        const tools = await getDefaultTools(config, command as any);
        const customTool = tools.find((t) => t.name === 'my_tool');
        expect(customTool).toBeDefined();
      }
    });

    it('should return no tools when customTools is empty', async () => {
      const config = createMockConfig({
        customTools: {},
      });

      const tools = await getDefaultTools(config, 'code');
      const customTools = tools.filter((t) => !t.name?.startsWith('gth_'));
      expect(customTools.length).toBe(0);
    });

    it('should return no tools when customTools is undefined', async () => {
      const config = createMockConfig();

      const tools = await getDefaultTools(config, 'code');
      const customTools = tools.filter(
        (t) => !t.name?.startsWith('gth_') && !t.name?.startsWith('run_')
      );
      expect(customTools.length).toBe(0);
    });
  });

  describe('per-command customTools overrides', () => {
    it('should use command-specific customTools when provided', async () => {
      const config = createMockConfig({
        customTools: {
          global_tool: {
            command: 'echo global',
            description: 'Global tool',
          },
        },
        commands: {
          code: {
            customTools: {
              code_tool: {
                command: 'echo code',
                description: 'Code-specific tool',
              },
            },
          },
        },
      });

      const tools = await getDefaultTools(config, 'code');
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('code_tool');
      expect(toolNames).not.toContain('global_tool');
    });

    it('should use root customTools when command has no override', async () => {
      const config = createMockConfig({
        customTools: {
          global_tool: {
            command: 'echo global',
            description: 'Global tool',
          },
        },
        commands: {
          pr: {
            // No customTools override
          },
        },
      });

      const tools = await getDefaultTools(config, 'pr');
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('global_tool');
    });

    it('should disable custom tools when set to false', async () => {
      const config = createMockConfig({
        customTools: {
          global_tool: {
            command: 'echo global',
            description: 'Global tool',
          },
        },
        commands: {
          review: {
            customTools: false,
          },
        },
      });

      const tools = await getDefaultTools(config, 'review');
      const customTool = tools.find((t) => t.name === 'global_tool');
      expect(customTool).toBeUndefined();
    });

    it('should disable custom tools when set to empty object', async () => {
      const config = createMockConfig({
        customTools: {
          global_tool: {
            command: 'echo global',
            description: 'Global tool',
          },
        },
        commands: {
          ask: {
            customTools: {},
          },
        },
      });

      const tools = await getDefaultTools(config, 'ask');
      const customTool = tools.find((t) => t.name === 'global_tool');
      expect(customTool).toBeUndefined();
    });

    it('should support different tools for different commands', async () => {
      const config = createMockConfig({
        customTools: {
          global_tool: {
            command: 'echo global',
            description: 'Global tool',
          },
        },
        commands: {
          pr: {
            customTools: {
              pr_specific: {
                command: 'echo pr',
                description: 'PR tool',
              },
            },
          },
          review: {
            customTools: {
              review_specific: {
                command: 'echo review',
                description: 'Review tool',
              },
            },
          },
        },
      });

      const prTools = await getDefaultTools(config, 'pr');
      const prToolNames = prTools.map((t) => t.name);
      expect(prToolNames).toContain('pr_specific');
      expect(prToolNames).not.toContain('global_tool');
      expect(prToolNames).not.toContain('review_specific');

      const reviewTools = await getDefaultTools(config, 'review');
      const reviewToolNames = reviewTools.map((t) => t.name);
      expect(reviewToolNames).toContain('review_specific');
      expect(reviewToolNames).not.toContain('global_tool');
      expect(reviewToolNames).not.toContain('pr_specific');
    });
  });

  describe('integration with dev tools', () => {
    it('should load both custom tools and dev tools in code command', async () => {
      const config = createMockConfig({
        customTools: {
          custom_deploy: {
            command: 'npm run deploy',
            description: 'Deploy',
          },
        },
        commands: {
          code: {
            devTools: {
              run_tests: 'npm test',
              run_lint: 'npm run lint',
            },
          },
        },
      });

      const tools = await getDefaultTools(config, 'code');
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('custom_deploy');
      expect(toolNames).toContain('run_tests');
      expect(toolNames).toContain('run_lint');
    });

    it('should support separate dev tools and custom tools', async () => {
      const config = createMockConfig({
        customTools: {
          deploy: {
            command: 'npm run deploy',
            description: 'Deploy',
          },
        },
        commands: {
          code: {
            devTools: {
              run_tests: 'npm test',
            },
            customTools: {
              code_custom: {
                command: 'echo code',
                description: 'Code custom',
              },
            },
          },
        },
      });

      const tools = await getDefaultTools(config, 'code');
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('code_custom');
      expect(toolNames).toContain('run_tests');
      expect(toolNames).not.toContain('deploy'); // Overridden by command-specific
    });
  });

  describe('custom tools with parameters', () => {
    it('should support custom tools with parameters', async () => {
      const config = createMockConfig({
        customTools: {
          run_migration: {
            command: 'npm run migrate -- ${migrationName}',
            description: 'Run migration',
            parameters: {
              migrationName: {
                description: 'Name of the migration',
              },
            },
          },
        },
      });

      const tools = await getDefaultTools(config, 'code');
      const tool = tools.find((t) => t.name === 'run_migration');
      expect(tool).toBeDefined();

      // Invoke the tool with parameters
      const result = await tool!.invoke({ migrationName: 'add_users' });
      expect(result).toContain('npm run migrate -- add_users');
    });
  });
});
