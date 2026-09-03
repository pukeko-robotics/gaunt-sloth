import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import { readChatPrompt, readCodePrompt } from '@gaunt-sloth/core/utils/llmUtils.js';

/**
 * The two interactive session configurations, in one place, because three entry points need them:
 * `gth chat` / `gth code` (and bare `gth`) each start their own, and GS2-20's
 * `gth history resume <id>` starts whichever one the stored conversation was recorded under. A
 * conversation resumed under the other mode would get the other mode's tools and prompt, so the
 * lookup below is by the recorded command and refuses anything that is not one of these two.
 */
export const CHAT_SESSION_CONFIG: SessionConfig = {
  mode: 'chat',
  // Wrapped rather than referenced, so the prompt reader is resolved when a session asks for it
  // and not when this module loads — a command spec that stubs the other mode's reader alone must
  // not fail on the one it never calls.
  readModePrompt: (config) => readChatPrompt(config),
  description: 'Start an interactive chat session with Gaunt Sloth',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  // [[TUI-C79]] — this row is shared by BOTH surfaces (the Ink dock composes it with
  // TUI_HINT_SUFFIX; the readline session prints it as-is), so every clause has to be true on
  // both. `exit` is: it needs no condition on either surface, in any state. `Ctrl+C` no longer
  // is — on the TUI it scraps a draft first and stops a turn second, and it only leaves from the
  // bottom of that ladder — and no accurate short wording exists for a fixed row, so the clause
  // is dropped rather than qualified. `/help` is the reference, and lists Ctrl+C per context.
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

export const CODE_SESSION_CONFIG: SessionConfig = {
  mode: 'code',
  readModePrompt: (config) => readCodePrompt(config),
  description:
    'Interactively write code with sloth (has full file system access within your project)',
  readyMessage: '\nGaunt Sloth is ready to code. Type your prompt.',
  // [[TUI-C79]] — the same shared-row rule as the chat config: `exit` is the one route that is true
  // on both surfaces in every state, `Ctrl+C` is a three-meaning key on the TUI and cannot be
  // stated accurately in a fixed row, and `/help` is where the per-context version lives.
  exitMessage: "Type 'exit' to leave the code session · /help for commands\n",
};

/**
 * The session configuration a recorded conversation is resumed under, keyed by the command that
 * recorded it. `null` for every other command — `ask`, `exec`, `review`, `pr`, … are single-shot
 * runs that keep no conversation state, so there is nothing to resume them into.
 */
export function sessionConfigFor(command: string | undefined): SessionConfig | null {
  if (command === 'chat') return CHAT_SESSION_CONFIG;
  if (command === 'code') return CODE_SESSION_CONFIG;
  return null;
}
