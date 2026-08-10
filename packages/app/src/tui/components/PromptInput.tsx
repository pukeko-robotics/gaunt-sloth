import React, { useEffect, useState } from 'react';
import { Box, useInput, usePaste } from 'ink';
import { PromptEditor } from '#src/tui/components/PromptEditor.js';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import {
  filterSlashCommands,
  slashMenuQuery,
  type SlashCommand,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import { createEditorState, insertText } from '#src/tui/lineEditor.js';
import { normalizePastedText } from '#src/tui/pasteParser.js';

/**
 * The user prompt line. Mirrors the readline `  > ` prompt. Clears on submit; the parent
 * hides it while a turn is running so Ink owns stdin uncontended during streaming.
 *
 * The buffer and caret live here as an {@link import('#src/tui/lineEditor.js').EditorState} and are
 * rendered and driven by `<PromptEditor>` (TUI-C25), which owns the keyboard for everything that
 * edits text. This component owns what the buffer *means*: the slash menu it may open, and the
 * submission it becomes.
 *
 * TUI-C10 — while the user is typing a bare slash command (input starts with `/`, no space yet),
 * a discovery menu of the matching registered commands appears just above the prompt. The registry
 * (`commands`) is the single source, so extension-registered commands show automatically. Arrow
 * keys move the highlight, Tab completes the highlighted name, Enter dispatches it, Esc dismisses
 * the menu. The keyboard split is stated in one place and honoured on both sides of it: while the
 * menu is open `<PromptEditor>` stands down from Up/Down and Enter (its `menuActive` prop) and this
 * component's `useInput` claims them, so no key is handled twice. A fully-typed command still
 * dispatches exactly as before (Enter with the menu open submits the highlighted command, which
 * equals what was typed).
 *
 * A buffer with a newline in it never opens the menu, and does not need a guard of its own to stop
 * it: `slashMenuQuery` matches `/` followed by non-whitespace to the end of the input, and `\n` is
 * whitespace — so a continued or pasted multi-line entry beginning with `/` is not a command query.
 *
 * TUI-C24 — multiline paste. `usePaste` puts the terminal into bracketed-paste mode (`\x1b[?2004h`)
 * while the prompt is mounted and disables it on unmount, and Ink delivers the pasted text on a
 * channel separate from `useInput` — so an embedded newline in a pasted burst is never read as
 * Enter and can never submit the turn mid-paste. The normalized paste (CRLF/CR → `\n`) is inserted
 * at the caret without submitting; a subsequent explicit Enter submits the whole multi-line value.
 */
export function PromptInput({
  onSubmit,
  commands = [],
  onMenuStateChange,
}: {
  onSubmit: (value: string) => void;
  /** The slash-command registry (App builds it once) — the menu's single source of truth. */
  commands?: SlashCommand[];
  /** Notifies the parent whether the menu currently owns navigation keys (so App can stand down
   *  its own Tab handler while the menu is open). */
  onMenuStateChange?: (active: boolean) => void;
}): React.ReactElement {
  const [state, setState] = useState(() => createEditorState());
  /**
   * The menu's transient state, KEYED ON THE TEXT it belongs to rather than reset by whoever edits
   * that text.
   *
   * Both fields answer "for this query": `dismissed` is Esc's, so the menu can be sent away without
   * clearing the input, and `index` is the highlighted row, which starts at the most-relevant match
   * whenever the query changes under it. Deriving both from `forValue` is what makes an edit
   * invalidate them BY DEFINITION and a bare caret move leave them alone — where a handler that
   * reset them itself would be resetting from a snapshot that a shared stdin chunk has already made
   * stale, and would have to be got right at every call site (an edit, a paste, a completion, a
   * submit) instead of in one place.
   */
  const [menu, setMenu] = useState<{ forValue: string; dismissed: boolean; index: number }>({
    forValue: '',
    dismissed: false,
    index: 0,
  });
  const menuAppliesToBuffer = menu.forValue === state.value;

  const query = slashMenuQuery(state.value);
  const dismissed = menuAppliesToBuffer && menu.dismissed;
  const matches = query !== null && !dismissed ? filterSlashCommands(commands, query) : [];
  const menuActive = matches.length > 0;
  // Clamp defensively in case the filtered list shrank below the highlight between renders.
  const selectedIndex = menuActive
    ? Math.min(menuAppliesToBuffer ? menu.index : 0, matches.length - 1)
    : 0;

  // Let the parent suppress its competing Tab handler (debug-panel focus) while the menu is open.
  useEffect(() => {
    onMenuStateChange?.(menuActive);
  }, [menuActive, onMenuStateChange]);

  /** Submit `value` and clear the buffer; clearing it resets the menu by itself (see `menu`). */
  const submit = (value: string): void => {
    setState(createEditorState());
    onSubmit(value);
  };

  /** Step the highlight by `step`, wrapping — the menu is open, so there is a list to step. */
  const moveHighlight = (step: number): void => {
    setMenu((previous) => {
      const current = previous.forValue === state.value ? previous.index : 0;
      const clamped = Math.min(current, matches.length - 1);
      return {
        forValue: state.value,
        dismissed: false,
        index: (clamped + step + matches.length) % matches.length,
      };
    });
  };

  // TUI-C24 — capture a bracketed paste as buffered text instead of keystrokes. Ink enables
  // bracketed-paste mode while this hook is mounted and routes the pasted payload here (off the
  // `useInput` channel), so its embedded newlines never reach Enter handling. The paste is inserted
  // AT THE CARET and does NOT submit — a later explicit Enter submits it all.
  usePaste((text) => {
    const pasted = normalizePastedText(text);
    if (!pasted) return;
    setState((current) => insertText(current, pasted));
  });

  useInput(
    (_input, key) => {
      // Only claim keys while the menu is visible; otherwise the editor handles everything.
      if (!menuActive) return;
      if (key.upArrow) {
        moveHighlight(-1);
      } else if (key.downArrow) {
        moveHighlight(1);
      } else if (key.tab) {
        // Complete to the highlighted name plus a trailing space: the space closes the menu (the
        // input now has whitespace) and leaves the caret ready for args, without dispatching.
        setState(createEditorState(`/${matches[selectedIndex].name} `));
      } else if (key.escape) {
        setMenu({ forValue: state.value, dismissed: true, index: 0 });
      } else if (key.return) {
        // With the menu open, Enter dispatches the HIGHLIGHTED command (so "/mo"+Enter runs
        // "/mode") rather than the typed text. The parent's handler parses + dispatches through
        // the registry either way, so fully-typed dispatch is unchanged. <PromptEditor> stands
        // down from Enter while `menuActive`, so this is the only claimant.
        submit(`/${matches[selectedIndex].name}`);
      }
    },
    // Active only while the prompt is mounted; harmless when the menu is closed (early return).
    { isActive: true }
  );

  return (
    <Box flexDirection="column">
      {menuActive ? <SlashCommandMenu commands={matches} selectedIndex={selectedIndex} /> : null}
      {/* The editor hands up an UPDATER, which goes straight to `setState`: two keystrokes that
          share one stdin chunk are dispatched in one batch, and only an updater composes on its
          predecessor's result rather than on the state both of them were rendered with. */}
      <PromptEditor state={state} onChange={setState} onSubmit={submit} menuActive={menuActive} />
    </Box>
  );
}
