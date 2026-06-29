import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, GraphInterrupt, MemorySaver } from '@langchain/langgraph';
import type { GthConfig } from '#src/config.js';
import type { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import { FakeListChatModel, FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StatusLevel, type StatusUpdateCallback } from '#src/core/types.js';

const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  stopWaitingForEscape: vi.fn(),
  waitForEscape: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const configMock = {
  getDefaultTools: vi.fn(),
};
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: configMock.getDefaultTools,
}));

const ProgressIndicatorMock = vi.fn(function ProgressIndicatorMock() {
  return ProgressIndicatorInstanceMock;
});
const ProgressIndicatorInstanceMock = {
  stop: vi.fn(),
  indicate: vi.fn(),
};
vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: ProgressIndicatorMock,
}));

const multiServerMCPClientMock = vi.fn(function MultiServerMCPClientMock() {
  return mcpClientInstanceMock;
});
const mcpClientInstanceMock = {
  getTools: vi.fn(),
  close: vi.fn(),
};
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: multiServerMCPClientMock,
}));

const createAuthProviderAndAuthenticateMock = vi.fn();
vi.mock('#src/mcp/OAuthClientProviderImpl.js', () => ({
  createAuthProviderAndAuthenticate: createAuthProviderAndAuthenticateMock,
}));

const consoleUtilsMock = {
  displayInfo: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const binaryOutputUtilsMock = {
  extractInlineBinaryBlocks: vi.fn(),
  materializeBinaryOutputs: vi.fn(),
  renderAssistantContent: vi.fn(),
};
vi.mock('#src/utils/binaryOutputUtils.js', () => binaryOutputUtilsMock);

// Mock createAgent from langchain
const createAgentMock = vi.fn();
const toolStrategyMock = vi.fn();
const agentMock = {
  invoke: vi.fn(),
  stream: vi.fn(),
};
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return {
    ...actual,
    createAgent: createAgentMock,
    toolStrategy: toolStrategyMock,
    summarizationMiddleware: vi.fn(),
    anthropicPromptCachingMiddleware: vi.fn(),
  };
});

// Mock middleware registry
const resolveMiddlewareMock = vi.fn();
vi.mock('#src/middleware/registry.js', () => ({
  resolveMiddleware: resolveMiddlewareMock,
}));

describe('GthLangChainAgent', () => {
  let GthLangChainAgent: typeof import('#src/core/GthLangChainAgent.js').GthLangChainAgent;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let mockConfig: GthConfig;

  beforeEach(async () => {
    vi.resetAllMocks();

    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/test/dir');
    multiServerMCPClientMock.mockImplementation(function () {
      return mcpClientInstanceMock;
    });
    mcpClientInstanceMock.getTools.mockReset();
    mcpClientInstanceMock.close.mockReset();
    ProgressIndicatorMock.mockClear();
    ProgressIndicatorInstanceMock.stop.mockReset();
    ProgressIndicatorInstanceMock.indicate.mockReset();
    binaryOutputUtilsMock.extractInlineBinaryBlocks.mockReset();
    binaryOutputUtilsMock.materializeBinaryOutputs.mockReset();
    binaryOutputUtilsMock.renderAssistantContent.mockReset();
    binaryOutputUtilsMock.extractInlineBinaryBlocks.mockReturnValue([]);
    binaryOutputUtilsMock.materializeBinaryOutputs.mockImplementation((content: unknown) => ({
      renderedContent: typeof content === 'string' ? content : JSON.stringify(content),
      successMessages: [],
    }));
    binaryOutputUtilsMock.renderAssistantContent.mockImplementation((content: unknown) =>
      typeof content === 'string' ? content : JSON.stringify(content)
    );

    // Setup middleware mock
    resolveMiddlewareMock.mockResolvedValue([]);

    // Setup createAgent mock
    createAgentMock.mockReturnValue(agentMock);
    toolStrategyMock.mockReturnValue({ type: 'tool_strategy', schema: {} });
    agentMock.invoke.mockResolvedValue({
      messages: [{ content: 'test response' }],
    });
    agentMock.stream.mockResolvedValue([]);

    // Setup config mocks
    configMock.getDefaultTools.mockResolvedValue([]);

    statusUpdateCallback = vi.fn();

    mockConfig = {
      projectGuidelines: 'test guidelines',
      llm: {
        _llmType: vi.fn().mockReturnValue('test'),
        verbose: false,
        bindTools: vi.fn(),
      } as any,
      streamOutput: false,
      contentSource: 'file',
      requirementSource: 'file',
      projectReviewInstructions: '.gsloth.review.md',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: true,
      writeBinaryOutputsToFile: true,
      streamSessionInferenceLog: true,
      canInterruptInferenceWithEsc: true,
      includeCurrentDateAfterGuidelines: true,
    };

    ({ GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js'));
  });

  describe('constructor', () => {
    it('should initialize with status update callback', () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      expect(agent).toBeDefined();
    });
  });

  describe('init', () => {
    it('should initialize with basic configuration', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      mcpClientInstanceMock.getTools.mockResolvedValue([]);

      await agent.init(undefined, mockConfig);
    });

    it('should use command-specific filesystem config', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const configWithCommands = {
        ...mockConfig,
        commands: {
          code: {
            filesystem: ['read_file', 'write_file'],
          },
        },
      };

      await agent.init('code', configWithCommands);

      expect(agent['config']?.filesystem).toEqual(['read_file', 'write_file']);
    });

    it('should display loaded tools as comma-separated list', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const mockTools = [
        { name: 'custom_tool_1', invoke: vi.fn(), description: 'Test tool 1' },
        { name: 'custom_tool_2', invoke: vi.fn(), description: 'Test tool 2' },
        { name: 'custom_tool_3', invoke: vi.fn(), description: 'Test tool 3' },
      ] as Partial<StructuredToolInterface>[];

      const configWithTools = {
        ...mockConfig,
        tools: mockTools,
        filesystem: 'none',
      } as GthConfig;

      mcpClientInstanceMock.getTools.mockResolvedValue([]);

      await agent.init(undefined, configWithTools);

      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.INFO,
        'Loaded tools: custom_tool_1, custom_tool_2, custom_tool_3'
      );
    });

    it('should initialize with checkpoint saver', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const checkpointSaver = new MemorySaver();
      mcpClientInstanceMock.getTools.mockResolvedValue([]);

      await agent.init(undefined, mockConfig, checkpointSaver);
    });

    it('should flatten toolkits into individual tools', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      // Toolkit has one single method - getTools
      const mockToolkit = {
        getTools: () => [
          { name: 'custom_tool_1' } as StructuredToolInterface,
          { name: 'custom_tool_2' } as StructuredToolInterface,
        ],
      } as BaseToolkit;
      const mockTool = { name: 'gth_status_update' } as StructuredToolInterface;

      const configWithTools = {
        ...mockConfig,
        tools: [mockToolkit, mockTool],
      } as GthConfig;

      mcpClientInstanceMock.getTools.mockResolvedValue([]);

      await agent.init(undefined, configWithTools);
    });

    it('should combine toolkit tools with MCP tools', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const mockToolkit = {
        getTools: () => [{ name: 'custom_tool' } as StructuredToolInterface],
      };

      const configWithTools = {
        ...mockConfig,
        tools: [mockToolkit],
      } as GthConfig;

      const mcpTools = [{ name: 'mcp__filesystem__list_directory' } as StructuredToolInterface];
      mcpClientInstanceMock.getTools.mockResolvedValue(mcpTools);

      await agent.init(undefined, configWithTools);
    });

    it('should filter resolved tools by the allowedTools allow-list', async () => {
      const resolveTools = vi
        .fn()
        .mockResolvedValue([
          { name: 'mcp__jira__getJiraIssue' },
          { name: 'mcp__jira__searchJiraIssuesUsingJql' },
          { name: 'gh_pr' },
        ] as StructuredToolInterface[]);
      const agent = new GthLangChainAgent(statusUpdateCallback, {
        resolveTools,
        resolveMiddleware: async (m) => m ?? [],
      });

      const config = {
        ...mockConfig,
        allowedTools: ['mcp__jira__getJiraIssue'],
      } as GthConfig;

      await agent.init(undefined, config);

      expect(resolveTools).toHaveBeenCalled();
      const toolsArg = createAgentMock.mock.calls.at(-1)?.[0].tools as StructuredToolInterface[];
      expect(toolsArg.map((t) => t.name)).toEqual(['mcp__jira__getJiraIssue']);
    });

    it('retains nameless server tools when an allowedTools allow-list is set', async () => {
      const resolveTools = vi.fn().mockResolvedValue([]);
      const agent = new GthLangChainAgent(statusUpdateCallback, {
        resolveTools,
        resolveMiddleware: async (m) => m ?? [],
      });

      const config = {
        ...mockConfig,
        // A ServerTool (provider-native "magic object") with no name alongside a named tool.
        tools: [
          { type: 'web_search_20250305' },
          { name: 'gh_pr' },
        ] as unknown as StructuredToolInterface[],
        allowedTools: ['gh_pr'],
      } as GthConfig;

      await agent.init(undefined, config);

      const toolsArg = createAgentMock.mock.calls.at(-1)?.[0].tools as StructuredToolInterface[];
      // The nameless server tool can never be named in the allow-list, so it is retained rather
      // than silently dropped; the named tool is still filtered normally.
      expect(toolsArg).toHaveLength(2);
      expect(toolsArg.map((t) => t.name)).toContain('gh_pr');
      expect(toolsArg.some((t) => !t.name)).toBe(true);
    });

    it('should disable all tools and skip resolution when allowedTools is empty', async () => {
      const resolveTools = vi
        .fn()
        .mockResolvedValue([{ name: 'gh_pr' }] as StructuredToolInterface[]);
      const agent = new GthLangChainAgent(statusUpdateCallback, {
        resolveTools,
        resolveMiddleware: async (m) => m ?? [],
      });

      const config = {
        ...mockConfig,
        tools: [{ name: 'cfg_tool' } as StructuredToolInterface],
        allowedTools: [],
      } as GthConfig;

      await agent.init(undefined, config);

      // Empty allow-list must not contact MCP / trigger OAuth, so resolveTools is skipped.
      expect(resolveTools).not.toHaveBeenCalled();
      const toolsArg = createAgentMock.mock.calls.at(-1)?.[0].tools as StructuredToolInterface[];
      expect(toolsArg).toEqual([]);
      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.INFO,
        'Tool loading disabled by allowedTools: []; MCP/A2A servers will not be contacted. Omit allowedTools for no filtering.'
      );
      expect(statusUpdateCallback).not.toHaveBeenCalledWith(
        StatusLevel.INFO,
        expect.stringContaining('Loaded tools')
      );
    });
  });

  describe('invoke', () => {
    it('should throw error if not initialized', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };

      await expect(agent.invoke([new HumanMessage('test')], runConfig)).rejects.toThrow(
        'Agent not initialized. Call init() first.'
      );
    });

    it('should invoke agent in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // Explicitly mock the agent response
      agentMock.invoke.mockResolvedValue({
        messages: [
          new AIMessage({
            content: 'test response',
          }),
        ],
      });

      const fakeListChatModel = new FakeListChatModel({
        responses: ['test response'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
      };
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      const result = await agent.invoke([new HumanMessage('test message')], runConfig);

      // Check for the display call, ignoring other info/warning messages
      const displayCalls = statusUpdateCallback.mock.calls.filter(
        (call) => call[0] === StatusLevel.DISPLAY
      );
      expect(displayCalls.length).toBeGreaterThan(0);
      expect(displayCalls[0]).toEqual([StatusLevel.DISPLAY, 'test response']);
      expect(result).toBe('test response');
    });

    it('should display tool usage in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // Mock agent to return a message with tool calls
      agentMock.invoke.mockResolvedValue({
        messages: [
          new AIMessage({
            content: 'test response',
            tool_calls: [
              { name: 'read_file', args: {}, id: '1' },
              { name: 'write_file', args: {}, id: '2' },
            ],
          }),
        ],
      });

      const fakeListChatModel = new FakeListChatModel({
        responses: ['test response'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
      };
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      await agent.invoke([new HumanMessage('test message')], runConfig);

      // Verify that agent.invoke was called with the correct parameters
      expect(agentMock.invoke).toHaveBeenCalledWith(
        { messages: [expect.any(HumanMessage)] },
        runConfig
      );
    });

    it('should handle errors in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // Mock agent to reject with an error
      agentMock.invoke.mockRejectedValue(new Error('Test error'));

      const fakeListChatModel = new FakeListChatModel({
        responses: [],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
      };
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      await expect(agent.invoke([new HumanMessage('test message')], runConfig)).rejects.toThrow(
        'Test error'
      );
      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.ERROR,
        expect.stringContaining('LLM invocation failed: Test error')
      );
      expect(ProgressIndicatorInstanceMock.stop).toHaveBeenCalled();
    });

    it('should invoke agent in non-streaming mode only', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({
        responses: ['test response'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
        streamOutput: true, // This should be ignored by invoke method
      };
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      const result = await agent.invoke([new HumanMessage('test message')], runConfig);

      // Check for the display call, ignoring other info/warning messages
      const displayCalls = statusUpdateCallback.mock.calls.filter(
        (call) => call[0] === StatusLevel.DISPLAY
      );
      expect(displayCalls.length).toBeGreaterThan(0);
      expect(displayCalls[0]).toEqual([StatusLevel.DISPLAY, 'test response']);
      expect(result).toBe('test response');
    });

    it('should display tool usage in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // Mock agent to return a message with a single tool call
      agentMock.invoke.mockResolvedValue({
        messages: [
          new AIMessage({
            content: 'response done',
            tool_calls: [{ name: 'read_file', args: {}, id: '1' }],
          }),
        ],
      });

      const fakeListChatModel = new FakeListChatModel({
        responses: ['response done'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
        streamOutput: false,
      };
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      await agent.invoke([new HumanMessage('test message')], runConfig);

      // Verify that agent.invoke was called with the correct parameters
      expect(agentMock.invoke).toHaveBeenCalledWith(
        { messages: [expect.any(HumanMessage)] },
        runConfig
      );
    });

    it('should handle multiple tool calls in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // Mock agent to return a message with multiple tool calls
      agentMock.invoke.mockResolvedValue({
        messages: [
          new AIMessage({
            content: 'chunk content bye',
            tool_calls: [
              { name: 'read_file', args: {}, id: '1' },
              { name: 'write_file', args: {}, id: '2' },
            ],
          }),
        ],
      });

      const fakeListChatModel = new FakeListChatModel({
        responses: ['chunk content bye'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const mockTools = [
        {
          name: 'read_file',
          description: 'Mock read file tool',
          invoke: vi.fn().mockResolvedValue('file content'),
        } as Partial<StructuredToolInterface>,
        {
          name: 'write_file',
          description: 'Mock write file tool',
          invoke: vi.fn().mockResolvedValue('write success'),
        } as Partial<StructuredToolInterface>,
      ];

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
        streamOutput: false,
        tools: mockTools,
      } as GthConfig;
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      await agent.invoke([new HumanMessage('test message')], runConfig);

      // Verify that agent.invoke was called with the correct parameters
      expect(agentMock.invoke).toHaveBeenCalledWith(
        { messages: [expect.any(HumanMessage)] },
        runConfig
      );
    });

    it('should handle ToolException errors in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const error = new Error('Tool failed');
      error.name = 'ToolException';

      const fakeListChatModel = new FakeListChatModel({
        responses: ['test response'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
        streamOutput: false,
      };
      await agent.init(undefined, config);

      const reactAgent = agent['agent'];
      if (reactAgent) {
        reactAgent.invoke = vi.fn().mockRejectedValue(error);
      }

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      const result = await agent.invoke([new HumanMessage('test message')], runConfig);
      expect(result).toBe('Tool execution failed: Tool failed');
      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.ERROR,
        'Tool execution failed: Tool failed'
      );
    });

    it('should pass run config to agent', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({
        responses: ['test response'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      const config = {
        ...mockConfig,
        llm: fakeListChatModel,
      };
      await agent.init(undefined, config);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      const result = await agent.invoke([new HumanMessage('test message')], runConfig);

      // Check for the display call to verify result
      const displayCalls = statusUpdateCallback.mock.calls.filter(
        (call) => call[0] === StatusLevel.DISPLAY
      );
      if (displayCalls.length > 0) {
        expect(displayCalls[0]).toEqual([StatusLevel.DISPLAY, 'test response']);
      }
      expect(result).toBe('test response');
    });

    it('should materialize binary outputs in non-streaming mode', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      agentMock.invoke.mockResolvedValue({
        messages: [
          new AIMessage({
            content: [{ type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'abc' } }],
          }),
        ],
      });
      binaryOutputUtilsMock.materializeBinaryOutputs.mockReturnValue({
        renderedContent: '[Binary model output saved: image/png -> /tmp/gth_test_ASK.png]',
        successMessages: ['Wrote model output (image/png) to /tmp/gth_test_ASK.png'],
      });

      const fakeListChatModel = new FakeListChatModel({
        responses: ['binary response'],
      });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      await agent.init('ask', { ...mockConfig, llm: fakeListChatModel });

      const result = await agent.invoke([new HumanMessage('test message')], {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      });

      expect(binaryOutputUtilsMock.materializeBinaryOutputs).toHaveBeenCalledWith(
        [{ type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'abc' } }],
        'ask'
      );
      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.DISPLAY,
        '[Binary model output saved: image/png -> /tmp/gth_test_ASK.png]'
      );
      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.SUCCESS,
        'Wrote model output (image/png) to /tmp/gth_test_ASK.png'
      );
      expect(result).toContain('/tmp/gth_test_ASK.png');
    });
  });

  describe('stream', () => {
    it('should throw error if not initialized', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };

      await expect(agent.stream([new HumanMessage('test')], runConfig)).rejects.toThrow(
        'Agent not initialized. Call init() first.'
      );
    });

    it('should stream agent responses', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // Mock agent stream to return an async generator
      const mockStreamChunks = [
        [new AIMessageChunk({ content: 'chunk1' }), {}],
        [new AIMessageChunk({ content: 'chunk2' }), {}],
      ];

      async function* mockStreamGenerator() {
        for (const chunk of mockStreamChunks) {
          yield chunk;
        }
      }

      agentMock.stream.mockResolvedValue(mockStreamGenerator());

      const fakeStreamingChatModel = new FakeStreamingChatModel({
        chunks: [
          new AIMessageChunk({ content: 'chunk1' }),
          new AIMessageChunk({ content: 'chunk2' }),
        ],
      });
      fakeStreamingChatModel.bindTools = vi.fn().mockReturnValue(fakeStreamingChatModel);

      const streamConfig = {
        ...mockConfig,
        llm: fakeStreamingChatModel,
        streamOutput: true,
      };
      await agent.init(undefined, streamConfig);

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      };
      const stream = await agent.stream([new HumanMessage('test message')], runConfig);

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['chunk1', 'chunk2']);
    });

    it('should unregister the Escape listener when stream creation fails', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      // E.g. an expired-auth error thrown while initiating the stream, before any chunk.
      agentMock.stream.mockRejectedValue(new Error('invalid_grant'));

      const fakeStreamingChatModel = new FakeStreamingChatModel({ chunks: [] });
      fakeStreamingChatModel.bindTools = vi.fn().mockReturnValue(fakeStreamingChatModel);

      await agent.init(undefined, {
        ...mockConfig,
        llm: fakeStreamingChatModel,
        streamOutput: true,
      });

      await expect(
        agent.stream([new HumanMessage('test message')], {
          recursionLimit: 1000,
          configurable: { thread_id: 'test-thread-id' },
        })
      ).rejects.toThrow('invalid_grant');

      // Otherwise the raw-mode keypress listener keeps stdin ref'd and the process hangs
      // after the error, with Esc/Ctrl+C only printing "Interrupting...".
      expect(systemUtilsMock.waitForEscape).toHaveBeenCalled();
      expect(systemUtilsMock.stopWaitingForEscape).toHaveBeenCalled();
    });

    it('should materialize binary outputs after streaming completes', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const mockStreamChunks = [
        [new AIMessageChunk({ content: 'hello' }), {}],
        [
          new AIMessageChunk({
            content: [{ type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'abc' } }],
          }),
          {},
        ],
      ];

      async function* mockStreamGenerator() {
        for (const chunk of mockStreamChunks) {
          yield chunk;
        }
      }

      agentMock.stream.mockResolvedValue(mockStreamGenerator());
      binaryOutputUtilsMock.extractInlineBinaryBlocks.mockReturnValue([
        { index: 0, mimeType: 'image/png', data: 'abc' },
      ]);
      binaryOutputUtilsMock.materializeBinaryOutputs.mockReturnValue({
        renderedContent: '[Binary model output saved: image/png -> /tmp/gth_test_ASK.png]',
        successMessages: ['Wrote model output (image/png) to /tmp/gth_test_ASK.png'],
      });

      const fakeStreamingChatModel = new FakeStreamingChatModel({
        chunks: [
          new AIMessageChunk({ content: 'hello' }),
          new AIMessageChunk({
            content: [{ type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'abc' } }],
          }),
        ],
      });
      fakeStreamingChatModel.bindTools = vi.fn().mockReturnValue(fakeStreamingChatModel);

      await agent.init('ask', { ...mockConfig, llm: fakeStreamingChatModel, streamOutput: true });

      const stream = await agent.stream([new HumanMessage('test message')], {
        recursionLimit: 1000,
        configurable: { thread_id: 'test-thread-id' },
      });

      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['hello']);
      expect(binaryOutputUtilsMock.materializeBinaryOutputs).toHaveBeenCalledWith(
        [{ type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'abc' } }],
        'ask'
      );
      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.SUCCESS,
        'Wrote model output (image/png) to /tmp/gth_test_ASK.png'
      );
    });
  });

  describe('streamWithEvents', () => {
    it('should swallow GraphInterrupt and end the iterator', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      // Underlying stream throws GraphInterrupt — simulates a tool calling interrupt()
      agentMock.stream.mockRejectedValue(new GraphInterrupt([{ value: 'paused' }]));

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 't1' },
      };
      const events: unknown[] = [];
      for await (const ev of agent.streamWithEvents([new HumanMessage('go')], runConfig)) {
        events.push(ev);
      }

      // No events yielded — generator returned cleanly without throwing
      expect(events).toEqual([]);
    });

    it('should rethrow non-GraphInterrupt errors', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      agentMock.stream.mockRejectedValue(new Error('boom'));

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 't2' },
      };

      await expect(async () => {
        for await (const _ev of agent.streamWithEvents([new HumanMessage('go')], runConfig)) {
          // drain
        }
      }).rejects.toThrow('boom');
    });

    it('should forward the AbortSignal to the underlying agent.stream', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      async function* empty() {}
      agentMock.stream.mockResolvedValue(empty());

      const ac = new AbortController();
      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'abortable' },
      };
      for await (const _ev of agent.streamWithEvents(
        [new HumanMessage('go')],
        runConfig,
        ac.signal
      )) {
        // drain
      }

      const [, opts] = agentMock.stream.mock.calls[0];
      expect((opts as { signal?: AbortSignal }).signal).toBe(ac.signal);
    });

    it('should swallow AbortError and end the iterator (caller-cancelled run)', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      agentMock.stream.mockRejectedValue(abortError);

      const events: unknown[] = [];
      for await (const ev of agent.streamWithEvents([new HumanMessage('go')], {
        recursionLimit: 1000,
        configurable: { thread_id: 'aborted' },
      })) {
        events.push(ev);
      }

      expect(events).toEqual([]);
    });

    it('should isolate tool_call_chunks per round so the second call gets its own args', async () => {
      // Repro for the bug where OpenAI restarts tool_call_chunks.index at 0
      // for each LLM round. Without per-round isolation, the second call's
      // index-0 chunks collide with the first call's group in collapseToolCallChunks
      // and the second call's args end up empty.
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      // Round 1: list_directory(path: ".")
      const r1Start = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ id: 'tc-1', name: 'list_directory', args: '', index: 0 }],
      });
      const r1Body = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ args: '{"path":"."}', index: 0 }],
      });
      const r1Result = new ToolMessage({ content: '[FILE] start.js', tool_call_id: 'tc-1' });

      // Round 2: get_file_info(path: "start.js") — index restarts at 0
      const r2Start = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ id: 'tc-2', name: 'get_file_info', args: '', index: 0 }],
      });
      const r2Body = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ args: '{"path":"start.js"}', index: 0 }],
      });
      const r2Result = new ToolMessage({ content: 'size: 3001', tool_call_id: 'tc-2' });

      async function* streamed() {
        yield [r1Start, {}];
        yield [r1Body, {}];
        yield [r1Result, {}];
        yield [r2Start, {}];
        yield [r2Body, {}];
        yield [r2Result, {}];
      }
      agentMock.stream.mockResolvedValue(streamed());

      const events: { type: string; id?: string; delta?: string; content?: string }[] = [];
      for await (const ev of agent.streamWithEvents([new HumanMessage('go')], {
        recursionLimit: 1000,
        configurable: { thread_id: 'multi-round' },
      })) {
        events.push(ev as { type: string; id?: string; delta?: string; content?: string });
      }

      const argEvents = events.filter((e) => e.type === 'tool_args');
      expect(argEvents).toHaveLength(2);
      expect(JSON.parse(argEvents[0].delta!)).toEqual({ path: '.' });
      expect(JSON.parse(argEvents[1].delta!)).toEqual({ path: 'start.js' });
    });

    it('should join tool_call_chunks across AIMessageChunks into final args', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      // Each chunk carries a partial slice of the args JSON; only the joined
      // sequence parses to {path: "/home"}.
      const chunk1 = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ id: 'tc-1', name: 'list_directory', args: '{"pa', index: 0 }],
      });
      const chunk2 = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ args: 'th": ', index: 0 }],
      });
      const chunk3 = new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ args: '"/home"}', index: 0 }],
      });
      const toolResult = new ToolMessage({ content: '[FILE] x', tool_call_id: 'tc-1' });

      async function* streamed() {
        yield [chunk1, {}];
        yield [chunk2, {}];
        yield [chunk3, {}];
        yield [toolResult, {}];
      }
      agentMock.stream.mockResolvedValue(streamed());

      const events: { type: string; id?: string; delta?: string; content?: string }[] = [];
      for await (const ev of agent.streamWithEvents([new HumanMessage('go')], {
        recursionLimit: 1000,
        configurable: { thread_id: 'tc-stream' },
      })) {
        events.push(ev as { type: string; id?: string; delta?: string; content?: string });
      }

      expect(events.map((e) => e.type)).toEqual([
        'tool_start',
        'tool_args',
        'tool_end',
        'tool_result',
      ]);
      expect(events[0]).toMatchObject({ type: 'tool_start', id: 'tc-1', name: 'list_directory' });
      expect(events[1]).toMatchObject({ type: 'tool_args', id: 'tc-1' });
      expect(JSON.parse(events[1].delta!)).toEqual({ path: '/home' });
      expect(events[3]).toMatchObject({ type: 'tool_result', id: 'tc-1', content: '[FILE] x' });
    });
  });

  describe('streamWithEventsResume', () => {
    it('should throw if not initialized', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 't' },
      };
      await expect(async () => {
        for await (const _ of agent.streamWithEventsResume('value', runConfig)) {
          // drain
        }
      }).rejects.toThrow('Agent not initialized. Call init() first.');
    });

    it('should call underlying agent.stream with a Command({resume}) instance', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      // Empty stream — we only care that stream() was invoked correctly
      async function* empty() {}
      agentMock.stream.mockResolvedValue(empty());

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'resumed-thread' },
      };
      for await (const _ev of agent.streamWithEventsResume(
        '{"mimeType":"image/jpeg","data":"AAA"}',
        runConfig
      )) {
        // drain
      }

      expect(agentMock.stream).toHaveBeenCalledOnce();
      const [arg, opts] = agentMock.stream.mock.calls[0];
      expect(arg).toBeInstanceOf(Command);
      expect((arg as Command).resume).toBe('{"mimeType":"image/jpeg","data":"AAA"}');
      expect(opts).toMatchObject({
        configurable: { thread_id: 'resumed-thread' },
        streamMode: 'messages',
      });
    });

    it('should attach queued messages via Command.update when provided', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      async function* empty() {}
      agentMock.stream.mockResolvedValue(empty());

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'steer-thread' },
      };
      const correction = new HumanMessage('turn around, wrong way');
      for await (const _ev of agent.streamWithEventsResume('resumeVal', runConfig, [correction])) {
        // drain
      }

      const [arg] = agentMock.stream.mock.calls[0];
      expect(arg).toBeInstanceOf(Command);
      expect((arg as Command).resume).toBe('resumeVal');
      expect((arg as unknown as { update: { messages: unknown[] } }).update.messages).toEqual([
        correction,
      ]);
    });

    it('should not set Command.update when queued messages are empty', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      async function* empty() {}
      agentMock.stream.mockResolvedValue(empty());

      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'no-steer-thread' },
      };
      for await (const _ev of agent.streamWithEventsResume('resumeVal', runConfig, [])) {
        // drain
      }

      const [arg] = agentMock.stream.mock.calls[0];
      expect((arg as unknown as { update?: unknown }).update).toBeUndefined();
    });

    it('should forward the AbortSignal to the underlying agent.stream', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      async function* empty() {}
      agentMock.stream.mockResolvedValue(empty());

      const ac = new AbortController();
      const runConfig: RunnableConfig = {
        recursionLimit: 1000,
        configurable: { thread_id: 'resume-abortable' },
      };
      for await (const _ev of agent.streamWithEventsResume('resumeVal', runConfig, [], ac.signal)) {
        // drain
      }

      const [, opts] = agentMock.stream.mock.calls[0];
      expect((opts as { signal?: AbortSignal }).signal).toBe(ac.signal);
    });

    it('should yield processed tool_result events from the resumed stream', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);
      await agent.init(undefined, { ...mockConfig, llm: fakeListChatModel });

      // Simulate a resumed run: AIMessage proposing a tool call, then a ToolMessage with result
      const aiWithToolCall = new AIMessage({
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'capture_image', args: {} }],
      });
      const toolResult = new ToolMessage({ content: 'IMAGE_BYTES', tool_call_id: 'tc-1' });

      async function* resumedStream() {
        yield [aiWithToolCall, {}];
        yield [toolResult, {}];
      }
      agentMock.stream.mockResolvedValue(resumedStream());

      const events: { type: string; id?: string; content?: string }[] = [];
      for await (const ev of agent.streamWithEventsResume('payload', {
        recursionLimit: 1000,
        configurable: { thread_id: 'resumed-thread' },
      })) {
        events.push(ev as { type: string; id?: string; content?: string });
      }

      expect(events.map((e) => e.type)).toEqual([
        'tool_start',
        'tool_args',
        'tool_end',
        'tool_result',
      ]);
      expect(events[3]).toMatchObject({ type: 'tool_result', id: 'tc-1', content: 'IMAGE_BYTES' });
    });
  });

  describe('extractAndFlattenTools — frontend-fulfilled tools', () => {
    it('should wrap tools with metadata.client === true so invoke() calls interrupt()', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      const originalInvoke = vi.fn().mockResolvedValue('original');
      const clientTool = {
        name: 'capture_image',
        description: 'client',
        invoke: originalInvoke,
        call: originalInvoke,
        metadata: { client: true },
        // Object.getPrototypeOf needs a prototype-bearing object
      } as unknown as StructuredToolInterface;

      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      await agent.init(undefined, {
        ...mockConfig,
        llm: fakeListChatModel,
        tools: [clientTool],
      } as GthConfig);

      // The agent received a wrapped clone — extract it from createAgent's call
      const createAgentArg = createAgentMock.mock.calls[0][0] as {
        tools: StructuredToolInterface[];
      };
      const wrappedTool = createAgentArg.tools.find((t) => t.name === 'capture_image');
      expect(wrappedTool).toBeDefined();

      // Original tool's invoke must be untouched (the agent must clone before mutating)
      expect(clientTool.invoke).toBe(originalInvoke);
      expect(originalInvoke).not.toHaveBeenCalled();

      // Calling invoke() outside a graph run throws — confirms interrupt() was reached.
      // (Inside a real LangGraph node, this throws GraphInterrupt; outside, a regular Error
      // about "called outside the context".) Either way, the wrapper called interrupt(),
      // not the original invoke.
      await expect(
        (
          wrappedTool as StructuredToolInterface & {
            invoke: (_i: unknown) => Promise<unknown>;
          }
        ).invoke({})
      ).rejects.toThrow(/interrupt/i);
      expect(originalInvoke).not.toHaveBeenCalled();
    });

    it('should leave tools without metadata.client untouched', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      const serverInvoke = vi.fn().mockResolvedValue('server-result');
      const serverTool = {
        name: 'server_tool',
        description: 'server',
        invoke: serverInvoke,
        call: serverInvoke,
      } as unknown as StructuredToolInterface;

      const fakeListChatModel = new FakeListChatModel({ responses: [] });
      fakeListChatModel.bindTools = vi.fn().mockReturnValue(fakeListChatModel);

      await agent.init(undefined, {
        ...mockConfig,
        llm: fakeListChatModel,
        tools: [serverTool],
      } as GthConfig);

      const createAgentArg = createAgentMock.mock.calls[0][0] as {
        tools: StructuredToolInterface[];
      };
      const passedTool = createAgentArg.tools.find((t) => t.name === 'server_tool');

      // Same instance passed through — no clone, no wrap
      expect(passedTool).toBe(serverTool);
      expect((passedTool as StructuredToolInterface).invoke).toBe(serverInvoke);
    });
  });

  describe('cleanup', () => {
    it('should cleanup and reset state', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const configWithMcp = {
        ...mockConfig,
        mcpServers: {
          custom: {
            transport: 'stdio' as const,
            command: 'custom-server',
            args: [],
          },
        },
      } as GthConfig;

      await agent.init(undefined, configWithMcp);
      await agent.cleanup();

      expect(agent['agent']).toBeNull();
      expect(agent['config']).toBeNull();
    });

    it('should handle cleanup when not initialized', async () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);

      await expect(agent.cleanup()).resolves.not.toThrow();
    });

    it('should call resolver cleanup functions', async () => {
      const cleanupTools = vi.fn().mockResolvedValue(undefined);
      const cleanupMiddleware = vi.fn().mockResolvedValue(undefined);
      const agent = new GthLangChainAgent(statusUpdateCallback, {
        cleanupTools,
        cleanupMiddleware,
      });

      await agent.init(undefined, mockConfig);
      await agent.cleanup();

      expect(cleanupTools).toHaveBeenCalled();
      expect(cleanupMiddleware).toHaveBeenCalled();
    });
  });

  describe('getEffectiveConfig', () => {
    it('should merge command-specific config', () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const config = {
        ...mockConfig,
        filesystem: 'read',
        builtInTools: ['general'],
        commands: {
          code: {
            filesystem: 'all',
            builtInTools: ['specific'],
          },
        },
      } as GthConfig;

      const result = agent.getEffectiveConfig(config, 'code');

      expect(result.filesystem).toBe('all');
      expect(result.builtInTools).toEqual(['specific']);
    });

    it('should use default config when no command-specific config', () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const config = {
        ...mockConfig,
        filesystem: 'read',
        builtInTools: ['general'],
      } as GthConfig;

      const result = agent.getEffectiveConfig(config, 'code');

      expect(result.filesystem).toBe('read');
      expect(result.builtInTools).toEqual(['general']);
    });

    it('should merge command-specific allowedTools and fall back to the top-level value', () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const config = {
        ...mockConfig,
        allowedTools: ['global_tool'],
        commands: {
          pr: { allowedTools: [] },
        },
      } as GthConfig;

      // Command-level empty array overrides the top-level allow-list.
      expect(agent.getEffectiveConfig(config, 'pr').allowedTools).toEqual([]);
      // Commands without their own allowedTools fall back to the top-level value.
      expect(agent.getEffectiveConfig(config, 'code').allowedTools).toEqual(['global_tool']);
    });

    it('should warn when model does not support tools', () => {
      const agent = new GthLangChainAgent(statusUpdateCallback);
      const config = {
        ...mockConfig,
        llm: {
          ...mockConfig.llm,
          bindTools: undefined,
        },
      } as GthConfig;

      agent.getEffectiveConfig(config, undefined);

      expect(statusUpdateCallback).toHaveBeenCalledWith(
        StatusLevel.WARNING,
        'Model does not seem to support tools.'
      );
    });
  });
});
