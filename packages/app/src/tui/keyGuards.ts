/**
 * TUI-C51 — the two questions every keyboard handler on this surface asks about a raw key event.
 *
 * Both are pure, and both live here rather than being spelled out at each call site, because the
 * answers have to AGREE. Ink broadcasts one keypress to every `useInput` subscriber and offers no
 * way to stop propagation, so a chord that one handler claims is still delivered to every text
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
 */

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
export function isChord(key: ChordModifiers): boolean {
  return Boolean(key.ctrl || key.meta || key.super || key.hyper);
}

/**
 * Whether this event is the user typing a character — the one predicate every text buffer in the
 * TUI takes its input from (the prompt's editor, the debug pane's search, `<SelectList>`'s filter,
 * and the attack banner's phrase).
 *
 * Three refusals, each for its own reason:
 *
 * - **Empty `input`.** Ink reports the navigation keys by name and blanks their `input`.
 * - **A chord.** It belongs to whoever bound it, and an insert branch that is the fall-through for
 *   unrecognised chords types `t` when the user presses `Ctrl+T`.
 * - **A control character**, whatever the modifiers say. See the note above: this is the half a
 *   four-modifier guard cannot see.
 *
 * `\p{Cc}` is the whole C0 and C1 range, so `\x7f` and the `0x80`-`0x9f` block are covered too —
 * the same class the attack banner already refuses. **A caller that wants a literal newline has to
 * ask for it separately**, because `\n` is a control character: `<PromptEditor>` binds `Ctrl+J` on
 * its own branch for exactly that reason.
 */
export function isTypedText(input: string, key: ChordModifiers): boolean {
  if (input.length === 0) return false;
  if (isChord(key)) return false;
  return !/\p{Cc}/u.test(input);
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
