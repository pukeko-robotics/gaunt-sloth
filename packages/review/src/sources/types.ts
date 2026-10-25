import type { GthConfig } from '@gaunt-sloth/core/config.js';

export interface ProviderConfig {
  username?: string;
  token?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

export interface JiraLegacyConfig extends ProviderConfig {
  username: string;
  baseUrl: string;
  displayUrl?: string;
  token: string;
}

export interface JiraConfig extends ProviderConfig {
  cloudId: string;
  username?: string;
  displayUrl?: string;
  token?: string;
  fullBase64Token?: string;
}

/**
 * Configuration for an A2A (Agent-to-Agent) protocol agent.
 * @experimental A2A support is experimental and may change.
 * @see {@link https://a2a-protocol.org/}
 */
export interface A2AConfig {
  /** Unique identifier for the agent, used in tool naming */
  agentId: string;
  /** URL endpoint for the A2A agent */
  agentUrl: string;
}

export interface Provider {
  /**
   * `context` carries the resolved config for a source that needs more than its own slice; the
   * `github` content source reads it to size a large pull request. Sources that do not need it
   * ignore it.
   */
  get: (
    config: ProviderConfig | null,
    id: string | undefined,
    context?: { config?: GthConfig }
  ) => Promise<string | null>;
}
