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
  pressEnter,
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
 * **Control chords are refused, never typed.** The insert branch takes an event only when neither
 * `key.ctrl` nor `key.meta` is set, so a chord bound elsewhere in the app — or bound nowhere at all
 * — cannot drop its letter into what the user is writing. That is a property of owning the editor,
 * and it is what makes a separate guard component in front of the prompt unnecessary.
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
  onSubmit,
  menuActive,
}: {
  /** The buffer and caret to render. Owned by the parent — this component never stores them. */
  state: EditorState;
  onChange: (next: EditorState) => void;
  /** Called when Enter means submit; a continuation is handled here, via `pressEnter`. */
  onSubmit: (value: string) => void;
  /** While true the editor ignores Up/Down and Enter — the slash menu owns them. */
  menuActive: boolean;
}): React.ReactElement {
  useInput((input, key) => {
    // Word motion — three spellings, none of them a fallback for another (see the doc comment).
    if ((key.meta && input === 'b') || ((key.ctrl || key.meta) && key.leftArrow)) {
      onChange(moveWordLeft(state));
      return;
    }
    if ((key.meta && input === 'f') || ((key.ctrl || key.meta) && key.rightArrow)) {
      onChange(moveWordRight(state));
      return;
    }

    // Line start / end. `Home`/`End` are claimed only WITHOUT Ctrl: <App> binds Ctrl+Home/Ctrl+End
    // to scrolling the transcript, and leaving those two alone is what keeps both bindings working.
    if ((key.ctrl && input === 'a') || (key.home && !key.ctrl)) {
      onChange(moveLineStart(state));
      return;
    }
    if ((key.ctrl && input === 'e') || (key.end && !key.ctrl)) {
      onChange(moveLineEnd(state));
      return;
    }

    // One character at a time. Reached only after the word-motion branches above, so an arrow that
    // arrives carrying Ctrl or Meta has already been handled as a word motion.
    if (key.leftArrow) {
      onChange(moveLeft(state));
      return;
    }
    if (key.rightArrow) {
      onChange(moveRight(state));
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
      onChange(key.upArrow ? moveLineUp(state) : moveLineDown(state));
      return;
    }

    if (key.backspace || key.delete) {
      onChange(deleteBackward(state));
      return;
    }

    if (key.return) {
      // With the menu open Enter belongs to it — the parent dispatches the highlighted command.
      if (menuActive) return;
      const result = pressEnter(state);
      if (result.kind === 'continue') onChange(result.state);
      else onSubmit(result.value);
      return;
    }

    // Everything else that carries text. The guard is the point: a chord belongs to whoever bound
    // it, and an editor whose insert branch is the fall-through for unrecognised chords types `t`
    // when the user presses Ctrl+T. Ours refuses every ctrl and meta chord, silently.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      onChange(insertText(state, input));
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
