/**
 * @module A2AClientWrapper
 * Wrapper for A2A (Agent-to-Agent) protocol client.
 * @experimental A2A support is experimental and may change.
 */
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import { Role, type Message, type Part, type Task } from '@a2a-js/sdk';
import { debugLog, debugLogError } from '@gaunt-sloth/core/utils/debugUtils.js';
import { v4 as uuidv4 } from 'uuid';

/** The A2A spec's well-known agent-card path. The SDK's resolver needs the full CARD url, whereas
 * {@link A2AClientConfig.agentUrl} is the agent's BASE url — so we append this ourselves and hand
 * the resolver an empty relative path, keeping the fetched card URL byte-identical to what the
 * pre-1.0 `A2AClient` string constructor produced. (Letting the resolver append its own default
 * would resolve the path RELATIVE to the base url, silently dropping a base path segment: for
 * `http://host/a2a` it would fetch `http://host/.well-known/agent-card.json`.) */
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
  private clientPromise: Promise<Client>;
  private config: A2AClientConfig;

  constructor(config: A2AClientConfig) {
    this.config = config;
    // `@a2a-js/sdk` 1.0 removed the `A2AClient` class outright; a client is now built by a
    // `ClientFactory` from the agent card. `legacyCompat` is enabled on the card resolver AND on
    // every transport factory so we keep talking to agents still on protocol v0.3 — which is what
    // Google ADK agents (our only real A2A peer today, see adk-eval-it/) currently speak. With it
    // on, the resolver detects a v0.3-shaped card, translates it to the v1.0 model and stamps each
    // synthesized interface `protocolVersion: '0.3'`, and the matching factory then instantiates
    // the v0.3 wire transport. A v1.0 agent is served by the native transports unchanged, so this
    // wrapper speaks to both.
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        cardResolver: new DefaultAgentCardResolver({ legacyCompat: { enabled: true } }),
        transports: [
          new JsonRpcTransportFactory({ legacyCompat: { enabled: true } }),
          new RestTransportFactory({ legacyCompat: { enabled: true } }),
        ],
      })
    );
    // Client construction is async (it fetches the card), so we hold the promise and await it per
    // send. Empty path = "the base url IS the card url" — see AGENT_CARD_PATH.
    const cardUrl = `${config.agentUrl.replace(/\/+$/, '')}/${AGENT_CARD_PATH}`;
    this.clientPromise = factory.createFromUrl(cardUrl, '');
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
      const result = await client.sendMessage(
        A2AClientWrapper.buildSendRequest(messageText, uuidv4())
      );

      debugLog(`Received response from A2A agent: ${JSON.stringify(result)}`);

      return A2AClientWrapper.extractResult(result).text;
    } catch (error) {
      debugLogError('Error sending message to A2A agent', error);
      throw error;
    }
  }

  /**
   * BATCH-14 — send one message and return its text ALONG WITH the A2A `contextId`/`taskId` needed to
   * thread a multi-turn conversation. Reads the real `@a2a-js/sdk` result shapes rather than a
   * loose envelope:
   *
   * - A **Message** result carries its text in `parts` and `contextId`/`taskId` directly (both
   *   optional, and empty-string when absent in the v1.0 proto model).
   * - A **Task** result — what Google ADK agents commonly return — carries text in
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
      const result = await client.sendMessage(
        A2AClientWrapper.buildSendRequest(messageText, uuidv4(), context)
      );

      debugLog(`Received response from A2A agent: ${JSON.stringify(result)}`);

      return A2AClientWrapper.extractResult(result);
    } catch (error) {
      debugLogError('Error sending message (with context) to A2A agent', error);
      throw error;
    }
  }

  /** Build the outgoing `SendMessageRequest`. The v1.0 data model is generated from the A2A
   * protobufs, so every field is required rather than optional: `role` is the numeric {@link Role}
   * enum (not `'user'`), a text part is `{ content: { $case: 'text', value } }` (not
   * `{ kind: 'text', text }`), and the continuity handles are empty strings rather than absent
   * when there is no conversation to continue. */
  private static buildSendRequest(
    messageText: string,
    messageId: string,
    context?: A2ASendContext
  ) {
    const message: Message = {
      messageId,
      contextId: context?.contextId ?? '',
      taskId: context?.taskId ?? '',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'text', value: messageText },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    return { tenant: '', message, configuration: undefined, metadata: undefined };
  }

  /** Normalize a `Message | Task` A2A result into text + continuity handles (BATCH-14). Static +
   * tolerant of missing optional fields so it can be reused and unit-tested directly. */
  private static extractResult(result: Message | Task): A2AMessageResult {
    if (A2AClientWrapper.isTask(result)) {
      const statusParts = result.status?.message?.parts;
      const artifactParts = result.artifacts?.[result.artifacts.length - 1]?.parts;
      const text =
        A2AClientWrapper.extractText(statusParts ?? artifactParts) || JSON.stringify(result);
      return {
        text,
        contextId: result.contextId || undefined,
        taskId: result.id || undefined,
      };
    }
    const text = A2AClientWrapper.extractText(result?.parts) || JSON.stringify(result);
    // The proto model uses '' (not undefined) for an absent id; normalize back to undefined so a
    // caller can't thread an empty handle into the next turn.
    return {
      text,
      contextId: result?.contextId || undefined,
      taskId: result?.taskId || undefined,
    };
  }

  /** v1.0 dropped the `kind` discriminator that told a Message from a Task, so discriminate
   * structurally: `messageId` is required on every Message and never present on a Task. */
  private static isTask(result: Message | Task): result is Task {
    return typeof (result as Message)?.messageId !== 'string';
  }

  /** Concatenate the text of every {@link https://github.com/a2aproject/A2A TextPart} in `parts`
   * (ignoring file/data parts), or `''` when there is no text part. */
  private static extractText(parts: Part[] | undefined): string {
    if (!parts || parts.length === 0) return '';
    return parts
      .filter((part) => part?.content?.$case === 'text')
      .map((part) => part.content?.value as string)
      .join('\n');
  }
}
