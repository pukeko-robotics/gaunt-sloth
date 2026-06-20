import type { BaseMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { z } from 'zod';
import type { DebugRequestExtras, DebugToolDef } from '@gaunt-sloth/agent/core/debugCapture.js';

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

/**
 * Render "Sent to model (request)": the non-message parts that also shape a turn — the
 * system prompt, the tool definitions, the tool-choice config and the scalar model params.
 * These come pre-filtered (key-free) from the capture site; this renderer only formats them
 * readably. Each part degrades to a note rather than throwing, so the `/debug` panel never
 * blanks on an odd payload. This is the long content TUI-C4's maximise makes usable.
 */
export function renderRequestDetails(extras: DebugRequestExtras | undefined): string {
  if (!extras) return '(no request details captured yet)';
  const sections: string[] = [];

  sections.push('=== MODEL PARAMS ===');
  sections.push(extras.modelParams ? safeJson(extras.modelParams) : '(no model params captured)');

  if (extras.toolChoice !== undefined) {
    sections.push('');
    sections.push('=== TOOL CHOICE ===');
    sections.push(safeJson(extras.toolChoice));
  }

  sections.push('');
  sections.push('=== SYSTEM PROMPT ===');
  sections.push(extras.systemPrompt ? extras.systemPrompt : '(no system prompt captured)');

  sections.push('');
  sections.push(`=== TOOL DEFINITIONS (${extras.tools?.length ?? 0}) ===`);
  if (extras.tools && extras.tools.length > 0) {
    for (const tool of extras.tools) sections.push(renderToolDef(tool));
  } else {
    sections.push('(no tools captured)');
  }

  return sections.join('\n');
}

/** Format one tool definition: name, description, then its JSON-schema params. */
function renderToolDef(tool: DebugToolDef): string {
  const lines: string[] = [`• ${tool.name}`];
  if (tool.description) {
    for (const d of tool.description.split('\n')) lines.push(`    ${d}`);
  }
  const schema = renderToolSchema(tool.schema);
  if (schema) {
    lines.push('    params:');
    for (const s of schema.split('\n')) lines.push(`      ${s}`);
  }
  return lines.join('\n');
}

/**
 * Render a tool's parameter schema. LangChain tools carry either a Zod schema or an already
 * JSON-schema-shaped object; we convert Zod via `zodToJsonSchema` and fall back to a plain
 * JSON dump (then to nothing) so an unusual shape never throws inside the render path.
 */
function renderToolSchema(schema: unknown): string | undefined {
  if (schema === undefined || schema === null) return undefined;
  try {
    if (isZodSchema(schema)) {
      // Zod v4 ships a native JSON-schema converter; this is the canonical params shape.
      return JSON.stringify(z.toJSONSchema(schema as z.ZodType), null, 2);
    }
    return JSON.stringify(schema, null, 2);
  } catch {
    // A non-convertible schema (odd shape / unsupported node) must never blank the panel.
    try {
      return JSON.stringify(schema, null, 2);
    } catch {
      return undefined;
    }
  }
}

function isZodSchema(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('_def' in (value as Record<string, unknown>) ||
      typeof (value as { safeParse?: unknown }).safeParse === 'function')
  );
}

/** JSON.stringify that degrades to a readable note instead of throwing on odd values. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return `(could not render: ${err instanceof Error ? err.message : String(err)})`;
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
