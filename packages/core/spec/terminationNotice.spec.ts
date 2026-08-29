/**
 * [[EXT-159]] — the shared renderer every surface says the reason through.
 *
 * The surfaces themselves are covered one cell each (`terminationLiveSession.spec.ts` here, and its
 * siblings in the agent, app and review packages). This file covers the thing they all call, and
 * the two rules it exists to hold:
 *
 * 1. **Nothing is invented for an absent reason.** The taxonomy defines a missing reason as a
 *    termination site nobody classified. A renderer that filled one in with `unknown`, `completed`
 *    or a placeholder would silence exactly the detector that definition provides — so the cells
 *    below assert what is NOT said as hard as what is.
 * 2. **The prose is derived, never authoritative.** The reason value is what travels; the words are
 *    a function of it. That is what lets the surface cells read a classification structurally
 *    instead of matching a sentence, and it is an acceptance clause of the node.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  displayTermination,
  shouldAnnounceTermination,
  TERMINATION_NOTICE_TITLE_PREFIX,
  terminationCode,
  terminationLogLine,
  terminationNotice,
} from '#src/core/terminationNotice.js';
import {
  terminationReason,
  type GthTerminationCategory,
  type GthTerminationReason,
} from '#src/core/terminationReason.js';

/**
 * Every category, written out rather than derived from the type.
 *
 * A list built by reflection over whatever the module happens to export would grow silently with
 * the taxonomy and prove nothing about a member nobody thought about. Written here, a 23rd category
 * fails this file until somebody looks at it — which is the same reason the label table is a
 * `Record` rather than a `switch`.
 */
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

const reasonFor = (category: GthTerminationCategory): GthTerminationReason =>
  terminationReason('runner.stream-error', 'exception', category);

describe('[[EXT-159]] rendering a termination reason for a person', () => {
  describe('the category labels', () => {
    it('gives every category words of its own', () => {
      const titles = EVERY_CATEGORY.map((category) => terminationNotice(reasonFor(category)).title);
      // Distinct, so no two causes reach the screen reading identically — the flattening this node
      // exists to undo, reintroduced one layer up in the renderer.
      expect(new Set(titles).size).toBe(EVERY_CATEGORY.length);
      for (const title of titles)
        expect(title.startsWith(TERMINATION_NOTICE_TITLE_PREFIX)).toBe(true);
    });

    it('never falls back to the unknown wording for a category that is not unknown', () => {
      const unknownTitle = terminationNotice(reasonFor('unknown')).title;
      for (const category of EVERY_CATEGORY) {
        if (category === 'unknown') continue;
        expect(terminationNotice(reasonFor(category)).title).not.toBe(unknownTitle);
      }
    });
  });

  describe('the quotable code — the fact a bug report has to carry', () => {
    /**
     * The discriminating pair. `empty_response` is the taxonomy's own standing example of a
     * category two sites reach with opposite meanings: at `runner.empty-after-fallback` the as-is
     * retry has already been spent, at `runner.events-empty` it has not. A code that named only the
     * category would be identical for both, and a maintainer holding it would be back where the
     * untyped sentence left them.
     */
    it('names the site as well as the category, so two sites never quote alike', () => {
      const spent = terminationReason('runner.empty-after-fallback', 'control', 'empty_response');
      const fresh = terminationReason('runner.events-empty', 'control', 'empty_response');

      expect(spent.category).toBe(fresh.category);
      expect(terminationCode(spent)).not.toBe(terminationCode(fresh));
      expect(terminationCode(spent)).toContain('runner.empty-after-fallback');
      expect(terminationCode(fresh)).toContain('runner.events-empty');
    });

    it('puts the code in the notice body, where a user can copy it', () => {
      const reason = terminationReason('runner.stream-error', 'exception', 'rate_limited');
      expect(terminationNotice(reason).lines.join('\n')).toContain(terminationCode(reason));
    });
  });

  describe('the retry advice', () => {
    /**
     * Read off the reason's OWN posture fields rather than re-derived from the category here. Two
     * tables that decide retryability are two answers to the same question, and the taxonomy exists
     * so there is one — so this cell hands the renderer a reason whose posture disagrees with what
     * its category would say and asserts the renderer follows the reason.
     */
    it('follows the posture carried on the reason, not a second opinion about the category', () => {
      const asIs: GthTerminationReason = {
        ...reasonFor('rate_limited'),
        retryableAsIs: true,
        retryableAfterRemedy: false,
      };
      expect(terminationNotice(asIs).lines.join('\n')).toContain('same request again may work');
    });

    it('names the remedy when one is what makes a retry worth making', () => {
      const overflow = terminationReason('runner.stream-error', 'exception', 'context_overflow');
      expect(overflow.remedy).toBe('reduce-context');
      expect(terminationNotice(overflow).lines.join('\n')).toContain('Send less');
    });

    it('says a retry will not help when neither field offers one', () => {
      const invalid = terminationReason('runner.turn-error', 'exception', 'invalid_request');
      expect(terminationNotice(invalid).lines.join('\n')).toContain('will not help');
    });
  });

  describe('what is worth announcing', () => {
    it('says nothing for the ordinary end of a turn', () => {
      expect(shouldAnnounceTermination(reasonFor('completed'))).toBe(false);
    });

    /** A suspended graph is PAUSED, not ended: announcing it reports the middle of a turn as its end. */
    it('says nothing for a turn that is merely parked', () => {
      expect(shouldAnnounceTermination(reasonFor('suspended'))).toBe(false);
    });

    /**
     * [[TUI-C62]] is the reason this is not left out as self-explanatory: a split meta-key sequence
     * aborts a streaming turn, and the user did not knowingly press anything. That is the shape the
     * node names as getting misattributed to the provider for months.
     */
    it('announces a cancellation, which the user may not have asked for', () => {
      expect(shouldAnnounceTermination(reasonFor('cancelled'))).toBe(true);
    });

    it('announces every other category', () => {
      for (const category of EVERY_CATEGORY) {
        if (category === 'completed' || category === 'suspended') continue;
        expect(shouldAnnounceTermination(reasonFor(category))).toBe(true);
      }
    });
  });

  describe('the absence — the reading the whole contract rests on', () => {
    it('states an unclassified ending as an absence, and never as a category', () => {
      const line = terminationLogLine(null);
      expect(line).toContain('UNCLASSIFIED');
      // Not dressed up as any member of the taxonomy: `completed` would claim the turn went well,
      // `unknown` would claim a site looked and could not tell. Neither happened.
      expect(line).not.toContain('category=');
      expect(line).toContain('site');
    });

    it('states the whole classification when there is one', () => {
      const reason = terminationReason('runner.stream-error', 'exception', {
        category: 'rate_limited',
        provider: 'openai',
        detail: '429',
      });
      const line = terminationLogLine(reason);
      expect(line).toContain('category=rate_limited');
      expect(line).toContain('site=runner.stream-error');
      expect(line).toContain('source=exception');
      expect(line).toContain('provider=openai');
      expect(line).toContain('detail=429');
      expect(line).toContain('remedy=back-off');
    });
  });

  describe('displaying it on a console surface', () => {
    let warned: string[];
    let shown: string[];

    beforeEach(async () => {
      warned = [];
      shown = [];
      const consoleUtils = await import('#src/utils/consoleUtils.js');
      vi.spyOn(consoleUtils, 'displayWarning').mockImplementation((m: string) => {
        warned.push(m);
      });
      vi.spyOn(consoleUtils, 'display').mockImplementation((m: string) => {
        shown.push(m);
      });
    });

    afterEach(() => vi.restoreAllMocks());

    it('shows the title and the body when the ending is worth reporting', () => {
      const reason = terminationReason('runner.stream-error', 'exception', 'provider_error');

      expect(displayTermination(reason)).toBe(true);
      expect(warned).toEqual([terminationNotice(reason).title]);
      expect(shown.join('\n')).toContain(terminationCode(reason));
    });

    it('says nothing at all when the model simply finished', () => {
      expect(displayTermination(reasonFor('completed'))).toBe(false);
      expect(warned).toEqual([]);
      expect(shown).toEqual([]);
    });

    /**
     * **An absence is reported to US, not to the user.** It means a site we missed, which is a
     * defect signal for a maintainer reading the log or the dump; telling the person at the
     * terminal "something ended and we do not know what" on every turn a surface could not classify
     * would be noise about our own blind spot. So it is written down and not shown.
     */
    it('writes an unclassified ending to the log and shows the user nothing', () => {
      expect(displayTermination(null)).toBe(false);
      expect(warned).toEqual([]);
      expect(shown).toEqual([]);
    });
  });
});
