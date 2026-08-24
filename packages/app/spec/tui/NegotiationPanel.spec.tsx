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

const round = (over: Partial<LiveNegotiationRound['round']> = {}, position = 0) =>
  ({
    round: {
      command: over.command ?? 'git reset --hard origin/main',
      justification: over.justification ?? 'the user asked to wipe today’s commits',
      outcome: over.outcome ?? ('destructive' as const),
      reason: over.reason ?? 'discards every unpushed commit, not only today’s',
    },
    position,
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
   */
  it('draws the round in which the rater agreed, as the last of the exchange', () => {
    const { lastFrame, unmount } = render(
      <NegotiationPanel
        rounds={[
          round({}, 0),
          round(
            { command: 'git reset --soft HEAD~2', outcome: 'safe', reason: 'keeps the tree' },
            1
          ),
        ]}
      />
    );
    const flat = stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain('Round 2: git reset --soft HEAD~2');
    expect(flat).toContain('rater answered: safe — keeps the tree');
    unmount();
  });
});
