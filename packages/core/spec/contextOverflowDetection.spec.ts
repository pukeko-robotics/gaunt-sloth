/**
 * [[EXT-160]] — **the two feeders behind one classification, pinned.**
 *
 * EXT-159 built `isContextOverflow` and the `context_overflow` posture row; this node depends on
 * both being exactly what they are, so the cells here fix the two properties a later change could
 * quietly take away without anything else going red:
 *
 * 1. **The predicate is the CLASS, never the code.** Anthropic stamps both
 *    `ContextOverflowError` and `lc_error_code: 'CONTEXT_OVERFLOW'`; OpenAI (and with it
 *    huggingface, xai and deepseek, which build on its chat classes) stamps only the class. So a
 *    detector keyed on the code silently loses most of the coverage, and it loses it without a
 *    single test failing — which is the whole reason for the pair of cells below: one asserts the
 *    class alone is enough, the other asserts the code alone is NOT, and only a detector reading the
 *    class passes both.
 * 2. **Our own prose fallback is ours.** LangChain's typing is substring matching on the provider's
 *    English, so a provider rewording its 400 un-types the error with nothing going red. The cell
 *    below feeds a message LangChain does not type at all (asserted, not assumed) and requires the
 *    classification anyway.
 *
 * And the posture, which is where this node's move lives: `context_overflow` is the one category
 * whose two retryability facts point opposite ways, and `output_truncated` is the neighbour that
 * must NOT be compacted.
 */
import { describe, expect, it } from 'vitest';
import { ContextOverflowError, getRetryable } from '@langchain/core/errors';
import {
  classifyThrownTermination,
  isContextOverflow,
  terminationPosture,
} from '#src/core/terminationReason.js';

describe('EXT-160 — the typed feeder is keyed on the class', () => {
  it('classifies a ContextOverflowError that carries NO lc_error_code', () => {
    // The OpenAI shape: the class, and nothing else to key on. Its message is deliberately prose no
    // pattern matches, so the substring fallback cannot be what rescues this cell.
    const error = new ContextOverflowError('the request was refused for size');
    expect((error as unknown as { lc_error_code?: string }).lc_error_code).toBeUndefined();
    expect(ContextOverflowError.isInstance(error)).toBe(true);

    expect(isContextOverflow(error)).toBe(true);
    expect(classifyThrownTermination(error).category).toBe('context_overflow');
  });

  it('does NOT classify on lc_error_code alone — the mutation a code-keyed detector would pass', () => {
    // The control that must survive: a detector rewritten to read `lc_error_code` would call this
    // an overflow, and would still pass the cell above. Only a class-keyed detector fails it — so
    // this is the cell that discriminates between the two implementations.
    const codeOnly = Object.assign(new Error('the request was refused for size'), {
      lc_error_code: 'CONTEXT_OVERFLOW',
    });
    expect(ContextOverflowError.isInstance(codeOnly)).toBe(false);

    expect(isContextOverflow(codeOnly)).toBe(false);
    expect(classifyThrownTermination(codeOnly).category).not.toBe('context_overflow');
  });

  it('classifies by name when the class identity is lost across a module boundary', () => {
    // A dual-install of `@langchain/core` breaks `isInstance` while leaving the name intact; the
    // name check is the leg that survives it.
    const renamed = Object.assign(new Error('the request was refused for size'), {
      name: 'ContextOverflowError',
    });
    expect(ContextOverflowError.isInstance(renamed)).toBe(false);
    expect(isContextOverflow(renamed)).toBe(true);
  });
});

describe('EXT-160 — our own prose fallback stands independently of LangChain', () => {
  // Each of these is a provider's own wording. None of them is a `ContextOverflowError`, and the
  // assertion in the cell proves it, so nothing here can be passing on LangChain's typing.
  const untypedOverflows = [
    "This model's maximum context length is 8192 tokens, however you requested 9001.",
    'input tokens exceed the configured limit for this deployment',
    'prompt is too long: 210000 tokens > 200000 maximum',
    'Request too large for gpt-4 in organization org-x',
  ];

  it.each(untypedOverflows)('classifies %s', (message) => {
    const error = new Error(message);
    expect(ContextOverflowError.isInstance(error)).toBe(false);
    expect(error.name).toBe('Error');

    expect(isContextOverflow(error)).toBe(true);
    expect(classifyThrownTermination(error).category).toBe('context_overflow');
  });

  it('leaves an unrelated 400 alone — the control that must survive', () => {
    // Without this, a fallback widened to "any 400" would pass every cell above.
    const error = Object.assign(new Error('invalid tool schema: unknown keyword'), {
      status: 400,
    });
    expect(isContextOverflow(error)).toBe(false);
    expect(classifyThrownTermination(error).category).not.toBe('context_overflow');
  });
});

describe('EXT-160 — retryability is two facts, not one', () => {
  it('separates retrying the same prompt from retrying a smaller one', () => {
    const posture = terminationPosture('context_overflow');
    // Retrying the identical prompt is hopeless...
    expect(posture.retryableAsIs).toBe(false);
    // ...and this is the same thing LangChain's own error says about itself, which is exactly right
    // for the prompt as sent and exactly wrong for the one compaction is about to send. A consumer
    // honouring `getRetryable()` correctly would refuse to do what this node exists to do, which is
    // why the taxonomy carries the second fact separately.
    expect(getRetryable(new ContextOverflowError('too long'))).toBe(false);
    // ...but retrying a SMALLER one is the whole move, and the remedy names which smaller.
    expect(posture.retryableAfterRemedy).toBe(true);
    expect(posture.remedy).toBe('reduce-context');
  });

  it('does not offer compaction as the remedy for a truncated OUTPUT', () => {
    // `remedy === 'reduce-context'` is the literal predicate the compact-and-retry seam reads, so
    // this cell is what keeps an answer cut off against the output cap out of the compaction path:
    // folding the history adds no room to the part that ran out.
    const posture = terminationPosture('output_truncated');
    expect(posture.remedy).toBe('change-request');
    expect(posture.remedy).not.toBe('reduce-context');
  });
});
