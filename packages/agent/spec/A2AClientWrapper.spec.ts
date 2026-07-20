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

  // BATCH-14: the context-threading variant used by the ADK eval runner. Reads the REAL
  // `@a2a-js/sdk` result shapes (Message | Task) and returns text + contextId/taskId.
  describe('sendMessageWithContext', () => {
    async function makeWrapper() {
      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');
      return new A2AClientWrapper({ agentId: 'test-agent', agentUrl: 'http://localhost:8080/a2a' });
    }

    it('extracts text + contextId/taskId from a Message result', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          kind: 'message',
          messageId: 'm1',
          role: 'agent',
          contextId: 'ctx-abc',
          taskId: 'task-xyz',
          parts: [
            { kind: 'text', text: 'Hello' },
            { kind: 'text', text: 'world' },
          ],
        },
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Hi');

      expect(result).toEqual({ text: 'Hello\nworld', contextId: 'ctx-abc', taskId: 'task-xyz' });
    });

    it('extracts text from a Task status message, with contextId + Task.id as taskId', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          kind: 'task',
          id: 'task-42',
          contextId: 'ctx-42',
          status: {
            state: 'completed',
            message: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'Done!' }] },
          },
        },
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Do it');

      expect(result).toEqual({ text: 'Done!', contextId: 'ctx-42', taskId: 'task-42' });
    });

    it('falls back to the last artifact parts when a Task has no status message', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          kind: 'task',
          id: 'task-7',
          contextId: 'ctx-7',
          status: { state: 'completed' },
          artifacts: [
            { artifactId: 'a1', parts: [{ kind: 'text', text: 'first' }] },
            { artifactId: 'a2', parts: [{ kind: 'text', text: 'final answer' }] },
          ],
        },
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Do it');

      expect(result).toEqual({ text: 'final answer', contextId: 'ctx-7', taskId: 'task-7' });
    });

    it('sends no continuity handles on a first-turn (contextless) send', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          kind: 'message',
          messageId: 'm',
          role: 'agent',
          parts: [{ kind: 'text', text: 'ok' }],
        },
      });

      const wrapper = await makeWrapper();
      await wrapper.sendMessageWithContext('Hello');

      expect(mockSendMessage).toHaveBeenCalledWith({
        message: {
          kind: 'message',
          messageId: 'test-uuid-1234',
          role: 'user',
          parts: [{ kind: 'text', text: 'Hello' }],
        },
      });
    });

    it('threads contextId (and taskId) into the outgoing message when provided', async () => {
      mockSendMessage.mockResolvedValue({
        result: {
          kind: 'message',
          messageId: 'm',
          role: 'agent',
          parts: [{ kind: 'text', text: 'ok' }],
        },
      });

      const wrapper = await makeWrapper();
      await wrapper.sendMessageWithContext('Follow up', { contextId: 'ctx-9', taskId: 'task-9' });

      expect(mockSendMessage).toHaveBeenCalledWith({
        message: {
          kind: 'message',
          messageId: 'test-uuid-1234',
          role: 'user',
          parts: [{ kind: 'text', text: 'Follow up' }],
          contextId: 'ctx-9',
          taskId: 'task-9',
        },
      });
    });

    it('throws on an A2A error response', async () => {
      mockSendMessage.mockResolvedValue({ error: { code: 500, message: 'Internal error' } });

      const wrapper = await makeWrapper();
      await expect(wrapper.sendMessageWithContext('Hello')).rejects.toThrow('A2A Error');
    });
  });
});
