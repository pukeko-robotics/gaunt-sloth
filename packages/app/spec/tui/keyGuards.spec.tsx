import { describe, expect, it } from 'vitest';
import React from 'react';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { isChord, isTypedText, opensCommandMenu } from '#src/tui/keyGuards.js';

/**
 * TUI-C51 — the two shared key predicates, and the decode they have to survive.
 *
 * The cases below are in two halves and the split is the point. The predicates are pure functions
 * of `(input, key)`, so most of them can be stated directly — but a predicate that is right about a
 * key object nothing produces is worth nothing, and every trap this node exists to close is a trap
 * in the DECODE: `Ctrl+/` is a control byte that arrives with `ctrl: false`, and `Ctrl+J` is a
 * control byte that must nonetheless still reach the buffer. So the second half writes the RAW
 * BYTES a terminal sends into a real `useInput` subscriber and asserts what the predicates say
 * about what Ink hands it — the production decode, on every platform of the unit matrix.
 */

/** One decoded keypress, as `useInput` delivers it. */
interface Delivered {
  input: string;
  ctrl: boolean;
  meta: boolean;
  super: boolean;
  hyper: boolean;
}

/**
 * Write `bytes` to a mounted `useInput` subscriber and hand back what Ink delivered.
 *
 * Exactly one event is expected, and a case that produced none — or several — fails naming the
 * count rather than reading a stale entry, because a byte Ink chose to split or swallow would
 * otherwise make the assertions below describe some other keystroke.
 */
async function deliver(bytes: string): Promise<Delivered> {
  const events: Delivered[] = [];
  function Probe(): React.ReactElement {
    useInput((input, key) => {
      events.push({
        input,
        ctrl: key.ctrl,
        meta: key.meta,
        super: key.super,
        hyper: key.hyper,
      });
    });
    return <Text>probe</Text>;
  }
  const { stdin, unmount } = render(<Probe />);
  stdin.write(bytes);
  await new Promise((resolve) => setTimeout(resolve, 20));
  unmount();
  if (events.length !== 1) {
    throw new Error(`expected ${JSON.stringify(bytes)} to deliver 1 event, got ${events.length}`);
  }
  return events[0];
}

describe('isChord / isTypedText (TUI-C51)', () => {
  it('calls every modifier but shift a chord', () => {
    expect(isChord({ ctrl: true })).toBe(true);
    expect(isChord({ meta: true })).toBe(true);
    expect(isChord({ super: true })).toBe(true);
    expect(isChord({ hyper: true })).toBe(true);
    // shift is how a capital is typed, not a different key — and no flag at all is not a chord.
    expect(isChord({})).toBe(false);
  });

  it('accepts an ordinary character and refuses the chord carrying the same letter', () => {
    expect(isTypedText('t', {})).toBe(true);
    expect(isTypedText('T', { ctrl: false })).toBe(true);
    expect(isTypedText('t', { ctrl: true })).toBe(false);
    expect(isTypedText('t', { meta: true })).toBe(false);
    expect(isTypedText('t', { super: true })).toBe(false);
    expect(isTypedText('t', { hyper: true })).toBe(false);
  });

  it('refuses an empty input — the navigation keys arrive that way', () => {
    expect(isTypedText('', {})).toBe(false);
  });

  it('refuses a control byte that reports NO modifier at all', () => {
    // The whole reason the predicate is not a four-modifier test: these are what `Ctrl+/`, `Ctrl+\`
    // and the escape-hold-back residual of `Ctrl+C` look like by the time a handler sees them.
    expect(isTypedText('\x1f', {})).toBe(false);
    expect(isTypedText('\x1c', {})).toBe(false);
    expect(isTypedText('\x03', {})).toBe(false);
    // The C1 block and DEL are refused on the same rule.
    expect(isTypedText('\x7f', {})).toBe(false);
    expect(isTypedText('\x9b', {})).toBe(false);
  });

  it('refuses a control byte hiding inside otherwise-ordinary text', () => {
    expect(isTypedText('a\x1fb', {})).toBe(false);
  });

  it('accepts text above ASCII, including a whole astral code point', () => {
    expect(isTypedText('é', {})).toBe(true);
    expect(isTypedText('÷', {})).toBe(true);
    expect(isTypedText('😀', {})).toBe(true);
  });
});

describe('opensCommandMenu (TUI-C51)', () => {
  it('opens on Ctrl+G and on the byte Ctrl+/ sends, and on nothing else nearby', () => {
    expect(opensCommandMenu('g', { ctrl: true })).toBe(true);
    expect(opensCommandMenu('\x1f', {})).toBe(true);

    // A plain `g` is a letter the user is typing.
    expect(opensCommandMenu('g', {})).toBe(false);
    // `Ctrl+\` (0x1c) is the near neighbour deliberately left unbound.
    expect(opensCommandMenu('\x1c', {})).toBe(false);
    // `Alt+/` on macOS is the printable `÷` — ordinary Option composition, not a chord.
    expect(opensCommandMenu('÷', {})).toBe(false);
    // Another chord on the same letter is not this chord.
    expect(opensCommandMenu('g', { meta: true })).toBe(false);
    expect(opensCommandMenu('g', { ctrl: true, super: true })).toBe(false);
    expect(opensCommandMenu('g', { ctrl: true, hyper: true })).toBe(false);
  });
});

describe('the predicates over Ink’s own decode of the raw bytes (TUI-C51)', () => {
  it('Ctrl+G decodes to a ctrl-modified letter, which opens the menu and is never typed', async () => {
    const event = await deliver('\x07');
    expect(event).toEqual({ input: 'g', ctrl: true, meta: false, super: false, hyper: false });
    expect(opensCommandMenu(event.input, event)).toBe(true);
    expect(isTypedText(event.input, event)).toBe(false);
  });

  it('Ctrl+/ decodes to a bare 0x1f with NO modifier — the case a modifier guard cannot see', async () => {
    const event = await deliver('\x1f');
    // `ctrl: false` is the assertion, not an incidental: Ink's ctrl+letter branch is bounded at
    // \x1a, so every control byte above it arrives looking like ordinary text.
    expect(event).toEqual({ input: '\x1f', ctrl: false, meta: false, super: false, hyper: false });
    expect(opensCommandMenu(event.input, event)).toBe(true);
    expect(isTypedText(event.input, event)).toBe(false);
  });

  it('Ctrl+\\ decodes the same way, is refused as text, and is bound to nothing', async () => {
    const event = await deliver('\x1c');
    expect(event.input).toBe('\x1c');
    expect(event.ctrl).toBe(false);
    expect(opensCommandMenu(event.input, event)).toBe(false);
    expect(isTypedText(event.input, event)).toBe(false);
  });

  it('Ctrl+J decodes to a bare newline the shared predicate refuses — so it needs its own branch', async () => {
    // Stated here rather than only in `<PromptEditor>`, because this is the fact that makes the
    // editor's explicit `\n` branch load-bearing: tidy that branch away and the documented newline
    // key silently stops working.
    const event = await deliver('\n');
    expect(event.input).toBe('\n');
    expect(event.ctrl).toBe(false);
    expect(isTypedText(event.input, event)).toBe(false);
  });

  it('an ordinary letter decodes to itself and is text', async () => {
    const event = await deliver('d');
    expect(event).toEqual({ input: 'd', ctrl: false, meta: false, super: false, hyper: false });
    expect(isTypedText(event.input, event)).toBe(true);
    expect(opensCommandMenu(event.input, event)).toBe(false);
  });
});
