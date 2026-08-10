import React, { useEffect, useRef, useState } from 'react';
import { Box, useInput, usePaste } from 'ink';
import { PromptEditor } from '#src/tui/components/PromptEditor.js';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import {
  filterSlashCommands,
  slashMenuQuery,
  type SlashCommand,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import {
  createEditorState,
  insertText,
  pressEnter,
  type EditorState,
} from '#src/tui/lineEditor.js';
import { normalizePastedText } from '#src/tui/pasteParser.js';

/** The prompt buffer, with the monotonic serial of the edits that produced it. */
interface PromptBuffer {
  readonly state: EditorState;
  readonly edits: number;
}

/**
 * The user prompt line. Mirrors the readline `  > ` prompt. Clears on submit; the parent
 * hides it while a turn is running so Ink owns stdin uncontended during streaming.
 *
 * The buffer and caret live here as an {@link import('#src/tui/lineEditor.js').EditorState} and are
 * rendered and driven by `<PromptEditor>` (TUI-C25), which owns the keyboard for everything that
 * edits text. This component owns what the buffer *means*: the slash menu it may open, and the
 * submission it becomes — including what Enter means, which is decided against the authoritative
 * buffer so that it reads the text its predecessors in the same stdin chunk produced.
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
  /**
   * The buffer and its edit serial — authoritative in a REF, mirrored into state for rendering.
   *
   * A keystroke is not delivered alone: Ink splits one stdin chunk into several key events and
   * dispatches them synchronously, so a handler that computes from the rendered value computes from
   * the text as it stood before its predecessors in that chunk. Holding a Backspace is exactly that
   * shape — Ink splits repeated backspace bytes into separate events precisely *because* holding the
   * key sends them in one chunk. A ref is written and read synchronously, so each keystroke sees
   * what the one before it did, and `onSubmit` can still be called straight from the handler that
   * decided on it (which a `setState` updater, being pure, could not do). It is the same
   * ref-plus-mirror shape `<App>` uses for its own keystroke-driven text buffers.
   *
   * `edits` counts only the updates that CHANGED the text, and it is the key the menu's transient
   * bookkeeping hangs on. Keying that bookkeeping on the text itself is the obvious thing and it is
   * wrong: an Esc-dismissal or a stale highlight resurrects the moment an edit returns the buffer to
   * a value it has already held — a Backspace back to the previous query, or the same query typed
   * again in a later message. A serial never repeats, so the bookkeeping is invalidated by any edit
   * and by nothing else; a bare caret move leaves it alone, which is what lets Esc survive an arrow.
   */
  const [buffer, setBuffer] = useState<PromptBuffer>(() => ({
    state: createEditorState(),
    edits: 0,
  }));
  const bufferRef = useRef(buffer);
  const state = buffer.state;

  /** Make `next` the buffer: authoritative immediately, on screen at the next render. */
  const commitBuffer = (next: PromptBuffer): void => {
    bufferRef.current = next;
    setBuffer(next);
  };

  /** Apply one edit or motion, counting it as an edit only if it changed the text. */
  const applyEdit = (update: (previous: EditorState) => EditorState): void => {
    const previous = bufferRef.current;
    const next = update(previous.state);
    commitBuffer({
      state: next,
      edits: next.value === previous.state.value ? previous.edits : previous.edits + 1,
    });
  };

  /** Submit `value` and clear the buffer; the bumped serial resets the menu (see `bufferRef`). */
  const submit = (value: string): void => {
    commitBuffer({ state: createEditorState(), edits: bufferRef.current.edits + 1 });
    onSubmit(value);
  };

  /**
   * Enter, with the menu closed — decided here rather than in the editor.
   *
   * What Enter means depends on the buffer (a trailing backslash continues the line, anything else
   * submits it), so the decision reads the same authoritative buffer every other keystroke writes.
   * Decided from a render instead, an Enter sharing a chunk with an edit answers about the text
   * before that edit: a held Backspace released into Enter shows the corrected text on screen and
   * sends the uncorrected text, then clears the buffer so nothing survives to show it.
   */
  const pressEnterOnBuffer = (): void => {
    const result = pressEnter(bufferRef.current.state);
    if (result.kind === 'continue') {
      commitBuffer({ state: result.state, edits: bufferRef.current.edits + 1 });
      return;
    }
    submit(result.value);
  };

  /**
   * The menu's transient state, keyed on the edit serial it belongs to.
   *
   * `dismissed` is Esc's, so the menu can be sent away without clearing the input; `index` is the
   * highlighted row, which starts at the most-relevant match whenever the query changes under it.
   */
  const [menu, setMenu] = useState<{ forEdit: number; dismissed: boolean; index: number }>({
    forEdit: 0,
    dismissed: false,
    index: 0,
  });
  const menuAppliesToBuffer = menu.forEdit === buffer.edits;

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

  /** Step the highlight by `step`, wrapping — the menu is open, so there is a list to step. */
  const moveHighlight = (step: number): void => {
    const forEdit = bufferRef.current.edits;
    setMenu((previous) => {
      const current = previous.forEdit === forEdit ? previous.index : 0;
      const clamped = Math.min(current, matches.length - 1);
      return {
        forEdit,
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
    applyEdit((current) => insertText(current, pasted));
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
        applyEdit(() => createEditorState(`/${matches[selectedIndex].name} `));
      } else if (key.escape) {
        setMenu({ forEdit: bufferRef.current.edits, dismissed: true, index: 0 });
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
      {/* The editor decides nothing that depends on the text: it hands up an UPDATER for each edit
          and motion, and merely REPORTS Enter. Both go through `setBuffer`, so two keystrokes that
          share one stdin chunk compose in order instead of the second overwriting the first. */}
      <PromptEditor
        state={state}
        onChange={applyEdit}
        onEnter={pressEnterOnBuffer}
        menuActive={menuActive}
      />
    </Box>
  );
}
