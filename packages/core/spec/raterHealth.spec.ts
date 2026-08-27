import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RATER_FAILURE_SIGNAL_THRESHOLD, RaterHealth } from '#src/core/shell/raterHealth.js';
import type { RaterCallReport } from '#src/core/shell/raterHealth.js';

/**
 * [[EXT-82]] — the SESSION-level half of the diagnostic: the rate at which rating calls fail,
 * reported once.
 *
 * The verdict-level half ({@link import('#src/core/shell/rater.js').failClosedVerdict}) explains
 * one occurrence. This explains a session in which the rater never answers at all — the measured
 * case, where 27 of 27 calls were rejected by the provider and nothing anywhere said the model was
 * never asked.
 *
 * Everything below is driven off the exported threshold rather than the literal 3, so the tests
 * measure the mechanism and not the number.
 */
describe('[[EXT-82]] RaterHealth — the signal is the RATE, raised once', () => {
  beforeEach(() => vi.resetAllMocks());

  const N = RATER_FAILURE_SIGNAL_THRESHOLD;

  /** A rejected call, as the runner reports one. */
  const rejected: RaterCallReport = {
    failClosed: 'threw',
    failure: { status: 400, message: 'tool_choice is not supported by this model' },
    model: 'openrouter/qwen-flash',
  };
  /** A call the model actually answered. */
  const answered: RaterCallReport = { model: 'openrouter/qwen-flash' };

  /** Feed `reports` in order and collect every signal that came back. */
  function run(health: RaterHealth, ...reports: RaterCallReport[]): string[] {
    return reports
      .map((report) => health.record(report))
      .filter((s): s is string => s !== undefined);
  }

  it('says nothing until the threshold is reached, then says it once', () => {
    const health = new RaterHealth();
    const belowThreshold = run(health, ...Array<RaterCallReport>(N - 1).fill(rejected));
    expect(belowThreshold, `${N - 1} failures is not yet a rate`).toEqual([]);

    const atThreshold = run(health, rejected);
    expect(atThreshold).toHaveLength(1);
    expect(atThreshold[0]).toContain(`the last ${N} rating calls`);
  });

  it('never repeats — a long run of failures still raises exactly one signal', () => {
    const health = new RaterHealth();
    const signals = run(health, ...Array<RaterCallReport>(N * 3).fill(rejected));
    expect(signals).toHaveLength(1);
  });

  /**
   * **The reset is what makes this a rate rather than a latch.** A rater that fails on one command
   * and answers on the next is a different situation from a rater that cannot answer at all, and a
   * counter that only ever climbed would report the two with the same sentence.
   */
  it('a single interleaved success resets the run, so neither half reaches the threshold', () => {
    const health = new RaterHealth();
    const signals = run(
      health,
      ...Array<RaterCallReport>(N - 1).fill(rejected),
      answered,
      ...Array<RaterCallReport>(N - 1).fill(rejected)
    );
    expect(signals, 'two short runs are not one long one').toEqual([]);
  });

  /**
   * The other direction of the same property: a reset restarts the count, it does not disable the
   * signal. Without this, "resets" could be satisfied by a counter that simply never fires again.
   */
  it('after a reset a FULL run still raises the signal', () => {
    const health = new RaterHealth();
    const signals = run(
      health,
      ...Array<RaterCallReport>(N - 1).fill(rejected),
      answered,
      ...Array<RaterCallReport>(N).fill(rejected)
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toContain(`the last ${N} rating calls`);
  });

  /**
   * **Per session, never per process.** The ACP surface serves several sessions from one process,
   * each with its own runner; module state here would let one session's broken rater raise the
   * signal in another's, and a healthy session would keep clearing a broken one's run.
   */
  it('two trackers do not share a count', () => {
    const broken = new RaterHealth();
    const healthy = new RaterHealth();
    for (let i = 0; i < N - 1; i += 1) {
      expect(broken.record(rejected)).toBeUndefined();
      expect(healthy.record(rejected)).toBeUndefined();
    }
    expect(healthy.record(answered), 'this session recovered').toBeUndefined();
    expect(broken.record(rejected), 'and this one did not').toBeDefined();
    expect(
      healthy.record(rejected),
      'the recovered session is still below the threshold'
    ).toBeUndefined();
  });

  /**
   * §3.2 — on an `approvals.allow` match the rating is a tripwire: the command runs on the human's
   * standing grant whatever the rater says, so a failed tripwire rating did not make any verdict
   * default and the signal's claim that they are would be false.
   */
  it('a tripwire rating that fails does not count toward the rate', () => {
    const health = new RaterHealth();
    const tripwire = { ...rejected, countsTowardRate: false };
    expect(run(health, ...Array<RaterCallReport>(N * 2).fill(tripwire))).toEqual([]);
  });

  it('but a tripwire rating the model ANSWERED still resets the run', () => {
    // The asymmetry is deliberate and can only make the signal fire LESS: a rater that answered is
    // a rater that works, whichever path asked it.
    const health = new RaterHealth();
    const signals = run(
      health,
      ...Array<RaterCallReport>(N - 1).fill(rejected),
      { ...answered, countsTowardRate: false },
      ...Array<RaterCallReport>(N - 1).fill(rejected)
    );
    expect(signals).toEqual([]);
  });

  describe('what the signal says', () => {
    it('names the model and the provider rejection, and claims only what it counted', () => {
      const health = new RaterHealth();
      const signal = run(health, ...Array<RaterCallReport>(N).fill(rejected))[0];

      expect(signal).toContain('openrouter/qwen-flash');
      expect(signal).toContain('HTTP 400');
      expect(signal).toContain('tool_choice is not supported by this model');
      // The one statement the old output could not support.
      expect(signal).toContain('The model was never asked');
      // Actionable: the fix is a different rater, not a different command.
      expect(signal).toContain('approvals.rater');
      // The counter knows the last N calls failed. It does not know every call this session did,
      // and the wording must not claim it.
      expect(signal).toContain(`the last ${N} rating calls`);
      expect(signal).not.toContain('every call this session');
    });

    it('describes a timeout run and an unconfigured rater in their own words', () => {
      const timedOut = run(
        new RaterHealth(),
        ...Array<RaterCallReport>(N).fill({ failClosed: 'timeout', model: 'ollama/gemma4' })
      )[0];
      expect(timedOut).toContain('did not answer within its timeout');
      expect(timedOut).not.toContain('HTTP');

      const unconfigured = run(
        new RaterHealth(),
        ...Array<RaterCallReport>(N).fill({ failClosed: 'no-model' })
      )[0];
      expect(unconfigured).toContain('no usable rater model is configured');
    });

    it('carries a WITHHELD provider message as withheld, never as itself', () => {
      const health = new RaterHealth();
      const withheld: RaterCallReport = {
        failClosed: 'threw',
        failure: { status: 400, withheld: true },
        model: 'openrouter/qwen-flash',
      };
      const signal = run(health, ...Array<RaterCallReport>(N).fill(withheld))[0];
      expect(signal, 'the signal still exists and still says what it knows').toContain('HTTP 400');
      expect(signal).toContain('withheld');
    });

    /**
     * The tracker is given no command and no prompt, so it has nothing to leak — which is the point
     * of the signature rather than an accident of it. Asserted anyway: a later parameter added for
     * convenience is exactly how this stops being true.
     */
    it('has no channel through which a rated command could reach it', () => {
      const health = new RaterHealth();
      const signal = run(health, ...Array<RaterCallReport>(N).fill(rejected))[0];
      expect(Object.keys(rejected).sort()).toEqual(['failClosed', 'failure', 'model']);
      expect(signal).not.toContain('rm -rf');
      expect(signal).not.toContain('<command_to_evaluate>');
    });
  });
});
