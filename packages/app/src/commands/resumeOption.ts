import { InvalidArgumentError, Option, type Command } from 'commander';
import {
  formatConversationRef,
  parseConversationRef,
  type ConversationRef,
} from '@gaunt-sloth/core/history/conversationRef.js';
import type { InteractiveSessionOptions } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';

/**
 * GS2-20 — the `--resume <id>` flag, defined once and attached three times: on `chat`, on `code`,
 * and on the root program for the bare `gth` that starts a code session. The value is validated
 * here, where commander reports a bad one in its own voice and exits before any config is loaded,
 * so a typo never reaches the session.
 *
 * GS2-106 — it parses to a reference, not an integer: the run id cannot be resolved to a row here,
 * because the store's path comes from the config and this runs before it is loaded. The session
 * resolves the reference through the resume seam, exactly as it resolves an integer.
 */
export function resumeOption(): Option {
  return new Option(
    '--resume <id>',
    'Pick up a saved conversation where it left off (the id from `gth history list`)'
  ).argParser((raw: string): ConversationRef => {
    const ref = parseConversationRef(raw);
    if (ref === null) {
      throw new InvalidArgumentError(
        'Expected a conversation id — a positive whole number or a run id, as printed by ' +
          '`gth history list`.'
      );
    }
    return ref;
  });
}

/** The subcommands a root `--resume` can ride along with; the bare command is a `code` session. */
export const RESUMABLE_COMMANDS: ReadonlySet<string> = new Set(['chat', 'code']);

/**
 * GS2-20 — the sentence for a root `--resume` typed in front of a subcommand that cannot take it
 * (`gth --resume 12 ask "…"`). Commander accepts the root option before every subcommand, and only
 * the session commands read it, so without this the intent would be dropped and a fresh `ask`
 * would run as if nothing had been asked. Same register as the ordered checks: what applies, what
 * does not yet, and that nothing ran.
 */
export function rootResumeRefusalMessage(
  subcommand: string,
  ref: ConversationRef | number
): string {
  return (
    `Cannot resume into \`gth ${subcommand}\`: \`--resume\` applies to \`gth chat\`, \`gth code\` ` +
    'and the bare `gth` command. Resuming a conversation into `ask` or `exec` is not available ' +
    `yet (GS2-106). Nothing was run, and conversation ${formatConversationRef(ref)} was not touched.`
  );
}

/**
 * The session options a command starts with: `{ resumeConversationId }` when `--resume` was given
 * — on the subcommand itself or on the root program, so `gth chat --resume 12` and
 * `gth --resume 12 chat` mean the same thing — and nothing at all otherwise, so a session started
 * without the flag is started exactly as it always was.
 */
export function sessionOptionsFor(
  program: Command,
  own: { resume?: ConversationRef }
): InteractiveSessionOptions | undefined {
  const resumeConversationId =
    own.resume ?? (program.getOptionValue('resume') as ConversationRef | undefined);
  return resumeConversationId === undefined ? undefined : { resumeConversationId };
}
