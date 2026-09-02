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

    /**
     * The runtime floor under the label lookup, pinned so it is not read as dead code and deleted.
     *
     * Every category in the union has an entry, so this branch is unreachable for a value the
     * compiler checked — and that is the point: the values that reach here unchecked are the ones
     * that came from outside the type system, read back off an ACP `_meta`, handed over by an
     * embedder, or revived from a dump. The failure it prevents is the literal string `undefined`
     * appearing in the one line the user is shown, so that is what is asserted, not merely that
     * some title comes back.
     *
     * The cast is deliberate and is the whole subject: no well-typed caller can produce this.
     */
    it('renders a category from outside the union as unrecognised, never as the word undefined', () => {
      const offTaxonomy = {
        ...reasonFor('unknown'),
        category: 'a_category_from_a_newer_build' as GthTerminationCategory,
      };

      const title = terminationNotice(offTaxonomy).title;

      expect(title).not.toContain('undefined');
      expect(title).toBe(terminationNotice(reasonFor('unknown')).title);
      // And the discriminating half still travels: the code carries the category verbatim, so the
      // fallback softens the WORDS without ever hiding which category it was.
      expect(terminationCode(offTaxonomy)).toContain('a_category_from_a_newer_build');
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

  /**
   * [[EXT-165]] — the notice reaches the screen as ONE call to the ONE notice writer.
   *
   * These cells spy on `displayNotice` rather than on the title/body pair this used to make, and
   * that is the point rather than an adaptation: while the title went through `displayWarning` and
   * the body through `display`, the two halves took different streams and different level gates, so
   * a redirect kept one and a quieted console dropped the other. Asserting the whole notice is
   * handed over in a single call is what stops it being split again here.
   *
   * **Which descriptor that call lands on is asserted where it can be measured** — in a real
   * process with two separate pipes, `packages/core/spec/noticeStreamProcess.e2e.spec.ts`. A spy
   * cannot see a stream: it replaces the very mapping that is the claim.
   */
  describe('displaying it on a console surface', () => {
    let notices: Array<{ title: string; lines: readonly string[]; gate?: unknown; tone?: unknown }>;

    beforeEach(async () => {
      notices = [];
      const consoleUtils = await import('#src/utils/consoleUtils.js');
      vi.spyOn(consoleUtils, 'displayNotice').mockImplementation(
        (title: string, lines: readonly string[], options = {}) => {
          notices.push({ title, lines, ...options });
        }
      );
    });

    afterEach(() => vi.restoreAllMocks());

    it('hands the title and the body to one writer, as one notice', () => {
      const reason = terminationReason('runner.stream-error', 'exception', 'provider_error');

      expect(displayTermination(reason)).toBe(true);
      expect(notices.length).toBe(1);
      expect(notices[0].title).toBe(terminationNotice(reason).title);
      expect(notices[0].lines.join('\n')).toContain(terminationCode(reason));
      // The whole body, not a prefix of it: the retry advice is the line a user acts on.
      expect(notices[0].lines).toEqual(terminationNotice(reason).lines);
    });

    /**
     * **Never level-gated.** {@link terminationCode} is the token a bug report is built from, and
     * the two places it would otherwise survive — the session log and the debug log — are both off
     * by default, so a gate here is a reason code that reaches nobody. Only an abnormal ending
     * reaches this function at all, so nothing ordinary is made louder by it.
     */
    it('asks for the notice to survive any console level', () => {
      expect(displayTermination(reasonFor('provider_error'))).toBe(true);
      expect(notices[0].gate).toBe('always');
      // Warn-toned, which is what puts the marker in the text as well as the colour.
      expect(notices[0].tone).toBe('warn');
    });

    it('says nothing at all when the model simply finished', () => {
      expect(displayTermination(reasonFor('completed'))).toBe(false);
      expect(notices).toEqual([]);
    });

    /**
     * **An absence is reported to US, not to the user.** It means a site we missed, which is a
     * defect signal for a maintainer reading the log or the dump; telling the person at the
     * terminal "something ended and we do not know what" on every turn a surface could not classify
     * would be noise about our own blind spot. So it is written down and not shown.
     */
    it('writes an unclassified ending to the log and shows the user nothing', () => {
      expect(displayTermination(null)).toBe(false);
      expect(notices).toEqual([]);
    });
  });
});
