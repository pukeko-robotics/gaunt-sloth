/**
 * @module core/shell/abstention
 *
 * EXT-65 — **what the AGENT is told when the gate abstains.**
 *
 * {@link import('#src/core/shell/rater.js').abstentionReason} establishes the *state*: the gate
 * could not statically resolve this command's target. That sentence is true, honest, and on its own
 * useless to the only party who can act on it. The measured failure mode when a model is told only
 * that is *still abstains* — it knows it must change something, not what.
 *
 * This module turns the state into a **mechanical defect report**: which shape in the command the
 * gate could not read, and the concrete move that fits that shape. The framing is deliberate and it
 * is the whole design — **assume the model did not go rogue; most likely it made an ordinary
 * mistake.** An abstention is the only finding an agent can *comply with* rather than argue about,
 * because the defect is in the command's FORM, not in its intent. `pwd && ls` is not a model defect:
 * it is a correct shell idiom, and the gate is the only party that cannot read it.
 *
 * Two properties this module exists to hold:
 *
 * - **A remedy, not a reason.** Without a named move the model works *around* the gate — retrying
 *   variants, or abandoning legitimate work — instead of *through* it. Every mechanism here names
 *   the move that fits it.
 * - **The quoted command is INERT DATA.** A command the gate cannot parse is frequently one the
 *   model assembled out of text it read somewhere (an issue body, a fetched page, MCP output), so
 *   quoting it back is quoting untrusted bytes into the model's context. The fencing is
 *   `utils/untrustedText.ts`'s, applied by `core/shell/rejection.ts` at the moment of wrapping —
 *   defang first, wrap second.
 */
import {
  COMMAND_SEPARATOR_RE,
  LINE_BREAK_RE,
  normalizeCommand,
} from '#src/core/shell/normalize.js';
import { buildRejectionMessage } from '#src/core/shell/rejection.js';
import type { GrantedToolSummary } from '#src/config/tool-descriptions.js';

/**
 * **The retry budget: ONE.**
 *
 * A defect report is a search oracle, and it can only search *toward* resolvability — which is more
 * scrutiny, not less. But an unbounded loop is an agent grinding against a deterministic wall, so
 * the **second consecutive** abstention escalates to the human exactly as it did before this node.
 *
 * Consecutive, never per-session: a per-session budget would mean the second legitimate composed
 * command in a long session interrupts a human, which inverts the goal this whole path serves.
 */
export const ABSTENTION_RETRY_LIMIT = 1;

/**
 * The shape in the command that the gate's parser could not resolve.
 *
 * These are FORMS, not judgements — nothing here says a command is dangerous, and nothing here is
 * a rating. They exist only to select a remedy.
 */
export type AbstentionMechanism =
  /** A git commit whose message contains a substitution the SHELL runs before git sees it. */
  | 'commit-message-substitution'
  /** More than one command: `;`, `&`, `&&`, `|`, `||`, or a line break. */
  | 'composition'
  /** Command / variable / process substitution: `$(…)`, backticks, `${…}`, `<(…)`. */
  | 'substitution'
  /** A stream redirect: `>`, `>>`, `<`, `2>`, `&>`. */
  | 'redirect'
  /** None of the above — an unbalanced quote, an empty command, or no resolvable program name. */
  | 'unparseable';

/** A refused command's defect report: the shapes found, and the moves that fit them. */
export interface AbstentionDefect {
  /** The most specific mechanism found — what the report leads with. */
  mechanism: AbstentionMechanism;
  /** Every mechanism found, in remedy order. A command may carry more than one. */
  mechanisms: AbstentionMechanism[];
  /** One concrete move per mechanism, in the same order. Never empty. */
  remedies: string[];
}

/**
 * The file tools this looks for when a remedy needs to name one, best first.
 *
 * Only a tool **granted at the session's rung** may be named: suggesting a tool that would itself
 * raise an approval is not a remedy, it is a second interruption. The caller supplies the granted
 * set (§4.3/§4.4's `describeGrantedBuiltInTools`), so the name can only ever be a tool this session
 * actually has, and the list is checked in preference order rather than by picking the first match
 * so the advice does not depend on tool-registration order.
 */
const FILE_WRITE_TOOL_PREFERENCE = ['write_file', 'edit_file'] as const;

/** Process substitution `<(…)` / `>(…)`, which is a SUBSTITUTION and must not also read as a redirect. */
const PROCESS_SUBSTITUTION_RE = /[<>]\(/g;

/**
 * Does this look like a `git commit` carrying an inline message?
 *
 * Deliberately a heuristic and not a parser: the command has already defeated the gate's tokenizer,
 * so there is nothing precise left to parse. It is safe to be approximate here because a wrong
 * answer costs at most a less specific remedy — the escalation behaviour does not depend on it.
 */
const GIT_COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/i;
const INLINE_MESSAGE_FLAG_RE = /(^|\s)(-m\b|--message\b|-\w*m\b)/;

/** Command substitution `$(…)` or a backtick — the two the shell EXECUTES. */
const EXECUTING_SUBSTITUTION_RE = /\$\(|`/;

/** Every substitution/expansion form, including the non-executing ones. */
const ANY_SUBSTITUTION_RE = /\$\(|`|\$\{|[<>]\(/;

/** The granted write tool to name in a remedy, or `undefined` when this rung grants none. */
function grantedWriteTool(
  grantedTools: readonly GrantedToolSummary[] | undefined
): string | undefined {
  if (!grantedTools || grantedTools.length === 0) return undefined;
  const names = new Set(grantedTools.map((tool) => tool.name));
  return FILE_WRITE_TOOL_PREFERENCE.find((name) => names.has(name));
}

/**
 * Classify a refused command and name the moves that fit it.
 *
 * Detection runs on the NORMALIZED command (the same form
 * {@link import('#src/core/shell/arity.js').classifyCommand} refused), so obfuscation that the
 * normalizer collapses cannot hide a mechanism from the report — while the command quoted back to
 * the model stays the RAW one it actually sent, because a normalized string it does not recognise
 * is not a defect report it can act on.
 *
 * The line-break check reads the RAW command, exactly as `classifyCommand` does: the normalizer is
 * not required to preserve that separator, and EXT-55 is the node about what happens when a caller
 * assumes it did.
 *
 * **Order is remedy order, most specific first**, and `commit-message-substitution` SUPPRESSES the
 * generic substitution remedy it is a special case of — telling the model both "write the message
 * to a file" and "compute the inner value first" for the same `$(…)` is two answers to one
 * question.
 *
 * Never returns an empty remedy list: `unparseable` is the fallback for the causes that are not a
 * shape at all (an unbalanced quote, an empty command, a command with no resolvable program name),
 * so a caller always has something to say.
 */
export function describeAbstention(
  command: string,
  context?: { grantedTools?: readonly GrantedToolSummary[] }
): AbstentionDefect {
  const normalized = normalizeCommand(command);
  const writeTool = grantedWriteTool(context?.grantedTools);

  const composes = COMMAND_SEPARATOR_RE.test(normalized) || LINE_BREAK_RE.test(command.trim());
  const substitutes = ANY_SUBSTITUTION_RE.test(normalized);
  const commitSubstitution =
    GIT_COMMIT_RE.test(normalized) &&
    INLINE_MESSAGE_FLAG_RE.test(normalized) &&
    EXECUTING_SUBSTITUTION_RE.test(normalized);
  // A redirect is any `<`/`>` that is NOT the opening of a process substitution — that form is
  // already reported (and remedied) as a substitution, and reporting it twice would name two
  // different moves for one piece of syntax.
  const redirects = /[<>]/.test(normalized.replace(PROCESS_SUBSTITUTION_RE, ''));

  const mechanisms: AbstentionMechanism[] = [];
  const remedies: string[] = [];

  if (commitSubstitution) {
    mechanisms.push('commit-message-substitution');
    remedies.push(
      'A commit message containing backticks or a dollar-parenthesis is run by the SHELL as a ' +
        'command before git ever sees it, which is why the gate will not resolve it. Write the ' +
        `message to a file with ${writeTool ?? 'a file-writing tool'} and commit with ` +
        '`git commit -F <file>`. Keep the message plain prose: no code, no shell, no backticks.'
    );
  }
  if (composes) {
    mechanisms.push('composition');
    remedies.push(
      'This runs more than one command (a `;`, `&&`, `||`, `|` or a line break separates them). ' +
        'Issue each part as its OWN sequential run_shell_command call, in order, and read each ' +
        'result before sending the next.'
    );
  }
  if (substitutes && !commitSubstitution) {
    mechanisms.push('substitution');
    remedies.push(
      'This substitutes the output of another command or the value of a variable into itself ' +
        '(`$(…)`, backticks, `${…}`), so what actually runs is not knowable from the text. Run ' +
        'the inner command by itself first, then issue the outer command with the literal result ' +
        'written in place of the substitution.'
    );
  }
  if (redirects) {
    mechanisms.push('redirect');
    remedies.push(
      writeTool
        ? `This redirects a stream to or from a file. Use ${writeTool} instead — it is already ` +
            'granted at this approval level, so it will not interrupt the user.'
        : 'This redirects a stream to or from a file. Issue the command without the redirect and ' +
            'use its result directly; no file tool is granted at this approval level.'
    );
  }
  if (mechanisms.length === 0) {
    mechanisms.push('unparseable');
    remedies.push(
      'The gate could not tokenize this command at all — most often an unbalanced quote, or no ' +
        'program name it could identify. Re-issue it as one command: a single program, its ' +
        'arguments, and balanced quotes.'
    );
  }

  return { mechanism: mechanisms[0], mechanisms, remedies };
}

/**
 * The full defect report handed back to the model in place of an approval prompt.
 *
 * Rendered by {@link buildRejectionMessage} under the `gate` source, so the abstention speaks the
 * same rejection vocabulary as a user's refusal and a rater's — one builder, one shape, one place a
 * refusal's wording is decided.
 *
 * @param command The raw command, as the model proposed it. Quoted back as inert data.
 * @param toolName The refused tool.
 * @param reason {@link import('#src/core/shell/rater.js').abstentionReason}'s own sentence — the
 *   mechanism in core's words, never a second copy of that prose written here.
 * @param context The built-in tools granted at the session's rung, so a remedy may name one.
 */
export function buildAbstentionRejection(
  command: string,
  toolName: string,
  reason: string,
  context?: { grantedTools?: readonly GrantedToolSummary[] }
): string {
  const defect = describeAbstention(command, context);
  return buildRejectionMessage({
    source: 'gate',
    toolName,
    abstention: { mechanism: reason, quoted: command, remedies: defect.remedies },
  });
}
