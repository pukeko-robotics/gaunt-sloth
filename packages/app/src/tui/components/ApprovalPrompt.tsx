import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';

/**
 * The scoped tool-approval affordance (EXT-9 Phase B2) — the Ink TUI counterpart to the
 * readline `Approve? [o]nce / [s]ession / [a]lways / [N]o:` prompt. Shown when a
 * `run_shell_command` interrupt is pending; styled like a warn-tone {@link CommandNotice}
 * (yellow bold title + dim body bracketed by a rule) so it reads consistently in the
 * transcript dock. While it is mounted the parent `<App>` routes keyboard input here and
 * suspends the normal prompt, so the command can't be typed into the chat box.
 *
 * Pure/presentational: it only renders the pending command + the choices. The key handling
 * (o/s/a → approve, anything else → reject) lives in `<App>`'s `useInput`, mirroring the way
 * the debug panel's scroll keys are owned by the root component.
 */
export function ApprovalPrompt({
  pending,
}: {
  pending: PendingToolInterrupt;
}): React.ReactElement {
  const commandText =
    typeof pending.args.command === 'string'
      ? (pending.args.command as string)
      : JSON.stringify(pending.args);
  return (
    <Box flexDirection="column">
      <Rule />
      <Text bold color="yellow">
        {`The agent wants to run a shell command via ${pending.name}`}
      </Text>
      <Text dimColor>{`    ${commandText}`}</Text>
      <Text dimColor>{'Approve?  [o]nce   [s]ession   [a]lways   [N]o'}</Text>
    </Box>
  );
}
