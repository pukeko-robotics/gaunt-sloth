/**
 * [[EXT-159]] — **ACP's own stop reasons are mapped onto, never forked.**
 *
 * Node scope (d) mandates one shared classification because several consumers read the same
 * answer — a retry posture, a "never retry a 400, a 429 is a different case" ruling, a
 * nudge-or-back-off decision. An editor speaking ACP is a fourth, and ACP maintains a `StopReason`
 * vocabulary of its own. A second vocabulary grown beside the taxonomy is how two answers to "why
 * did this end" come to disagree, and the editor's is the one the user sees.
 *
 * Two properties are what keep the map honest, and both are asserted here rather than trusted:
 * it covers every category (a 23rd member must not silently report as `end_turn`), and it says
 * `null` for the categories the closed vocabulary cannot state instead of picking the nearest wrong
 * word.
 */
import { describe, expect, it } from 'vitest';
import {
  ACP_ERROR_STOP_REASON,
  acpStopReasonFor,
  acpTerminationMeta,
  type AcpClosedStopReason,
} from '#src/modules/acp/acpStopReason.js';
import {
  terminationReason,
  type GthTerminationCategory,
} from '@gaunt-sloth/core/core/terminationReason.js';

/** Written out rather than reflected, for the reason the label table is a `Record`. */
const EVERY_CATEGORY: readonly GthTerminationCategory[] = [
  'completed',
  'empty_response',
  'content_refusal',
  'output_truncated',
  'context_overflow',
  'rate_limited',
  'auth_failed',
  'invalid_request',
  'provider_error',
  'network_error',
  'timeout',
  'cancelled',
  'approval_stop',
  'tool_error_budget',
  'tool_loop_guard',
  'interrupt_drain_guard',
  'tool_error',
  'suspended',
  'recursion_limit',
  'abandoned',
  'unknown',
];

/** v1's union, which is closed — nothing outside this may be returned for either dialect. */
const CLOSED: readonly AcpClosedStopReason[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
];

const mapped = (category: GthTerminationCategory) =>
  acpStopReasonFor(terminationReason('runner.stream-error', 'exception', category));

describe('[[EXT-159]] mapping the taxonomy onto ACP’s stop reasons', () => {
  it('answers for every category, and never outside the closed vocabulary', () => {
    for (const category of EVERY_CATEGORY) {
      const reason = mapped(category);
      if (reason !== null) expect(CLOSED).toContain(reason);
    }
  });

  it('states the endings the vocabulary really has a word for', () => {
    expect(mapped('completed')).toBe('end_turn');
    expect(mapped('content_refusal')).toBe('refusal');
    expect(mapped('output_truncated')).toBe('max_tokens');
    expect(mapped('cancelled')).toBe('cancelled');
    // The gate declining to continue is what ACP's `refusal` says, and nothing broke — routing it
    // to an error would show a crash for a decision.
    expect(mapped('approval_stop')).toBe('refusal');
  });

  /**
   * The pair the mapping most easily gets wrong. `max_tokens` states the OUTPUT cap; a context
   * overflow is the INPUT window. They are the two bounds with different remedies — ask for a
   * shorter answer versus send a smaller prompt — so a client acting on one for the other acts
   * wrongly, and the taxonomy carries them as separate categories precisely because of that.
   */
  it('does not report a full input window as the output cap', () => {
    expect(mapped('output_truncated')).toBe('max_tokens');
    expect(mapped('context_overflow')).toBeNull();
  });

  it('says null for every ending the closed vocabulary cannot state', () => {
    for (const category of [
      'context_overflow',
      'rate_limited',
      'auth_failed',
      'invalid_request',
      'provider_error',
      'network_error',
      'timeout',
      'tool_error',
      'unknown',
    ] as const) {
      expect(mapped(category)).toBeNull();
    }
  });

  /**
   * An unclassified ending is a site we missed. Guessing `end_turn` for it would claim the model
   * finished on exactly the turns where nobody knows what happened — the false-completion defect
   * this taxonomy exists to remove.
   */
  it('treats an unclassified ending as one the vocabulary cannot state', () => {
    expect(acpStopReasonFor(null)).toBeNull();
    expect(acpStopReasonFor(undefined)).toBeNull();
  });

  it('offers one custom reason for v2 rather than one per category', () => {
    // v2 reserves custom stop reasons to names beginning with an underscore, and a client cannot be
    // expected to learn our taxonomy from this field — the structured value beside it is what it
    // should read.
    expect(ACP_ERROR_STOP_REASON.startsWith('_')).toBe(true);
  });

  describe('the structured half that rides alongside', () => {
    it('carries the whole classification under a namespaced key', () => {
      const reason = terminationReason('runner.stream-error', 'exception', {
        category: 'rate_limited',
        provider: 'openai',
        detail: '429',
      });

      expect(acpTerminationMeta(reason)).toEqual({
        'gauntSloth/terminationReason': {
          category: 'rate_limited',
          site: 'runner.stream-error',
          source: 'exception',
          provider: 'openai',
          detail: '429',
          retryableAsIs: false,
          retryableAfterRemedy: true,
          remedy: 'back-off',
        },
      });
    });

    /** A client must be able to tell "we did not classify this" from "we classified it as nothing". */
    it('offers nothing at all for an unclassified ending', () => {
      expect(acpTerminationMeta(null)).toBeUndefined();
    });
  });
});
