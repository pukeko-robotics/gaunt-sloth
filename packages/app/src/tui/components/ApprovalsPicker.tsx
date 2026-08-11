import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { SelectList, type SelectItem } from '#src/tui/components/SelectList.js';
import type { ApprovalRung } from '@gaunt-sloth/core/config.js';
import { APPROVAL_WRITE_MODIFIER_HINT } from '@gaunt-sloth/core/config.js';
import {
  firstSentence,
  type ApprovalPostureChoice,
} from '@gaunt-sloth/agent/modules/slashCommands.js';

/**
 * CFG-39 — the row label for one posture: the display spelling, a marker when the session is
 * already on it, and the mode's own first sentence.
 *
 * The description is NOT authored here. Six surfaces describe these modes and a picker carrying
 * its own copy becomes the one that contradicts the other five, so the text arrives on the choice
 * (from `APPROVAL_RUNG_DESCRIPTIONS`) and this function only lays it out.
 *
 * Shortening to one sentence is {@link firstSentence}'s, shared with the text fallback and the
 * usage hint, so a picker row and the same mode's line on a non-TTY surface cannot end differently.
 */
export function pickerRowLabel(choice: ApprovalPostureChoice): string {
  const marker = choice.current ? '●' : '○';
  return `${marker} ${choice.label} — ${firstSentence(choice.description)}`;
}

/**
 * CFG-39 — the interactive `/approvals` picker: the four postures as selectable rows, on a TTY.
 *
 * **Four rows, not five.** `write` is a modifier of Manual rather than a posture of its own, so it
 * leaves quick access while staying fully settable via `/approvals write` — which is what the
 * footer line says. A session that IS on `write` marks no row as current, and the caller's status
 * notice reports the live mode honestly rather than letting a highlighted Manual row imply the
 * session is somewhere it is not.
 *
 * Keyboard handling and cancellation are {@link SelectList}'s — the same widget the first-run
 * dialog and the slash-command menu use — so arrow keys, Enter and Esc behave here exactly as they
 * do everywhere else in the TUI. **`Ctrl+C` is the one exception, and it is the app's**: this picker
 * renders inside the session's own Ink tree rather than in a nested `render`, so `<App>`'s ladder
 * ([[TUI-C79]]) answers it and leaves the session — the same thing it did when Ink owned the key.
 * The mode is untouched either way. While it is mounted the parent `<App>` suspends the prompt, as
 * it does for `<ApprovalPrompt>`.
 *
 * **Type-to-filter is off** (`filterable={false}`). Four rows are readable at a glance, so
 * filtering could only cost: one stray keystroke would empty the list and leave Enter with nothing
 * to pick, and the first Esc would go on clearing the filter rather than closing the picker — which
 * is the opposite of what the footer below promises. With it off the footer is true as written.
 */
export function ApprovalsPicker({
  choices,
  onSelect,
  onCancel,
}: {
  choices: ApprovalPostureChoice[];
  /** Called with the chosen mode. The parent applies it through the runner. */
  onSelect: (rung: ApprovalRung) => void;
  /** Esc — leave the mode exactly as it was. */
  onCancel: () => void;
}): React.ReactElement {
  const items: SelectItem[] = choices.map((choice) => ({ label: pickerRowLabel(choice) }));
  const currentIndex = choices.findIndex((choice) => choice.current);
  return (
    <Box flexDirection="column">
      <Rule />
      <SelectList
        title="Choose an approvals mode:"
        items={items}
        // Start on the mode in force, so Enter is a no-op rather than a silent change. On `write`
        // no row is current and the cursor rests at the top.
        initialIndex={currentIndex >= 0 ? currentIndex : 0}
        filterable={false}
        onSelect={(index) => onSelect(choices[index].rung)}
        onCancel={onCancel}
      />
      <Text dimColor>{`  ${APPROVAL_WRITE_MODIFIER_HINT}`}</Text>
      <Text dimColor>{'  Enter to choose · Esc to keep the current mode'}</Text>
    </Box>
  );
}
