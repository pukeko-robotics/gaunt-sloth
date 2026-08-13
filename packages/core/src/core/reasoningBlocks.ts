/**
 * @packageDocumentation
 * CFG-33 — the bridge between a provider's reasoning SHAPE and gaunt-sloth's reasoning channel, for
 * the providers that carry thinking INSIDE `content` rather than beside it.
 *
 * Most providers hand thinking over out-of-band, in `additional_kwargs.reasoning_content` (or
 * `reasoning`), which {@link pickReasoningDelta} in `GthAbstractAgent` reads. Google Gemini does not:
 * a thought summary arrives as a content BLOCK marked `thought: true` and typed exactly like an
 * answer block (`type: 'text'`). Two consequences follow, and the second is the dangerous one:
 *
 *  1. `additional_kwargs` carries nothing, so the reasoning channel stays empty — the `/reasoning`
 *     panel shows nothing at all on `google-genai`/`vertexai`.
 *  2. `BaseMessage.text` maps every `type: 'text'` block, so the thought summary is folded into the
 *     ANSWER — it would print inline in the answer on every surface, and into `writeOutputToFile`.
 *
 * These helpers classify content once, so each consumer can take the half it wants. They are pure,
 * shape-driven and provider-agnostic: content that carries no reasoning block is passed through with
 * byte-identical results (and, for {@link stripReasoningBlocks}, the very same array reference), so
 * no other provider's rendering changes.
 */

/** One classified slice of assistant output: answer prose vs. the model's thinking. */
export type ThinkSegment = { kind: 'answer' | 'reasoning'; text: string };

type ContentBlock = Record<string, unknown>;

function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this content block the model's THINKING rather than its answer?
 *
 * Deliberately narrow: ONLY Gemini's `thought: true` marker on an otherwise ordinary text block.
 * Providers whose thinking arrives as a distinct block TYPE (Anthropic's `thinking` blocks) are NOT
 * matched here — `BaseMessage.text` already excludes them from the answer, and their reasoning
 * already reaches the channel via `additional_kwargs.reasoning_content`, so matching them too would
 * emit that provider's thinking TWICE.
 */
export function isReasoningContentBlock(block: unknown): boolean {
  return isContentBlock(block) && block.thought === true && block.type === 'text';
}

/**
 * Classify an assistant message's `content` into ORDERED answer/reasoning segments, preserving the
 * order the model emitted them in (a thought summary that precedes the answer stays before it).
 *
 * The concatenation of the `answer` segments is EXACTLY what `BaseMessage.text` returns once the
 * reasoning blocks are removed — the same block rules, the same empty join — so for content that
 * carries no reasoning block this is a drop-in for `.text`.
 */
export function segmentAssistantContent(content: unknown): ThinkSegment[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'answer', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const segments: ThinkSegment[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.length > 0) segments.push({ kind: 'answer', text: block });
      continue;
    }
    if (!isContentBlock(block)) continue;
    const text = typeof block.text === 'string' ? block.text : '';
    if (text.length === 0) continue;
    if (isReasoningContentBlock(block)) {
      segments.push({ kind: 'reasoning', text });
    } else if (block.type === 'text') {
      segments.push({ kind: 'answer', text });
    }
  }
  return segments;
}

/**
 * The ANSWER text of an assistant message's content — what `BaseMessage.text` would return minus any
 * reasoning block. Used by the surfaces that render answer text directly and have never shown
 * reasoning (the plain console stream), so a thought summary cannot leak into the answer there.
 */
export function answerTextOf(content: unknown): string {
  return segmentAssistantContent(content)
    .filter((segment) => segment.kind === 'answer')
    .map((segment) => segment.text)
    .join('');
}

/**
 * The same content with its reasoning blocks removed, for consumers that render the block ARRAY
 * rather than its text (`renderAssistantContent` / `materializeBinaryOutputs` on the non-streaming
 * path). Returns the INPUT REFERENCE unchanged whenever nothing matched, so every other provider's
 * content object is untouched and identity comparisons still hold.
 *
 * A pure content transform with no opinion about graph state — what a caller does with the result is
 * the caller's argument to make. Every caller in this package only READS the result — rendering it,
 * or pulling a refusal's explanation out of it — so the message kept in state stays whole and its
 * thought parts (and any `thoughtSignature` riding with them) still replay to the provider as
 * history. The one caller that rewrites state instead is the subagent thought
 * redaction in `@gaunt-sloth/agent`, which strips a FINISHED subagent's own messages; why that costs
 * nothing is argued there.
 */
export function stripReasoningBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const kept = content.filter((block) => !isReasoningContentBlock(block));
  return kept.length === content.length ? content : kept;
}
