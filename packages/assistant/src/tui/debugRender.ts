import type { BaseMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';

/**
 * Pure renderers turning the deep agent's debug captures into the JSON strings the `/debug`
 * panel shows. Kept React-free so they are unit-testable in isolation; the panel just splits
 * the result on newlines into its bounded viewport.
 */

/**
 * Render "Sent to model (full history)": the real `request.messages` at call time. Uses
 * LangChain's `mapChatMessagesToStoredMessages` so each message is a plain, JSON-stable record
 * (type + content + kwargs) rather than a class instance. Defensive: a non-serializable payload
 * degrades to a readable fallback instead of throwing inside the render path.
 */
export function renderHistory(messages: BaseMessage[]): string {
  try {
    const stored = mapChatMessagesToStoredMessages(messages);
    return JSON.stringify(stored, null, 2);
  } catch (err) {
    return `(could not render history: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Render "Raw model response": the resolved `AIMessage` returned by the handler. We try the
 * stored-message form first (consistent with the history view); if the value is not a chat
 * message we fall back to a plain JSON dump, then to `String()`.
 */
export function renderResponse(response: unknown): string {
  try {
    if (isBaseMessage(response)) {
      return JSON.stringify(mapChatMessagesToStoredMessages([response]), null, 2);
    }
    return JSON.stringify(response, null, 2);
  } catch (err) {
    return `(could not render response: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function isBaseMessage(value: unknown): value is BaseMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof (value as { _getType?: unknown })._getType === 'function'
  );
}
