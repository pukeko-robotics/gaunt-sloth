/**
 * @module A2AClientWrapper
 * Wrapper for A2A (Agent-to-Agent) protocol client.
 * @experimental A2A support is experimental and may change.
 */
import { A2AClient } from '@a2a-js/sdk/client';
import type { Message, Part, Task } from '@a2a-js/sdk';
import { debugLog, debugLogError } from '@gaunt-sloth/core/utils/debugUtils.js';
import { v4 as uuidv4 } from 'uuid';

/** The A2A spec's well-known agent-card path. `A2AClient.fromCardUrl` needs the full CARD url,
 * whereas {@link A2AClientConfig.agentUrl} is the agent's BASE url — so we append this, exactly as
 * the deprecated `new A2AClient(url)` string constructor did internally (its `resolveAgentCardUrl`
 * used the same default). Keeps the fetched card URL byte-identical across the migration. */
const AGENT_CARD_PATH = '.well-known/agent-card.json';

/** Configuration for A2A client */
export interface A2AClientConfig {
  /** Unique identifier for the agent */
  agentId: string;
  /** URL endpoint for the A2A agent */
  agentUrl: string;
}

/**
 * A single A2A turn's result with its conversation-continuity handles (BATCH-14). Unlike the
 * text-only {@link A2AClientWrapper.sendMessage}, this carries the `contextId`/`taskId` the server
 * returned so a caller can thread them into follow-up turns (an ADK agent keeps conversational
 * context by `contextId`). Both are optional because a response may be a bare `Message` (which
 * carries them only optionally) or a `Task` (which always carries `contextId`, and `id` as the
 * taskId).
 */
export interface A2AMessageResult {
  /** The agent's answer text, extracted from the response's text parts. */
  text: string;
  /** The A2A context id to thread into subsequent turns for conversational continuity. */
  contextId?: string;
  /** The A2A task id, when the response was a Task (`Task.id`) or a task-scoped Message. */
  taskId?: string;
}

/** Optional conversation-continuity handles to attach to an outgoing A2A message (BATCH-14). */
export interface A2ASendContext {
  contextId?: string;
  taskId?: string;
}

/**
 * Wrapper around the A2A SDK client for communicating with external agents.
 * @experimental
 */
export class A2AClientWrapper {
  private clientPromise: Promise<A2AClient>;
  private config: A2AClientConfig;

  constructor(config: A2AClientConfig) {
    this.config = config;
    // Construct via the non-deprecated `A2AClient.fromCardUrl(cardUrl)` (the string `new
    // A2AClient(url)` constructor is deprecated and console.warns). `fromCardUrl` is async, so we
    // hold the promise and await it per send. The agent card is fetched from the well-known path
    // appended to the base agent URL — reproducing the old constructor's fetch target exactly.
    const cardUrl = `${config.agentUrl.replace(/\/+$/, '')}/${AGENT_CARD_PATH}`;
    this.clientPromise = A2AClient.fromCardUrl(cardUrl);
    // Guard against an unhandled rejection if the wrapper is constructed but never used; real
    // callers still observe the rejection when they await `clientPromise` inside a send method.
    void this.clientPromise.catch(() => undefined);
  }

  /**
   * Sends a message to the A2A agent and returns the response.
   * @param messageText - The message to send to the agent
   * @returns The agent's response as a string
   */
  async sendMessage(messageText: string): Promise<string> {
    debugLog(
      `Sending message to A2A agent ${this.config.agentId} at ${this.config.agentUrl}: ${messageText}`
    );
    try {
      const client = await this.clientPromise;
      const messageId = uuidv4();
      const response = await client.sendMessage({
        message: {
          kind: 'message',
          messageId: messageId,
          role: 'user',
          parts: [{ kind: 'text', text: messageText }],
        },
      });

      debugLog(`Received response from A2A agent: ${JSON.stringify(response)}`);

      // Check for error response
      if ('error' in response) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        throw new Error(`A2A Error: ${JSON.stringify((response as any).error)}`);
      }

      // Extract text from response
      // The result is likely a TaskStatus which contains a message
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = response.result as any;

      if (result.message && result.message.parts && result.message.parts.length > 0) {
        // Assuming the first part is text for now
        return result.message.parts[0].text || JSON.stringify(result.message.parts);
      } else if (result.state) {
        return `Task state: ${result.state}`;
      }

      return JSON.stringify(result);
    } catch (error) {
      debugLogError('Error sending message to A2A agent', error);
      throw error;
    }
  }

  /**
   * BATCH-14 — send one message and return its text ALONG WITH the A2A `contextId`/`taskId` needed to
   * thread a multi-turn conversation. Reads the real `@a2a-js/sdk` result shapes rather than the
   * loose envelope {@link sendMessage} uses:
   *
   * - A **Message** result (`kind: 'message'`) carries its text in `parts` and `contextId`/`taskId`
   *   directly (both optional).
   * - A **Task** result (`kind: 'task'`) — what Google ADK agents commonly return — carries text in
   *   `status.message.parts` (falling back to the last artifact's parts), `contextId` (required), and
   *   the taskId as `Task.id`.
   *
   * `context.contextId`/`taskId` are attached to the OUTGOING message only when defined, so a
   * first-turn send stays byte-identical to a contextless one.
   *
   * @param messageText - The message to send to the agent.
   * @param context - Optional context/task ids to continue an existing conversation.
   * @returns The agent's text answer plus the context/task ids from its response.
   */
  async sendMessageWithContext(
    messageText: string,
    context?: A2ASendContext
  ): Promise<A2AMessageResult> {
    debugLog(
      `Sending message (with context) to A2A agent ${this.config.agentId} at ` +
        `${this.config.agentUrl}: ${messageText}` +
        (context?.contextId ? ` [contextId=${context.contextId}]` : '')
    );
    try {
      const client = await this.clientPromise;
      const response = await client.sendMessage({
        message: {
          kind: 'message',
          messageId: uuidv4(),
          role: 'user',
          parts: [{ kind: 'text', text: messageText }],
          // Attach continuity handles only when present, so a first-turn send is unchanged.
          ...(context?.contextId ? { contextId: context.contextId } : {}),
          ...(context?.taskId ? { taskId: context.taskId } : {}),
        },
      });

      debugLog(`Received response from A2A agent: ${JSON.stringify(response)}`);

      if ('error' in response) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        throw new Error(`A2A Error: ${JSON.stringify((response as any).error)}`);
      }

      const result = response.result as Message | Task;
      return A2AClientWrapper.extractResult(result);
    } catch (error) {
      debugLogError('Error sending message (with context) to A2A agent', error);
      throw error;
    }
  }

  /** Normalize a `Message | Task` A2A result into text + continuity handles (BATCH-14). Static +
   * tolerant of missing optional fields so it can be reused and unit-tested directly. */
  private static extractResult(result: Message | Task): A2AMessageResult {
    if (result && result.kind === 'task') {
      const task = result as Task;
      const statusParts = task.status?.message?.parts;
      const artifactParts = task.artifacts?.[task.artifacts.length - 1]?.parts;
      const text =
        A2AClientWrapper.extractText(statusParts ?? artifactParts) || JSON.stringify(task);
      return { text, contextId: task.contextId, taskId: task.id };
    }
    const message = result as Message;
    const text = A2AClientWrapper.extractText(message?.parts) || JSON.stringify(result);
    return { text, contextId: message?.contextId, taskId: message?.taskId };
  }

  /** Concatenate the text of every {@link https://github.com/a2aproject/A2A TextPart} in `parts`
   * (ignoring file/data parts), or `''` when there is no text part. */
  private static extractText(parts: Part[] | undefined): string {
    if (!parts || parts.length === 0) return '';
    return parts
      .filter((part): part is Extract<Part, { kind: 'text' }> => part?.kind === 'text')
      .map((part) => part.text)
      .join('\n');
  }
}
