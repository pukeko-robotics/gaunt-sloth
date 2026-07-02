import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import { filterSlashCommands, slashMenuQuery, type SlashCommand } from '#src/tui/slashCommands.js';

/**
 * The user prompt line. Mirrors the readline `  > ` prompt. Clears on submit; the parent
 * hides it while a turn is running so Ink owns stdin uncontended during streaming.
 *
 * TUI-C10 — while the user is typing a bare slash command (input starts with `/`, no space yet),
 * a discovery menu of the matching registered commands appears just above the prompt. The registry
 * (`commands`) is the single source, so extension-registered commands show automatically. Arrow
 * keys move the highlight, Tab completes the highlighted name, Enter dispatches it, Esc dismisses
 * the menu. The keyboard split is clean: `ink-text-input` ignores Up/Down/Tab and only fires
 * `onSubmit` on Enter, so this component's `useInput` owns the arrows/Tab/Esc while `onSubmit` owns
 * Enter — no double-handling. A fully-typed command still dispatches exactly as before (Enter with
 * the menu open just submits the highlighted command, which equals what was typed).
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
  const [value, setValue] = useState('');
  // Highlighted row in the menu. Reset to the top whenever the query changes (the filtered list
  // changes under it), so navigation always starts from the most-relevant match.
  const [cursor, setCursor] = useState(0);
  // Esc dismisses the menu without clearing the input; typing anything re-opens it (onChange
  // clears this flag), matching how palette menus behave elsewhere.
  const [dismissed, setDismissed] = useState(false);

  const query = slashMenuQuery(value);
  const matches = query !== null && !dismissed ? filterSlashCommands(commands, query) : [];
  const menuActive = matches.length > 0;
  // Clamp defensively in case the filtered list shrank below the cursor between renders.
  const selectedIndex = menuActive ? Math.min(cursor, matches.length - 1) : 0;

  // Let the parent suppress its competing Tab handler (debug-panel focus) while the menu is open.
  useEffect(() => {
    onMenuStateChange?.(menuActive);
  }, [menuActive, onMenuStateChange]);

  useInput(
    (_input, key) => {
      // Only claim keys while the menu is visible; otherwise TextInput handles everything.
      if (!menuActive) return;
      if (key.upArrow) {
        setCursor((c) => (Math.min(c, matches.length - 1) - 1 + matches.length) % matches.length);
      } else if (key.downArrow) {
        setCursor((c) => (Math.min(c, matches.length - 1) + 1) % matches.length);
      } else if (key.tab) {
        // Complete to the highlighted name plus a trailing space: the space closes the menu (the
        // input now has whitespace) and leaves the cursor ready for args, without dispatching.
        setValue(`/${matches[selectedIndex].name} `);
        setDismissed(false);
        setCursor(0);
      } else if (key.escape) {
        setDismissed(true);
      }
      // Enter is intentionally NOT handled here — TextInput's onSubmit owns it (see onSubmit).
    },
    // Active only while the prompt is mounted; harmless when the menu is closed (early return).
    { isActive: true }
  );

  return (
    <Box flexDirection="column">
      {menuActive ? <SlashCommandMenu commands={matches} selectedIndex={selectedIndex} /> : null}
      <Box>
        <Text color="cyan">{'  > '}</Text>
        <TextInput
          value={value}
          onChange={(next) => {
            setValue(next);
            setDismissed(false);
            setCursor(0);
          }}
          onSubmit={(submitted) => {
            // With the menu open, Enter dispatches the HIGHLIGHTED command (so "/mo"+Enter runs
            // "/mode"); otherwise submit exactly what was typed. Either way the parent's handler
            // parses + dispatches through the registry, so fully-typed dispatch is unchanged.
            const toSubmit = menuActive ? `/${matches[selectedIndex].name}` : submitted;
            setValue('');
            setDismissed(false);
            setCursor(0);
            onSubmit(toSubmit);
          }}
        />
      </Box>
    </Box>
  );
}
