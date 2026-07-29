import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '@a2a-js/sdk';

const mockSendMessage = vi.hoisted(() => vi.fn());
// `@a2a-js/sdk` 1.0 removed the `A2AClient` class: a client is now produced by a `ClientFactory`
// built from a card resolver + transport factories, so the mock exposes that surface. The
// constructor args are captured so the tests can assert legacyCompat is enabled on every one of
// them (that is what keeps us able to talk to protocol-v0.3 agents such as Google ADK).
const mockCreateFromUrl = vi.hoisted(() => vi.fn());
const mockFactoryOptions = vi.hoisted(() => vi.fn());
const mockCardResolver = vi.hoisted(() => vi.fn());
const mockJsonRpcTransportFactory = vi.hoisted(() => vi.fn());
const mockRestTransportFactory = vi.hoisted(() => vi.fn());

vi.mock('@a2a-js/sdk/client', () => {
  const ClientFactory = vi.fn();
  ClientFactory.prototype.createFromUrl = mockCreateFromUrl;
  return {
    ClientFactory,
    ClientFactoryOptions: {
      default: { transports: [] },
      createFrom: mockFactoryOptions,
    },
    DefaultAgentCardResolver: mockCardResolver,
    JsonRpcTransportFactory: mockJsonRpcTransportFactory,
    RestTransportFactory: mockRestTransportFactory,
  };
});

vi.mock('#src/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
  debugLogError: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

/** A v1.0 text part — `{ content: { $case: 'text', value } }`, not v0.3's `{ kind: 'text', text }`. */
const textPart = (value: string) => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

/** The outgoing message the wrapper is expected to build for `text`. */
const expectedOutgoing = (text: string, contextId = '', taskId = '') => ({
  tenant: '',
  configuration: undefined,
  metadata: undefined,
  message: {
    messageId: 'test-uuid-1234',
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  },
});

describe('A2AClientWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockReset();
    mockCreateFromUrl.mockReset();
    mockFactoryOptions.mockReset();
    mockFactoryOptions.mockImplementation((original, overrides) => ({ ...original, ...overrides }));
    // Every send awaits the factory-produced client, so re-arm the resolved value after the reset
    // (the constructor also `.catch`es it — an unresolved default would break every test).
    mockCreateFromUrl.mockResolvedValue({ sendMessage: mockSendMessage });
  });

  describe('constructor', () => {
    it('builds the client from the well-known agent-card URL', async () => {
      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      // The card path is appended to the BASE agent url and handed over as a complete url with an
      // empty relative path. Letting the SDK resolver append its own default would resolve it
      // relative to the base and drop the `/a2a` segment.
      expect(mockCreateFromUrl).toHaveBeenCalledWith(
        'http://localhost:8080/a2a/.well-known/agent-card.json',
        ''
      );
    });

    it('enables v0.3 legacy compat on the card resolver and every transport factory', async () => {
      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      new A2AClientWrapper({ agentId: 'test-agent', agentUrl: 'http://localhost:8080/a2a' });

      // Without this, a v1.0 client cannot talk to an agent still on protocol v0.3 — which is what
      // the Google ADK agents we drive today speak.
      const legacy = { legacyCompat: { enabled: true } };
      expect(mockCardResolver).toHaveBeenCalledWith(legacy);
      expect(mockJsonRpcTransportFactory).toHaveBeenCalledWith(legacy);
      expect(mockRestTransportFactory).toHaveBeenCalledWith(legacy);
    });
  });

  describe('sendMessage', () => {
    it('should send message with correct format and return text response', async () => {
      mockSendMessage.mockResolvedValue({
        messageId: 'm1',
        role: Role.ROLE_AGENT,
        parts: [textPart('Hello back!')],
      });

      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      const wrapper = new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      const result = await wrapper.sendMessage('Hello agent');

      expect(mockSendMessage).toHaveBeenCalledWith(expectedOutgoing('Hello agent'));
      expect(result).toBe('Hello back!');
    });

    it('falls back to the serialized task when a Task carries no text', async () => {
      // v1.0 returns the domain object directly, so a textless Task no longer looks like a bare
      // `{ state }` envelope — report the whole thing rather than inventing a summary.
      mockSendMessage.mockResolvedValue({
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 3 },
        artifacts: [],
      });

      const { A2AClientWrapper } = await import('#src/modules/a2a/A2AClientWrapper.js');

      const wrapper = new A2AClientWrapper({
        agentId: 'test-agent',
        agentUrl: 'http://localhost:8080/a2a',
      });

      const result = await wrapper.sendMessage('Hello');
      expect(result).toContain('task-1');
    });

    it('should propagate errors thrown by the SDK', async () => {
      // v1.0 throws semantic error classes instead of returning a JSON-RPC `{ error }` envelope.
      mockSendMessage.mockRejectedValue(new Error('A2A Error: internal'));

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
        messageId: 'm1',
        role: Role.ROLE_AGENT,
        contextId: 'ctx-abc',
        taskId: 'task-xyz',
        parts: [textPart('Hello'), textPart('world')],
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Hi');

      expect(result).toEqual({ text: 'Hello\nworld', contextId: 'ctx-abc', taskId: 'task-xyz' });
    });

    it('normalizes the proto empty-string ids back to undefined', async () => {
      // The v1.0 proto model has no optional ids: an absent contextId/taskId arrives as ''. Leaking
      // that would thread an empty handle into the next turn.
      mockSendMessage.mockResolvedValue({
        messageId: 'm1',
        role: Role.ROLE_AGENT,
        contextId: '',
        taskId: '',
        parts: [textPart('Hello')],
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Hi');

      expect(result).toEqual({ text: 'Hello', contextId: undefined, taskId: undefined });
    });

    it('extracts text from a Task status message, with contextId + Task.id as taskId', async () => {
      mockSendMessage.mockResolvedValue({
        id: 'task-42',
        contextId: 'ctx-42',
        status: {
          state: 3,
          message: { messageId: 'm2', role: Role.ROLE_AGENT, parts: [textPart('Done!')] },
        },
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Do it');

      expect(result).toEqual({ text: 'Done!', contextId: 'ctx-42', taskId: 'task-42' });
    });

    it('falls back to the last artifact parts when a Task has no status message', async () => {
      mockSendMessage.mockResolvedValue({
        id: 'task-7',
        contextId: 'ctx-7',
        status: { state: 3 },
        artifacts: [
          { artifactId: 'a1', parts: [textPart('first')] },
          { artifactId: 'a2', parts: [textPart('final answer')] },
        ],
      });

      const wrapper = await makeWrapper();
      const result = await wrapper.sendMessageWithContext('Do it');

      expect(result).toEqual({ text: 'final answer', contextId: 'ctx-7', taskId: 'task-7' });
    });

    it('sends no continuity handles on a first-turn (contextless) send', async () => {
      mockSendMessage.mockResolvedValue({
        messageId: 'm',
        role: Role.ROLE_AGENT,
        parts: [textPart('ok')],
      });

      const wrapper = await makeWrapper();
      await wrapper.sendMessageWithContext('Hello');

      expect(mockSendMessage).toHaveBeenCalledWith(expectedOutgoing('Hello'));
    });

    it('threads contextId (and taskId) into the outgoing message when provided', async () => {
      mockSendMessage.mockResolvedValue({
        messageId: 'm',
        role: Role.ROLE_AGENT,
        parts: [textPart('ok')],
      });

      const wrapper = await makeWrapper();
      await wrapper.sendMessageWithContext('Follow up', { contextId: 'ctx-9', taskId: 'task-9' });

      expect(mockSendMessage).toHaveBeenCalledWith(
        expectedOutgoing('Follow up', 'ctx-9', 'task-9')
      );
    });

    it('propagates an error thrown by the SDK', async () => {
      mockSendMessage.mockRejectedValue(new Error('A2A Error: internal'));

      const wrapper = await makeWrapper();
      await expect(wrapper.sendMessageWithContext('Hello')).rejects.toThrow('A2A Error');
    });
  });
});
