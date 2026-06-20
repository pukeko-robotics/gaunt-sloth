/**
 * @module A2AClientWrapper
 * Wrapper for A2A (Agent-to-Agent) protocol client.
 * @experimental A2A support is experimental and may change.
 */
import { A2AClient } from '@a2a-js/sdk/client';
import { debugLog, debugLogError } from '@gaunt-sloth/core/utils/debugUtils.js';
import { v4 as uuidv4 } from 'uuid';

/** Configuration for A2A client */
export interface A2AClientConfig {
  /** Unique identifier for the agent */
  agentId: string;
  /** URL endpoint for the A2A agent */
  agentUrl: string;
}

/**
 * Wrapper around the A2A SDK client for communicating with external agents.
 * @experimental
 */
export class A2AClientWrapper {
  private client: A2AClient;
  private config: A2AClientConfig;

  constructor(config: A2AClientConfig) {
    this.config = config;
    // Initialize with agent URL. The SDK will fetch the agent card.
    this.client = new A2AClient(config.agentUrl);
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
      const messageId = uuidv4();
      const response = await this.client.sendMessage({
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
}
