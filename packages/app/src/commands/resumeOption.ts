import { InvalidArgumentError, Option, type Command } from 'commander';
import { parseResumeId } from '@gaunt-sloth/agent/modules/sessionResume.js';
import type { InteractiveSessionOptions } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

/**
 * GS2-20 — the `--resume <id>` flag, defined once and attached three times: on `chat`, on `code`,
 * and on the root program for the bare `gth` that starts a code session. The value is validated
 * here, where commander reports a bad one in its own voice and exits before any config is loaded,
 * so a typo never reaches the session.
 */
export function resumeOption(): Option {
  return new Option(
    '--resume <id>',
    'Pick up a saved conversation where it left off (the id from `gth history list`)'
  ).argParser((raw: string): number => {
    const id = parseResumeId(raw);
    if (id === null) {
      throw new InvalidArgumentError(
        'Expected a conversation id — a positive whole number, as printed by `gth history list`.'
      );
    }
    return id;
  });
}

/**
 * The session options a command starts with: `{ resumeConversationId }` when `--resume` was given
 * — on the subcommand itself or on the root program, so `gth chat --resume 12` and
 * `gth --resume 12 chat` mean the same thing — and nothing at all otherwise, so a session started
 * without the flag is started exactly as it always was.
 */
export function sessionOptionsFor(
  program: Command,
  own: { resume?: number }
): InteractiveSessionOptions | undefined {
  const resumeConversationId =
    own.resume ?? (program.getOptionValue('resume') as number | undefined);
  return resumeConversationId === undefined ? undefined : { resumeConversationId };
}
