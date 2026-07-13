/**
 * @packageDocumentation
 * The debug-capture contract now lives in `@gaunt-sloth/core` so BOTH the lean
 * ({@link import('@gaunt-sloth/core/core/GthLangChainAgent.js').GthLangChainAgent}) and deep
 * ({@link import('#src/core/GthDeepAgent.js').GthDeepAgent}) backends can install the same
 * `wrapModelCall` capture middleware. This module re-exports it so existing
 * `@gaunt-sloth/agent/core/debugCapture.js` importers (the TUI debug panel) are unaffected.
 */
export type {
  DebugRequestExtras,
  DebugToolDef,
  DebugCapture,
} from '@gaunt-sloth/core/core/debugCapture.js';
export { extractDebugRequestExtras } from '@gaunt-sloth/core/core/debugCapture.js';
