/**
 * @packageDocumentation
 * Type definitions for middleware configuration in Gaunt Sloth Assistant.
 *
 * Middleware provides hooks to intercept and control agent execution at critical points.
 * This module defines the configuration interfaces for both predefined and custom middleware.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AgentMiddleware } from 'langchain';

/**
 * Predefined middleware types that can be configured via JSON config.
 */
export type PredefinedMiddlewareName =
  | 'anthropic-prompt-caching'
  | 'summarization'
  | 'binary-content-injection';

/**
 * Configuration for Anthropic prompt caching middleware.
 */
export interface AnthropicPromptCachingConfig {
  /**
   * Cache TTL (time to live).
   * Examples: "5m" for 5 minutes, "1h" for 1 hour
   */
  ttl?: '5m' | '1h';
}

/**
 * Configuration for summarization middleware.
 */
export interface SummarizationConfig {
  /**
   * Model to use for summarization.
   * If not provided, uses the main LLM from config.
   */
  model?: BaseChatModel;
  /**
   * Maximum tokens before triggering summarization.
   * Set one of:
   */
  trigger?: {
    fraction?: number;
    tokens?: number;
    messages?: number;
  };
  /**
   * How many tokens, messages, or a fraction of context to keep.
   * Set one of:
   */
  keep?: {
    fraction?: number;
    tokens?: number;
    messages?: number;
  };
  /**
   * Custom prompt template for summarization.
   */
  summaryPrompt?: string;
}

/**
 * Configuration for image format transformation middleware.
 */
export interface ImageFormatTransformConfig {
  /**
   * Detail level for image processing.
   * Examples: "low", "high", "auto"
   */
  detail?: 'low' | 'high' | 'auto';
}

/**
 * Configuration for binary content injection middleware.
 * This middleware intercepts tool results containing binary data (images, PDFs, audio)
 * and injects them as HumanMessage content blocks.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BinaryContentInjectionConfig {
  // No additional configuration needed currently
  // Reserved for future options like max binary size, format filtering, etc.
}

/**
 * Union type of all predefined middleware configurations.
 */
export type PredefinedMiddlewareConfig =
  | ({ name: 'anthropic-prompt-caching' } & AnthropicPromptCachingConfig)
  | ({ name: 'summarization' } & SummarizationConfig)
  | ({ name: 'binary-content-injection' } & BinaryContentInjectionConfig);

/**
 * Middleware configuration that can be specified in JSON or JS config.
 * - String: Name of predefined middleware with default settings
 * - PredefinedMiddlewareConfig: Predefined middleware with custom settings (JSON compatible)
 * - CustomMiddleware: Custom middleware object (JS config only)
 */
export type MiddlewareConfig = string | PredefinedMiddlewareConfig | AgentMiddleware;
