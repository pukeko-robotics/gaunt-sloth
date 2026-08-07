import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { SelectList, type SelectItem } from '#src/tui/components/SelectList.js';
import type { ApprovalRung } from '@gaunt-sloth/core/config.js';
import { APPROVAL_WRITE_MODIFIER_HINT } from '@gaunt-sloth/core/config.js';
import type { ApprovalPostureChoice } from '@gaunt-sloth/agent/modules/slashCommands.js';

/**
 * CFG-39 — the row label for one posture: the display spelling, a marker when the session is
 * already on it, and the mode's own first sentence.
 *
 * The description is NOT authored here. Six surfaces describe these modes and a picker carrying
 * its own copy becomes the one that contradicts the other five, so the text arrives on the choice
 * (from `APPROVAL_RUNG_DESCRIPTIONS`) and this function only lays it out.
 */
export function pickerRowLabel(choice: ApprovalPostureChoice): string {
  const marker = choice.current ? '●' : '○';
  return `${marker} ${choice.label} — ${choice.description.split('. ')[0]}.`;
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
 * Keyboard handling, filtering and cancellation are {@link SelectList}'s — the same widget the
 * first-run dialog and the slash-command menu use — so arrow keys, Enter, Esc and Ctrl+C behave
 * here exactly as they do everywhere else in the TUI. While it is mounted the parent `<App>`
 * suspends the prompt, as it does for `<ApprovalPrompt>`.
 */
export function ApprovalsPicker({
  choices,
  onSelect,
  onCancel,
}: {
  choices: ApprovalPostureChoice[];
  /** Called with the chosen mode. The parent applies it through the runner. */
  onSelect: (rung: ApprovalRung) => void;
  /** Esc / Ctrl+C — leave the mode exactly as it was. */
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
        onSelect={(index) => onSelect(choices[index].rung)}
        onCancel={onCancel}
      />
      <Text dimColor>{`  ${APPROVAL_WRITE_MODIFIER_HINT}`}</Text>
      <Text dimColor>{'  Enter to choose · Esc to keep the current mode'}</Text>
    </Box>
  );
}
