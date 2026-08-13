/**
 * @packageDocumentation
 * CFG-42 — keep a subagent's private reasoning out of the result its parent reads.
 *
 * deepagents' `task` tool reports a delegation by taking the subagent's last AI message and reading
 * `BaseMessage.text`. Gemini returns a thought summary as a content block marked `thought: true` and
 * typed `text` exactly like an answer block, so `.text` folds the thinking into the answer and the
 * parent model receives the child's reasoning as its report. The two are concatenated with no
 * separator, so by the time the parent sees the `ToolMessage` there is nothing left to filter —
 * the redaction has to happen while the content is still a block array.
 *
 * **Where it happens, and why there.** `afterAgent` on the subagent is the last hook before `task`
 * builds its result, and that result is the only thing carrying the child's own message content that
 * escapes the child at all.
 *
 * **Why redacting a history costs nothing, not even a thought signature.** The redacted messages are
 * never sent to any provider again, by any path. `messages` is one of deepagents'
 * `EXCLUDED_STATE_KEYS`, so the child's history is discarded rather than merged into the parent's
 * state; and `afterAgent` is terminal — while this middleware declares no jump targets (`canJumpTo`),
 * the after-agent chain edges to `END` and the child's graph cannot re-enter the model either. Every
 * model call in the run has already happened. That is the whole argument, and it does not depend on
 * any provider's rebuild rules; the wire shape merely agrees, for anyone auditing it: what
 * `@langchain/google` puts on the wire for a replayed text part is `{ text }` alone — it drops
 * `thought` and `thoughtSignature` from text parts — and the signatures that matter ride on
 * `functionCall` parts (and on `tool_calls[].thoughtSignature`), which are typed `functionCall` and
 * therefore never matched.
 *
 * **Why not at the model.** The general-purpose subagent shares the parent's model instance, so
 * asking that instance to withhold summaries would blind the parent's own reasoning panel too. The
 * leak is about what a third party is HANDED, not about what the model produces.
 *
 * The match is `stripReasoningBlocks`' — shape-driven and provider-agnostic — so a message carrying
 * no reasoning block yields no state update at all and every other provider's content is untouched.
 */
import { stripReasoningBlocks } from '@gaunt-sloth/core/core/reasoningBlocks.js';
import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';
import { GENERAL_PURPOSE_SUBAGENT, type SubAgent } from 'deepagents';

/** Middleware name, so a test (and a `Loaded middleware:` line) can name it without a string copy. */
export const SUBAGENT_THOUGHT_REDACTION_MIDDLEWARE_NAME = 'GthSubagentThoughtRedaction';

/** The one AI-message field set that must survive a redaction untouched. */
function redactAssistantMessage(message: AIMessage, content: unknown): AIMessage {
  // Keep the concrete class (an AIMessageChunk stays a chunk) and the id — the messages reducer
  // REPLACES by id, so a copy that lost its id would be appended beside the original instead.
  // `tool_call_chunks` is an AIMessageChunk field and is carried only when the message has one: a
  // chunk rebuilt without it comes back with an EMPTY chunk list, which is a silent loss on the
  // streaming path (`AIMessage.isInstance` matches a chunk, so that path is a real one here).
  const Constructor = message.constructor as new (fields: Record<string, unknown>) => AIMessage;
  const chunks = (message as { tool_call_chunks?: unknown }).tool_call_chunks;
  return new Constructor({
    id: message.id,
    name: message.name,
    content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
    ...(chunks === undefined ? {} : { tool_call_chunks: chunks }),
  });
}

/**
 * Strip reasoning blocks from a subagent's assistant messages as its run ends, so the `task` tool
 * builds the parent's result from the answer alone. Returns NO state update when nothing matched,
 * which is what makes an ordinary (no-thought-part) delegation byte-identical rather than merely
 * equal.
 */
export function createSubagentThoughtRedactionMiddleware() {
  return createMiddleware({
    name: SUBAGENT_THOUGHT_REDACTION_MIDDLEWARE_NAME,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterAgent: (state: any) => {
      const messages: unknown = state?.messages;
      if (!Array.isArray(messages)) return undefined;
      const redacted: AIMessage[] = [];
      for (const message of messages) {
        if (!AIMessage.isInstance(message)) continue;
        const content = stripReasoningBlocks(message.content);
        // Identity, not equality: `stripReasoningBlocks` hands back the input reference whenever
        // no block matched, so this skips every message that carries no reasoning.
        if (content === message.content) continue;
        redacted.push(redactAssistantMessage(message, content));
      }
      return redacted.length > 0 ? { messages: redacted } : undefined;
    },
  });
}

/** Add the redaction middleware to a declarative subagent spec, keeping its own middleware. */
export function withThoughtRedaction(subagent: SubAgent): SubAgent {
  return {
    ...subagent,
    middleware: [
      ...((subagent as { middleware?: unknown[] }).middleware ?? []),
      createSubagentThoughtRedactionMiddleware(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
  };
}

/**
 * gsloth's copy of deepagents' default general-purpose subagent, carrying the redaction middleware.
 *
 * `createDeepAgent` adds its own general-purpose subagent only when no declared subagent already
 * claims that name, and it merges caller middleware into that one with `appendNew: false` — so a
 * middleware gsloth passes to `createDeepAgent` reaches the parent graph but NEVER the default
 * subagent. Declaring the subagent ourselves is the supported way in (deepagents documents the
 * "custom general-purpose variant" shape); everything else about it — the fs/todo/summarization
 * middleware, the permissions, the HITL gating — is still assembled by deepagents from the same spec
 * fields, because its own general-purpose subagent travels this exact code path.
 *
 * Name, description and prompt are spread from deepagents' exported constant so they track the
 * library. The live delta is the harness-profile prompt overlay deepagents applies to its own copy
 * (a `systemPromptSuffix` registered for some Anthropic and Codex model specs): the resolution behind
 * it is not exported.
 *
 * **Two library inputs are not reproduced here, and both must be forwarded the moment anything feeds
 * them.** `createDeepAgent` passes its own `skills` into its general-purpose spec, and the
 * general-purpose subagent is the ONLY subagent that inherits the main agent's skills — so if gsloth
 * ever passes `skills` to `createDeepAgent`, this spec has to carry them too, or that one subagent
 * silently loses its skills and the failure presents as a skills bug a long way from this file.
 * Likewise a harness profile's `generalPurposeSubagent` (`enabled` / `description` /
 * `systemPrompt`): no built-in profile sets one, but `registerHarnessProfile` is public API, and
 * declaring this subagent unconditionally would override a profile that set `enabled: false`.
 * Nothing feeds either today, so forwarding them now would ship an untested path.
 */
export function buildGeneralPurposeSubagent(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  tools: StructuredToolInterface[];
}): SubAgent {
  return withThoughtRedaction({
    ...GENERAL_PURPOSE_SUBAGENT,
    model: params.model,
    tools: params.tools as never,
  });
}
