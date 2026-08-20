/**
 * TUI-C51 — the questions every keyboard handler on this surface asks about a raw key event.
 *
 * All of them are pure, and they live here rather than being spelled out at each call site, because
 * the answers have to AGREE. Ink broadcasts one keypress to every `useInput` subscriber and offers
 * no way to stop propagation, so a chord that one handler claims is still delivered to every text
 * buffer in the tree — in the same synchronous dispatch, before any state the claim produced has
 * rendered. A buffer that decides "is this text?" differently from its neighbour therefore does not
 * merely differ in style: it types the byte its neighbour refused.
 *
 * **A modifier flag is not enough to recognise a control byte, and that is the whole point.** Ink's
 * ctrl+letter branch is bounded at `\x1a`, so every control byte above it — `Ctrl+/` is `0x1f`,
 * `Ctrl+\` is `0x1c` — decodes with `ctrl: false` and an `input` holding the byte itself. The same
 * shape appears without any chord at all: a `Ctrl+C` released together with a held-back Escape
 * reaches Ink merged as `ESC ^C`, and `use-input` strips the escape prefix to leave `input` as
 * `'\x03'` with no modifier set (`mouseStdin.ts`, `spec/tui/escapeHoldBack.spec.tsx`). A guard that
 * tests only the modifiers passes all of those through as if they were typed, and the symptom is an
 * invisible byte in whatever has focus — which a user reads as a broken prompt.
 *
 * **One event is not one character, so the refusal is per CHARACTER.** Ink splits a stdin chunk on
 * ESC and on the two backspace bytes and on nothing else — deliberately, because `\r` and `\t`
 * legitimately appear inside pasted text — and `useInput`'s own contract is that a paste of more
 * than one character arrives as a single call with the whole string as `input`. A predicate that
 * refused the whole EVENT because one character in it is a control byte would therefore discard an
 * entire paste, silently and with no way to get it back; and a paste is exactly what arrives on
 * this channel whenever bracketed-paste mode is off, which it is in every state where the prompt
 * (the only holder of `usePaste`) is not mounted — the focused debug pane's search, above all.
 * {@link typedText} keeps the characters and drops the control bytes, so what a buffer receives is
 * what a user could have typed into it, and every bare control byte still reaches nothing.
 */

import { normalizePastedText } from '#src/tui/pasteParser.js';

/**
 * Ink's modifier flags, minus `shift`.
 *
 * `shift` is deliberately absent everywhere in this module: it is how a capital is typed, not a
 * different key. `capsLock`/`numLock` sit on the same object and are lock states rather than
 * modifiers, so refusing a key pressed under them would be a new defect rather than a guard.
 * `super`/`hyper` arrive through the kitty keyboard protocol's CSI-u form, which Ink decodes
 * whether or not the protocol was ever enabled.
 */
export interface ChordModifiers {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly hyper?: boolean;
}

/**
 * `Ctrl+/`, on the terminals that emit it at all: the unit separator, `0x1f`.
 *
 * Measured rather than assumed (`_spikes/2026-08-06-ctrl-slash-terminal-emission/`): macOS sends
 * nothing whatever for this chord, in Terminal.app and in Zed, while Konsole sends this byte. That
 * is why it is an ADDITIONAL spelling and never the only way in.
 */
const CTRL_SLASH = '\x1f';

/** Whether a modifier that makes a key a chord is set — anything but `shift`. */
function isChord(key: ChordModifiers): boolean {
  return Boolean(key.ctrl || key.meta || key.super || key.hyper);
}

/**
 * What a text buffer may take from this event — the one answer the TUI's text buffers read their
 * input through (the prompt's editor, the chord menu's query, the debug pane's search and
 * `<SelectList>`'s filter), `''` when there is nothing to take.
 *
 * Two whole-event refusals and one per-character one, each for its own reason:
 *
 * - **A chord** takes nothing. It belongs to whoever bound it, and an insert branch that is the
 *   fall-through for unrecognised chords types `t` when the user presses `Ctrl+T`.
 * - **An empty `input`** has nothing in it anyway. Ink reports the navigation keys by name and
 *   blanks their `input`.
 * - **Every control character is REMOVED**, whatever the modifiers say — see the note above for
 *   why a modifier test cannot find them, and why the removal is per character rather than a
 *   refusal of the event that carries them.
 *
 * `\p{Cc}` is the whole C0 and C1 range, so `\x7f` and the `0x80`-`0x9f` block go too. A bare
 * control byte is therefore an empty result and reaches no buffer at all — which is the entire
 * guard — while a paste that happens to carry one arrives as its text, minus that character.
 *
 * `\n` is a control character and goes with the rest here, because these buffers are single-line: a
 * query or a filter cannot hold a line break, and a paste of several lines is one line of text to
 * them. The one multi-line buffer asks for {@link typedMultilineText} instead.
 *
 * **The attack banner's phrase field is deliberately NOT one of these buffers** (`App.tsx`), and it
 * is the only place that may differ. It refuses a whole event carrying a control character instead
 * of filtering the character out, because the character in question is the `\r` of a pasted
 * `run anyway` line and the filtered result would be the exact phrase, one Enter from an
 * irreversible command. That is the opposite trade to this one and the right one there: losing a
 * paste costs a retype, keeping one costs the command. Anywhere else, a different answer is drift.
 */
export function typedText(input: string, key: ChordModifiers): string {
  if (isChord(key)) return '';
  return input.replace(/\p{Cc}/gu, '');
}

/**
 * {@link typedText} for the one buffer that can hold a line break: `<PromptEditor>`'s message.
 *
 * `\n` survives here and every other control character still goes, because for a multi-line paste
 * arriving on the keystroke channel the break is content: the message is drawn on as many rows as
 * it has lines, so dropping it joins two lines the user can see are separate, and refusing the
 * paste over it loses the whole message. (A `\n` ALONE is still not text — {@link isTypedText}
 * refuses it, and the newline key it belongs to is bound on its own branch in `<PromptEditor>`.)
 *
 * Line endings are normalized exactly as a bracketed paste's are ({@link normalizePastedText}), so
 * the same text pasted into the same buffer lands the same way whether or not the terminal had
 * bracketed-paste mode on.
 */
export function typedMultilineText(input: string, key: ChordModifiers): string {
  if (isChord(key)) return '';
  return normalizePastedText(input).replace(/\p{Cc}/gu, (character) =>
    character === '\n' ? character : ''
  );
}

/**
 * Whether this event carries any text at all — the guard each text buffer claims the key with,
 * before inserting what {@link typedText} (or {@link typedMultilineText}) hands it.
 *
 * `false` is exactly "nothing a buffer could take": a chord, an empty `input`, or an event whose
 * every character is a control character — which a lone control byte, the case this module exists
 * for, always is. It stays a single question, asked the same way everywhere, so that WHICH events a
 * buffer claims cannot drift between buffers even as they differ on what they may hold: `\n` is not
 * text by this answer, which is why the newline key needs its own branch in `<PromptEditor>`.
 */
export function isTypedText(input: string, key: ChordModifiers): boolean {
  return typedText(input, key) !== '';
}

/**
 * TUI-C51 — whether this event is the chord that opens the draft-preserving command menu.
 *
 * **`Ctrl+G` is the binding; `Ctrl+/` is an additional accepted spelling.** `Ctrl+G` emits `0x07`
 * in every terminal measured and parses cleanly as `{name: 'g', ctrl: true}`, so it needs no
 * raw-byte handler and nothing else on this surface claims it. `Ctrl+/` is the more memorable name
 * and works on Linux, but it emits nothing at all on macOS — so it can only ever be a second door,
 * and it arrives as the bare byte with no modifier flag (see {@link CTRL_SLASH}).
 *
 * Two near neighbours are deliberately NOT here. `Alt+/` on macOS emits `0xc3 0xb7`, which is the
 * printable `÷` — ordinary Option composition, indistinguishable from the user typing that
 * character. `Ctrl+\` (`0x1c`) carries `Ctrl+/`'s exact defect and is conventionally `SIGQUIT`.
 */
export function opensCommandMenu(input: string, key: ChordModifiers): boolean {
  if (key.meta || key.super || key.hyper) return false;
  if (key.ctrl) return input === 'g';
  return input === CTRL_SLASH;
}
