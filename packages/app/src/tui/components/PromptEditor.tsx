import React from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import {
  deleteBackward,
  insertText,
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
} from '#src/tui/lineEditor.js';

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
 * **Control chords are refused, never typed.** The insert branch takes an event only when none of
 * `ctrl`/`meta`/`super`/`hyper` is set, so a chord bound elsewhere in the app — or bound nowhere at
 * all — cannot drop its letter into what the user is writing. That is a property of owning the
 * editor, and it is what makes a separate guard component in front of the prompt unnecessary.
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

export function PromptEditor({
  state,
  onChange,
  onEnter,
  menuActive,
}: {
  /** The buffer and caret to RENDER. Owned by the parent — this component never stores them. */
  state: EditorState;
  /**
   * Applies one edit or motion. Takes an updater rather than a finished state, and that is
   * load-bearing rather than a style choice — see the note on batching in the doc comment above.
   */
  onChange: (update: (previous: EditorState) => EditorState) => void;
  /**
   * Enter was pressed with the menu closed. Reported, not interpreted: what Enter means depends on
   * the buffer, so the parent decides it inside the buffer's own updater, for the same reason
   * {@link onChange} is an updater.
   */
  onEnter: () => void;
  /** While true the editor ignores Up/Down and Enter — the slash menu owns them. */
  menuActive: boolean;
}): React.ReactElement {
  useInput((input, key) => {
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

    if (key.backspace || key.delete) {
      onChange(deleteBackward);
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

    // Everything else that carries text. The guard is the point: a chord belongs to whoever bound
    // it, and an editor whose insert branch is the fall-through for unrecognised chords types `t`
    // when the user presses Ctrl+T. Ours refuses every modifier that makes a key a chord, silently.
    // `shift` is the one deliberately absent: it is how a capital is typed, not a different key.
    if (input.length > 0 && !key.ctrl && !key.meta && !key.super && !key.hyper) {
      onChange((previous) => insertText(previous, input));
    }
  });

  const { lines, line: caretLine, column } = layout(state);

  return (
    <Box flexDirection="column">
      {lines.map((text, index) => (
        // The row index is the only identity a line has here: two rows of a buffer can hold the
        // same text, and the caret's row is decided by position rather than by content.
        <Box key={index}>
          {index === 0 ? (
            <Text color="cyan">{PROMPT_PREFIX}</Text>
          ) : (
            <Text dimColor>{CONTINUATION_PREFIX}</Text>
          )}
          <Text>{index === caretLine ? withCaret(text, column) : text}</Text>
        </Box>
      ))}
    </Box>
  );
}
