import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { NegotiationPanel } from '#src/tui/components/NegotiationPanel.js';
import type { LiveNegotiationRound } from '@gaunt-sloth/core/core/shell/negotiation.js';

/**
 * [[TUI-C69]] §5.4 — **the Ink surface draws the negotiation while it happens.**
 *
 * The requirement is not decoration: the spec's own justification for letting the agent argue with
 * the rater at all is that a human can watch it, and *an argument conducted in the dark is a
 * different thing from one that can be interrupted*. Until this panel existed the exchange reached
 * a person only at an escalation — that is, only in the runs where the argument failed.
 *
 * The readline counterpart is `interactiveSessionNegotiationLive.spec.ts`; both surfaces render the
 * same core rows, which is what stops them describing one exchange two ways.
 */

const round = (
  over: Partial<LiveNegotiationRound['round']> = {},
  position = 0,
  agreed = false,
  revised = false
) =>
  ({
    round: {
      command: over.command ?? 'git reset --hard origin/main',
      justification: over.justification ?? 'the user asked to wipe today’s commits',
      outcome: over.outcome ?? ('destructive' as const),
      reason: over.reason ?? 'discards every unpushed commit, not only today’s',
    },
    position,
    ...(agreed ? { agreed } : {}),
    ...(revised ? { revised } : {}),
  }) as LiveNegotiationRound;

/** The raw (ANSI-bearing) row containing `text`, so a colour claim is read off the real frame. */
const rawRowWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => stripAnsi(line).includes(text)) ?? '';

describe('tui <NegotiationPanel>', () => {
  beforeEach(() => {
    chalk.level = 3;
  });

  it('renders nothing at all when no negotiation is running', () => {
    const { lastFrame, unmount } = render(<NegotiationPanel rounds={[]} />);
    expect(stripAnsi(lastFrame() ?? '').trim()).toBe('');
    unmount();
  });

  /**
   * §5.4 — *"the rater's turns are coloured yellow, so the two voices are never confused and the
   * user can see at a glance which party is speaking"*. Read off the raw frame, because the claim
   * is about what the terminal receives.
   */
  it('paints the rater’s turn yellow and leaves the agent’s proposal unpainted', () => {
    const { lastFrame, unmount } = render(<NegotiationPanel rounds={[round()]} />);
    const frame = lastFrame() ?? '';
    expect(rawRowWith(frame, 'rater answered')).toContain('[33m');
    expect(rawRowWith(frame, 'Round 1:')).not.toContain('[33m');
    unmount();
  });

  /**
   * **Colour is the second signal, never the only one.** A monochrome terminal, `NO_COLOR`, a pipe
   * and a reader who cannot distinguish yellow all have to be told the same thing, so every row
   * names its own speaker.
   */
  it('names each speaker on the row, so the distinction survives with no colour', () => {
    const { lastFrame, unmount } = render(<NegotiationPanel rounds={[round({}, 1)]} />);
    const flat = stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain('Round 2: git reset --hard origin/main');
    expect(flat).toContain('agent justified: the user asked');
    expect(flat).toContain('rater answered: destructive — discards every unpushed commit');
    unmount();
  });

  /**
   * The rounds accumulate as the gate decides them, in order, with the context sentence drawn once
   * over the round that opens the exchange — and never the escalation heading, because nothing is
   * being ruled on yet.
   */
  it('draws the rounds in order under one context sentence', () => {
    const { lastFrame, unmount } = render(
      <NegotiationPanel
        rounds={[
          round({ command: 'git reset --hard origin/main' }, 0),
          round({ command: 'git reset --soft HEAD~2', reason: 'keeps the tree' }, 1),
        ]}
      />
    );
    const rows = stripAnsi(lastFrame() ?? '').split('\n');
    const at = (text: string): number => rows.findIndex((row) => row.includes(text));
    expect(rows.filter((r) => r.includes('negotiating with the auto-rater'))).toHaveLength(1);
    expect(at('Round 1:')).toBeLessThan(at('Round 2:'));
    expect(rows.join('\n')).not.toContain('argued with the auto-rater');
    expect(rows.join('\n')).not.toContain('(this request)');
    unmount();
  });

  /**
   * The approving round is a round of the exchange too — it is the one §5.5 holds on screen, and a
   * panel that showed only refusals would end the story at the last rejection.
   *
   * **It is LABELLED, not numbered**, because the transcript the escalation prompt renders holds
   * rejections alone: an approved call never joins it, so a number drawn here is the number the
   * next rejection takes, and the panel and the prompt would then give one number to two different
   * commands. See `negotiationVisible.spec.ts` for that case driven end to end.
   */
  it('draws the round in which the rater agreed, labelled rather than numbered', () => {
    const { lastFrame, unmount } = render(
      <NegotiationPanel
        rounds={[
          round({}, 0),
          // The SAME command the rater refused, re-proposed and now passed — which is what makes
          // `Agreed` a true thing to say about it.
          round(
            {
              command: 'git reset --hard origin/main',
              outcome: 'safe',
              reason: 'keeps the tree',
            },
            1,
            true
          ),
        ]}
      />
    );
    const flat = stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain('Agreed: git reset --hard origin/main');
    expect(flat).toContain('rater answered: safe — keeps the tree');
    // The number this round would have taken belongs to the rejection that may follow it.
    expect(flat).not.toContain('Round 2');
    unmount();
  });

  /**
   * When the command that ended the argument is NOT one the rater refused, the row says the rater
   * accepted it rather than agreed to it. `Agreed` over a command nobody argued about is a false
   * statement about the auto-rater, printed in the chrome of the thing asking the user to trust it.
   */
  it('says the rater ACCEPTED a command it never argued about', () => {
    const { lastFrame, unmount } = render(
      <NegotiationPanel
        rounds={[
          round({}, 0),
          round(
            { command: 'git reset --soft HEAD~2', outcome: 'safe', reason: 'keeps the tree' },
            1,
            true,
            true
          ),
        ]}
      />
    );
    const flat = stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain('Accepted: git reset --soft HEAD~2');
    expect(flat).not.toContain('Agreed:');
    unmount();
  });

  /**
   * **The panel sits in a dock that is explicitly told not to shrink** (`flexShrink={0}` — the
   * conversation gives up rows, not the controls), so an unbounded panel is not untidy, it is rows
   * taken from the transcript and eventually from the input prompt on an 80×24 terminal.
   *
   * It was unbounded: the renderer's own three-round cap was defeated by handing it ONE round at a
   * time, where the slice is an identity operation, and every event was accumulated. Measured at 46
   * rows for a nine-round argument at 80 columns against 16 for the same argument in the escalation
   * prompt. Asserted HERE, on a real Ink frame, as well as at the renderer, because the bound is
   * only worth anything if this component is what passes the whole list in.
   */
  it('stays a screenful for an argument that runs to the reachability bound', () => {
    const rounds = Array.from({ length: 9 }, (_unused, index) =>
      round(
        {
          command: `git reset --hard origin/main --attempt-${index + 1}`,
          justification: `attempt ${index + 1}: the user asked me to wipe today’s commits and I still think this is what they meant`,
          reason: `refused: discards committed work irreversibly (attempt ${index + 1})`,
        },
        index
      )
    );
    const { lastFrame, unmount } = render(<NegotiationPanel rounds={rounds} />);
    const rows = stripAnsi(lastFrame() ?? '')
      .split('\n')
      .filter((row) => row.trim() !== '');
    expect(rows.length).toBeLessThanOrEqual(19);
    // The newest rounds, not the oldest: a panel frozen on the opening of an argument would never
    // show the state the run is actually in.
    expect(rows.join('\n')).toContain('Round 9');
    expect(rows.join('\n')).not.toContain('Round 1:');
    unmount();
  });
});
