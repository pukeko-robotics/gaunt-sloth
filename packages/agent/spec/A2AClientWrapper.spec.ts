import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendMessage = vi.hoisted(() => vi.fn());
const A2AClientMock = vi.hoisted(() =>
  vi.fn(function A2AClientMock() {
    return {
      sendMessage: mockSendMessage,
    };
  })
);

vi.mock('@a2a-js/sdk/client', () => ({
  A2AClient: A2AClientMock,
}));

vi.mock('#src/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
  debugLogError: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

describe('A2AClientWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockReset();
    A2AClientMock.mockClear();
  });

  describe('constructor', () => {
    it('should initialize A2AClient with agentUrl', async () => {
      const { A2AClient } = await import('@a2a-js/sdk/client');
      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      expect(A2AClient).toHaveBeenCalledWith('http://localhost:8080/a2a');
    });
  });

  describe('sendMessage', () => {
    it('should send message with correct format and return text response', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          message: {
            parts: [{ text: 'Hello back!' }],
          },
        },
      });

      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      const wrapper = new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      const result = await wrapper.sendMessage('Hello agent');

      expect(mockSendMessage).toHaveBeenCalledWith({
        message: {
          kind: 'message',
          messageId: 'test-uuid-1234',
          role: 'user',
          parts: [{ kind: 'text', text: 'Hello agent' }],
        },
      });
      expect(result).toBe('Hello back!');
    });

    it('should return task state when no message in response', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          state: 'completed',
        },
      });

      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      const wrapper = new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      const result = await wrapper.sendMessage('Hello');
      expect(result).toBe('Task state: completed');
    });

    it('should throw error when response contains error', async () => {
      mockSendMessage.mockResolvedValue({
        error: { code: 500, message: 'Internal error' },
      });

      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      const wrapper = new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      await expect(wrapper.sendMessage('Hello')).rejects.toThrow('A2A Error');
    });

    it('should propagate network errors', async () => {
      mockSendMessage.mockRejectedValue(new Error('Network error'));

      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      const wrapper = new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      await expect(wrapper.sendMessage('Hello')).rejects.toThrow('Network error');
    });
  });
});
