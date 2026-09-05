import React from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import {
  deleteBackward,
  deleteForward,
  insertText,
  killToLineEnd,
  killToLineStart,
  killWordLeft,
  killWordRight,
  layout,
  moveLeft,
  moveLineDown,
  moveLineEnd,
  moveLineStart,
  moveLineUp,
  moveRight,
  moveWordLeft,
  moveWordRight,
  type EditorState,
  type KillResult,
} from '#src/tui/lineEditor.js';
import { typedMultilineText } from '#src/tui/keyGuards.js';
import { displayWidth } from '@gaunt-sloth/core/utils/displayWidth.js';

/**
 * TUI-C25 — the prompt's editor: the keyboard on one side, {@link EditorState} on the other.
 *
 * Everything that *decides* lives in `#src/tui/lineEditor.js`; this file only translates keys into
 * calls on it and paints the result. It is a controlled component — the buffer belongs to
 * `<PromptInput>` — so a caret this moves is a caret the parent can also set (after a submit, a
 * paste or a Tab completion) without a second source of truth.
 *
 * **No platform branch, anywhere.** All three word-motion spellings are bound unconditionally:
 * `Meta+B`/`Meta+F` is what macOS Terminal.app and Ghostty send for `Option+←/→` and what a readline
 * user types directly, `Ctrl+←/→` is the xterm/Konsole spelling, and `Meta+←/→` is a third spelling
 * Konsole sends for `Alt+←/→`. They are alternatives, not fallbacks. A platform check here would
 * buy nothing but a way to be wrong on a terminal nobody measured.
 *
 * **Control chords are refused, never typed.** The insert branch takes an event only when
 * `typedMultilineText` finds text in it — no `ctrl`/`meta`/`super`/`hyper`, and not a control byte
 * whatever the modifiers claim — and inserts exactly that rather than the raw event,
 * so a chord bound elsewhere in the app, or bound nowhere at all, cannot drop its letter (or its
 * byte) into what the user is writing, and a paste arriving as keystrokes keeps its text and its
 * line breaks while losing its control bytes. That is a property of owning the editor, and it is
 * what makes a separate guard component in front of the prompt unnecessary. Both answers are
 * shared with every other text buffer in the TUI, because Ink delivers a chord to all of them at
 * once; `keyGuards.ts` says why that matters.
 *
 * **Every edit is an UPDATER, because keystrokes share a stdin chunk.** Ink splits one chunk into
 * several key events and dispatches them synchronously, so every handler after the first in a chunk
 * still closes over the `state` prop from before its predecessor's edit. A handler computing from
 * that prop therefore throws its predecessor's work away — and this is not a rare shape: Ink
 * deliberately splits repeated backspace bytes into separate events *because holding the key sends
 * them in one chunk*, so a buffer that computed from the prop would answer a held Backspace with a
 * single deletion. Handing the parent an updater makes each keystroke compose on the result of the
 * one before it, whatever the batching did.
 *
 * The same rule is why `Enter` is *reported* rather than interpreted here (`onEnter`): whether it
 * continues the line or submits is a question about the buffer, and a held Backspace released into
 * Enter is exactly the shape that asks it about text the user has already corrected. So nothing in
 * this component reads {@link state} except the renderer.
 *
 * **Two deliberate v1 narrowings.**
 *
 * - Up/Down move over LOGICAL lines (the `\n`-separated ones), not visual wrapped rows. A long line
 *   that the terminal wraps is one line, so Up/Down on it do nothing. Visual-line motion would have
 *   to thread the terminal width into the model, coupling a pure module to terminal geometry, and
 *   word motion plus `Ctrl+A`/`Ctrl+E` already give a wrapped line the navigation it needs.
 * - `Ctrl+A`/`Ctrl+E` and `Home`/`End` go to the ends of the caret's OWN logical line, not of the
 *   whole buffer. There is no buffer-start/buffer-end binding.
 *
 * **Every deletion has a matching motion, and takes exactly that motion's span** (TUI-C79). Word
 * deletion deletes what word motion traverses, and `Ctrl+U`/`Ctrl+K` delete what `Ctrl+A`/`Ctrl+E`
 * move over — the caret's own logical line, not the whole buffer and not a visual row. Two shells
 * already disagree about both of those (bash rubs out to whitespace on `Ctrl+W` and to line start on
 * `Ctrl+U`; zsh takes a word and the whole line), so "what users expect" cannot decide it and
 * internal consistency with the motions does.
 *
 * **The four word/line deletions are KILLS: they hand the removed text up through {@link onKill},**
 * and `<PromptInput>` keeps the most recent one in a single slot that `Ctrl+Y` puts back. Plain
 * `Backspace`/`Delete`/`Ctrl+D` are deliberately NOT kills — a slot every keystroke overwrites is one
 * nobody can predict the contents of. The kill travels with the state change rather than being read
 * off {@link state} for the same batching reason every edit is an updater.
 */

/** The `  > ` the first row of the buffer is written after. */
const PROMPT_PREFIX = '  > ';
/**
 * Every continuation row's prefix. Deliberately the same four columns wide as `  > `, so the text
 * of every row of a multi-line buffer starts in the same column.
 */
const CONTINUATION_PREFIX = '  … ';

/**
 * A row with the caret drawn into it as an inverse-video cell — the way `ink-text-input` drew it,
 * because a terminal cursor Ink does not move is not an option and this is what users already read
 * as "the caret is here".
 *
 * Takes the WHOLE code point under the caret: inverting one code unit of a surrogate pair renders
 * the emoji as two pieces of garbage. At end-of-line there is nothing to invert, so an inverse space
 * stands in — which is also what an empty buffer renders as.
 */
function withCaret(line: string, column: number): string {
  const codePoint = line.codePointAt(column);
  if (codePoint === undefined) return line + chalk.inverse(' ');
  const character = String.fromCodePoint(codePoint);
  return line.slice(0, column) + chalk.inverse(character) + line.slice(column + character.length);
}

/**
 * TUI-C92 — the terminal rows the editor draws `state` on at `columns`: one row per logical line,
 * plus the rows a line takes when it wraps at the width left after its four-column prefix. The
 * caret's line is one cell wider when the caret sits at its end, because `withCaret` draws it there
 * as an inverse space rather than over a character.
 *
 * Kept beside the render whose rows it counts, so the two cannot drift. It is a lower bound: Ink
 * wraps at word boundaries, so a line can take one row more than its width alone says.
 */
export function editorRows(state: EditorState, columns: number): number {
  const { lines, line: caretLine, column } = layout(state);
  const width = Math.max(1, columns - PROMPT_PREFIX.length);
  return lines.reduce((rows, text, index) => {
    const caretCell = index === caretLine && text.codePointAt(column) === undefined ? 1 : 0;
    return rows + Math.max(1, Math.ceil((displayWidth(text) + caretCell) / width));
  }, 0);
}

export function PromptEditor({
  state,
  onChange,
  onKill,
  onYank,
  onEnter,
  menuActive,
  suspended = false,
}: {
  /** The buffer and caret to RENDER. Owned by the parent — this component never stores them. */
  state: EditorState;
  /**
   * Applies one edit or motion. Takes an updater rather than a finished state, and that is
   * load-bearing rather than a style choice — see the note on batching in the doc comment above.
   */
  onChange: (update: (previous: EditorState) => EditorState) => void;
  /**
   * Applies one KILL — a word deletion or a line-edge kill. Separate from {@link onChange} because
   * the removed text has to be computed against the same authoritative buffer the state change is
   * computed against; taken from the rendered {@link state} instead, a kill sharing a stdin chunk
   * with an earlier edit would store text the user had already changed.
   */
  onKill: (kill: (previous: EditorState) => KillResult) => void;
  /** `Ctrl+Y` — put the most recent kill back at the caret. The parent owns the slot and its text. */
  onYank: () => void;
  /**
   * Enter was pressed with the menu closed. Reported, not interpreted: what Enter means depends on
   * the buffer, so the parent decides it inside the buffer's own updater, for the same reason
   * {@link onChange} is an updater.
   */
  onEnter: () => void;
  /** While true the editor ignores Up/Down and Enter — the slash menu owns them. */
  menuActive: boolean;
  /**
   * TUI-C51 — while true the editor handles NO key at all: the draft-preserving command menu is
   * open and owns the whole keyboard, so what the user types filters that menu instead of joining
   * the message. Distinct from {@link menuActive}, which stands down from three keys and leaves the
   * rest of the editor live, because this mode's whole purpose is that the draft is not edited.
   *
   * The draft keeps rendering — caret included. It is the thing the user is looking at.
   */
  suspended?: boolean;
}): React.ReactElement {
  useInput((input, key) => {
    // The menu owns every key while it is open; nothing below may edit the draft under it.
    if (suspended) return;

    // Word motion — three spellings, none of them a fallback for another (see the doc comment).
    if ((key.meta && input === 'b') || ((key.ctrl || key.meta) && key.leftArrow)) {
      onChange(moveWordLeft);
      return;
    }
    if ((key.meta && input === 'f') || ((key.ctrl || key.meta) && key.rightArrow)) {
      onChange(moveWordRight);
      return;
    }

    // Line start / end. `Home`/`End` are claimed only WITHOUT Ctrl: <App> binds Ctrl+Home/Ctrl+End
    // to scrolling the transcript, and leaving those two alone is what keeps both bindings working.
    if ((key.ctrl && input === 'a') || (key.home && !key.ctrl)) {
      onChange(moveLineStart);
      return;
    }
    if ((key.ctrl && input === 'e') || (key.end && !key.ctrl)) {
      onChange(moveLineEnd);
      return;
    }

    // One character at a time. Reached only after the word-motion branches above, so an arrow that
    // arrives carrying Ctrl or Meta has already been handled as a word motion.
    //
    // `Shift` is deliberately NOT tested on any motion branch: a terminal that reports Shift with an
    // arrow (`\x1b[1;2D`) performs the plain motion. Selection is not a concept this editor has, so
    // there is nothing else the shifted key could mean, and refusing it would make a key a user
    // pressed do nothing at all.
    if (key.leftArrow) {
      onChange(moveLeft);
      return;
    }
    if (key.rightArrow) {
      onChange(moveRight);
      return;
    }

    // Up/Down have exactly TWO claimants at the prompt, and this is where they are arbitrated:
    //
    //   1. The slash menu is open  → the menu owns them (it moves its highlight). `menuActive` says
    //      so, and this branch stands down completely.
    //   2. Otherwise                → the buffer owns them, moving the caret between the logical
    //      lines of a multi-line entry. On a single-line buffer that is a no-op by construction.
    //
    // There is NO third claimant: input-history recall is not implemented at this prompt and is not
    // built here, so nothing is waiting behind the buffer for the no-op case to fall through to.
    // (The debug panel also binds Up/Down, but the prompt is unmounted while that panel is focused.)
    if (key.upArrow || key.downArrow) {
      if (menuActive || key.ctrl || key.meta) return;
      onChange(key.upArrow ? moveLineUp : moveLineDown);
      return;
    }

    // Killing a word, in either direction. Above the one-character deletions because these arrive
    // as the SAME keys carrying a modifier, and the plain branches below test the key alone.
    //
    // The asymmetry in the spellings is the terminals', not a choice: `Ctrl+Backspace` cannot be
    // bound at all, because Ink's `\x08` branch sits above its ctrl+letter branch and `useInput`
    // blanks `input` for a backspace, so the chord arrives indistinguishable from a plain one.
    // `Ctrl+W` is therefore the only backward word-delete a keyboard without Option-as-Meta can
    // reach. Forward has both spellings, and `{delete, meta}` covers `\x1b[3;3~` and `\x1b\x1b[3~`
    // alike — Ink sets `meta` from the modifier bitmask and, separately, from a doubled leading
    // escape, so the two encodings converge before they get here.
    if ((key.backspace && key.meta) || (key.ctrl && input === 'w')) {
      onKill(killWordLeft);
      return;
    }
    if (key.delete && (key.ctrl || key.meta)) {
      onKill(killWordRight);
      return;
    }

    // One code point, in the direction the key names. `Delete` deleting FORWARD reverses an
    // adjudication made in TUI-C25, where it was left as a second Backspace to preserve observable
    // behaviour; TUI-C79 decided the other way, so a reader finding the change does not read it as
    // an accident. `Ctrl+D` is a second spelling of the same forward delete, and it NEVER exits:
    // readline's EOF convention is declined here on purpose, because `Ctrl+C` already carries a
    // buffer-dependent exit rule and a second exit key with a different one is the trap to avoid.
    // On an empty buffer it does nothing at all.
    if (key.backspace) {
      onChange(deleteBackward);
      return;
    }
    if (key.delete || (key.ctrl && input === 'd')) {
      onChange(deleteForward);
      return;
    }

    // Killing to the edges of the caret's own logical line — the partners of `Ctrl+A`/`Ctrl+E`
    // above, scoped exactly as they are. `Ctrl+U` goes to the line START, not the whole line;
    // killing a whole line is `Ctrl+E` then `Ctrl+U`.
    if (key.ctrl && input === 'k') {
      onKill(killToLineEnd);
      return;
    }
    if (key.ctrl && input === 'u') {
      onKill(killToLineStart);
      return;
    }
    // The other half of the four kills above: without a way back, `Ctrl+U` on a composed message is
    // an unrecoverable keystroke, because this prompt has no undo of any kind.
    if (key.ctrl && input === 'y') {
      onYank();
      return;
    }

    if (key.return) {
      // With the menu open Enter belongs to it — the parent dispatches the highlighted command.
      if (menuActive) return;
      // Reported rather than decided, and for the same reason every other branch hands up an
      // updater: what Enter means is a question about the buffer, and answering it from the
      // rendered `state` answers it about the text as it stood before whatever shared this chunk.
      onEnter();
      return;
    }

    // **`Ctrl+J` is the newline key** (TUI-C79), and it needs a branch of its own. The byte is
    // `\n`, which Ink parses as `{name: 'enter'}`: `key.return` is set only for `'return'`, and
    // `'enter'` is not one of the `nonAlphanumericKeys` whose `input` gets blanked, so the event
    // arrives as `input === '\n'` with no modifier set, i.e. as a fall-through into the insert
    // branch below — which is a filter, and every filter this module has ever asked has at some
    // point answered that a lone `\n` is not text. Bound explicitly here, the key does not depend
    // on which filter that branch happens to consult; `spec/tui/PromptInput.spec.tsx` pins it.
    // (The branch below would keep it today: it asks `typedMultilineText`, and `\n` survives that
    // one. It does not survive `typedText`, which is what every single-line buffer asks.)
    // `Alt+Enter` is NOT bound: `\x1b\r` decodes as
    // `{return, meta}` and the Enter branch above tests no modifiers, so it already submits.
    if (input === '\n' && !key.ctrl && !key.meta && !key.super && !key.hyper) {
      onChange((previous) => insertText(previous, '\n'));
      return;
    }

    // Everything else that carries text. The guard is the point: a chord belongs to whoever bound
    // it, and an editor whose insert branch is the fall-through for unrecognised chords types `t`
    // when the user presses Ctrl+T — or splices `Ctrl+/`'s `0x1f` in as if it were a character,
    // which no modifier flag reports (see `keyGuards.ts`). `shift` is the one modifier deliberately
    // not refused: it is how a capital is typed, not a different key.
    //
    // What is inserted is the event's TEXT, not the event: one `input` is a whole paste whenever
    // the terminal is not in bracketed-paste mode, so the control characters are dropped out of it
    // rather than the message being dropped over them. Line breaks are kept — this buffer has
    // rows — and normalized the same way the bracketed-paste channel normalizes them.
    //
    // The guard asks the INSERTER's own question (`typedMultilineText(…) !== ''`) rather than
    // `isTypedText`, which is built on the single-line `typedText` and so answers about a filter
    // this branch does not use: a chunk of nothing but line breaks — a blank line pasted, the tail
    // of a copied block — carries text to this buffer and none to that one. Asking one filter and
    // inserting another is how the two answers drift apart.
    //
    // **No event this branch claims can also submit, but a PASTE still can.** A chunk of more than
    // one character gets no key name from Ink's parser, so `key.return` is never set for
    // `"run anyway\r"` or `"hello\n"` and the Enter branch above cannot fire on it. A paste is not
    // guaranteed to arrive as one chunk, though: split by the OS (or by a terminal flushing per
    // line) at a point that leaves a lone `\r`, that byte decodes as `{name: 'return'}` and submits
    // whatever has landed so far. That is inherent to this channel and is exactly what
    // bracketed-paste mode exists to prevent; nothing here can close it.
    if (typedMultilineText(input, key) !== '') {
      onChange((previous) => insertText(previous, typedMultilineText(input, key)));
    }
  });

  const { lines, line: caretLine, column } = layout(state);

  return (
    <Box flexDirection="column">
      {lines.map((text, index) => (
        // The row index is the only identity a line has here: two rows of a buffer can hold the
        // same text, and the caret's row is decided by position rather than by content.
        <Box key={index}>
          {/* The prefix is pinned at its natural width. Ink gives every child of a row `Box` a
              default `flexShrink: 1`, so on a line long enough for the terminal to wrap, Yoga
              shrinks the PREFIX as well as the text — dropping the trailing space, starting row 0's
              text one column left of its own wrapped continuation, and handing the text more
              columns than the row has, which the terminal then hard-wraps mid-word. Four columns is
              the alignment this component promises; it is not a budget to borrow from. */}
          <Box flexShrink={0}>
            {index === 0 ? (
              <Text color="cyan">{PROMPT_PREFIX}</Text>
            ) : (
              <Text dimColor>{CONTINUATION_PREFIX}</Text>
            )}
          </Box>
          <Text>{index === caretLine ? withCaret(text, column) : text}</Text>
        </Box>
      ))}
    </Box>
  );
}
