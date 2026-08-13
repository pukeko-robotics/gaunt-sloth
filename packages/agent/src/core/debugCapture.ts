/**
 * @packageDocumentation
 * The debug-capture contract lives in `@gaunt-sloth/core`, beside the agent
 * ({@link import('@gaunt-sloth/core/core/GthLangChainAgent.js').GthLangChainAgent}) that installs
 * the `wrapModelCall` capture middleware. This module re-exports it so
 * `@gaunt-sloth/agent/core/debugCapture.js` importers (the TUI debug panel) resolve it here too.
 */
export type {
  DebugRequestExtras,
  DebugToolDef,
  DebugCapture,
  LastModelRequest,
} from '@gaunt-sloth/core/core/debugCapture.js';
export { extractDebugRequestExtras } from '@gaunt-sloth/core/core/debugCapture.js';
