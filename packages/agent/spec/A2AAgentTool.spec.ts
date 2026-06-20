import { beforeEach, describe, expect, it, vi } from 'vitest';

const A2AClientWrapperInstanceMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));
const A2AClientWrapperMock = vi.hoisted(() =>
  vi.fn(function A2AClientWrapperMock() {
    return A2AClientWrapperInstanceMock;
  })
);

vi.mock('#src/modules/a2a/A2AClientWrapper.js', () => ({
  A2AClientWrapper: A2AClientWrapperMock,
}));

vi.mock('#src/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
}));

describe('A2AAgentTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    A2AClientWrapperMock.mockClear();
    A2AClientWrapperInstanceMock.sendMessage.mockReset();
  });

  describe('createA2AAgentTool', () => {
    it('should create a tool with correct name based on agentId', async () => {
      const { createA2AAgentTool } = await import('#src/tools/A2AAgentTool.js');

      const tool = createA2AAgentTool({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      expect(tool.name).toBe('a2a_agent_test-agent');
    });

    it('should create a tool with correct description', async () => {
      const { createA2AAgentTool } = await import('#src/tools/A2AAgentTool.js');

      const tool = createA2AAgentTool({
        agentId: 'my-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      expect(tool.description).toContain('my-agent');
      expect(tool.description).toContain('A2A');
    });

    it('should call A2AClientWrapper.sendMessage when invoked', async () => {
      const mockSendMessage = vi.fn().mockResolvedValue('Agent response');
      A2AClientWrapperMock.mockImplementation(function () {
        return { sendMessage: mockSendMessage };
      });

      const { createA2AAgentTool } = await import('#src/tools/A2AAgentTool.js');

      const tool = createA2AAgentTool({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      const result = await tool.invoke({ message: 'Hello agent' });

      expect(mockSendMessage).toHaveBeenCalledWith('Hello agent');
      expect(result).toBe('Agent response');
    });

    it('should return error message when client throws', async () => {
      const mockSendMessage = vi.fn().mockRejectedValue(new Error('Connection failed'));
      A2AClientWrapperMock.mockImplementation(function () {
        return { sendMessage: mockSendMessage };
      });

      const { createA2AAgentTool } = await import('#src/tools/A2AAgentTool.js');

      const tool = createA2AAgentTool({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      const result = await tool.invoke({ message: 'Hello' });

      expect(result).toContain('Error communicating with agent');
      expect(result).toContain('Connection failed');
    });
  });
});
