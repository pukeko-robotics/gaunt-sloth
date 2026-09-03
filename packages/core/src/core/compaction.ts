/**
 * @packageDocumentation
 * GS2-23 — **the one conversation-compaction mechanism.** Folds the older part of a conversation
 * into a single summary message and keeps a recent tail verbatim, so the model has room to go on.
 *
 * Every path that shortens a conversation goes through {@link compactMessages}: the manual
 * `/compact` (this node), the reactive compact-and-retry on a context overflow (EXT-160) and the
 * preventive threshold (EXT-161). Built separately they would disagree about what a context window
 * is, so the invariants live here once, as tests rather than as comments:
 *
 * - **(a)** a `tool_call` is never separated from its `tool_result`: the cut moves so an `AIMessage`
 *   with `tool_calls` and every `ToolMessage` answering it fall on the same side, by widening the
 *   kept tail back to the pair's start;
 * - **(b)** a system prompt survives untouched, and the summary is carried in a `HumanMessage` —
 *   never a mid-list `SystemMessage`, which `ChatAnthropic` rejects outright;
 * - **(c)** the tail is never truncated at its end, so the last message of the input is the last
 *   message of the output: a history that ended on the pending user turn still does, and no
 *   compaction turns a completed exchange into a trailing assistant turn;
 * - **(d)** the operation converges: a previous summary is recognised by its marker and folded into
 *   the new one, so a compacted history compacted again holds exactly one summary message.
 *
 * The function is pure over its inputs and does no I/O of its own: the model call is injected as
 * `summarize`, which is what lets the involuntary path bind a different model, a test bind a stub,
 * and the manual command bind the session's own. Applying the result to the live graph is the
 * runner's job (`GthAgentRunner.compactConversation`), through {@link replaceGraphMessages}.
 */
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  getBufferString,
  type BaseMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';

/**
 * How many trailing messages a compaction keeps verbatim when the caller names no number.
 *
 * Small on purpose: a compaction is asked for when the conversation has grown too long, and the
 * summary is what carries the rest. Six is roughly the last exchange with a tool call in it, or the
 * last three plain exchanges — enough that the model still sees, word for word, what it was just
 * doing. The kept tail can be wider than this when the cut would have split a tool pair (see
 * {@link compactionCutIndex}).
 */
export const DEFAULT_KEEP_RECENT = 6;

/**
 * The marker a summary message carries in `additional_kwargs.lc_source`, so a later compaction can
 * recognise it and fold it in rather than nest a summary inside a summary.
 *
 * It rides in the slot LangChain's own `summarizationMiddleware` uses (`lc_source: 'summarization'`),
 * which is why {@link isCompactionSummary} accepts both values: a history that the opt-in
 * middleware already summarised converges through here the same way one of ours does.
 */
export const COMPACTION_SUMMARY_SOURCE = 'gth-compaction';

/** The marker LangChain's `summarizationMiddleware` stamps on the summary messages IT produces. */
const LANGCHAIN_SUMMARY_SOURCE = 'summarization';

/** The line the summary message opens with, so the model reads what follows as a summary. */
export const COMPACTION_SUMMARY_PREFIX = 'Here is a summary of the conversation to date:';

/** What a compaction hands back: the replacement list and what changed. */
export interface CompactMessagesResult {
  /** The replacement message list — the input unchanged when `changed` is false. */
  messages: BaseMessage[];
  /** The summary the model produced, or `''` when nothing was folded. */
  summaryText: string;
  /** How many messages were folded into the summary (a previous summary counts as one of them). */
  removedCount: number;
  /** How many trailing messages were kept verbatim. */
  keptCount: number;
  /** Whether anything was folded. False leaves the conversation exactly as it was. */
  changed: boolean;
}

/** The summariser a compaction calls once, over the span being folded. */
export type ConversationSummarizer = (
  spanToSummarize: BaseMessage[],
  focus?: string
) => Promise<string>;

/** Input to {@link compactMessages}. */
export interface CompactMessagesInput {
  /**
   * The conversation as the graph holds it. A system prompt at the head is left where it is and
   * excluded from the fold; the graphs this repo builds keep the system prompt outside
   * `state.messages` altogether, so it is usually absent.
   */
  messages: readonly BaseMessage[];
  /** The one model call the compaction makes, injected so the function itself does no I/O. */
  summarize: ConversationSummarizer;
  /** Trailing messages to keep verbatim; {@link DEFAULT_KEEP_RECENT} when omitted. */
  keepRecent?: number;
  /** An optional instruction from the user about what the summary should concentrate on. */
  focus?: string;
}

/** Whether a message is a summary produced by a previous compaction (ours or LangChain's). */
export function isCompactionSummary(message: BaseMessage): boolean {
  if (!HumanMessage.isInstance(message)) return false;
  const source = message.additional_kwargs?.lc_source;
  return source === COMPACTION_SUMMARY_SOURCE || source === LANGCHAIN_SUMMARY_SOURCE;
}

/**
 * The summary as the graph will hold it: a `HumanMessage`, marked so {@link isCompactionSummary}
 * finds it again. A `HumanMessage` and not a `SystemMessage` because a system message anywhere but
 * first is rejected by the Anthropic converter, and because the summary is conversation content —
 * what the two parties said — rather than an instruction about how to behave.
 */
export function createCompactionSummaryMessage(summaryText: string): HumanMessage {
  return new HumanMessage({
    content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summaryText.trim()}`,
    additional_kwargs: { lc_source: COMPACTION_SUMMARY_SOURCE },
  });
}

/** The ids of the tool calls an AI message issued, or an empty set for any other message. */
function toolCallIdsOf(message: BaseMessage): Set<string> {
  const ids = new Set<string>();
  if (!AIMessage.isInstance(message)) return ids;
  for (const call of message.tool_calls ?? []) {
    if (typeof call.id === 'string' && call.id.length > 0) ids.add(call.id);
  }
  return ids;
}

/** How many leading `SystemMessage`s the list opens with — the system prompt, when it is in-band. */
function leadingSystemCount(messages: readonly BaseMessage[]): number {
  let count = 0;
  while (count < messages.length && SystemMessage.isInstance(messages[count])) count++;
  return count;
}

/**
 * The index of the `AIMessage` a tool result at `resultIndex` answers: the NEAREST earlier message
 * that issued its `tool_call_id`, or `-1` for an orphan.
 *
 * Nearest, not earliest, because ids are not unique in every history: a replayed fixture and more
 * than one provider reuse short ids (`call_0`) turn after turn. A result answers the most recent
 * call with its id; pairing it with the first one ever issued would widen the tail back to the
 * head of the conversation and fold nothing.
 */
function issuerOf(conversation: readonly BaseMessage[], resultIndex: number, id: string): number {
  for (let j = resultIndex - 1; j >= 0; j--) {
    if (toolCallIdsOf(conversation[j]).has(id)) return j;
  }
  return -1;
}

/**
 * Widen a proposed tail start backwards until no tool pair straddles it: for every `ToolMessage`
 * at or after `start`, the `AIMessage` that issued its `tool_call_id` ({@link issuerOf}) must be at
 * or after `start` too. Repeats until stable, because moving the start back can bring another
 * answered call into the tail.
 */
function widenTailToPairStart(conversation: readonly BaseMessage[], start: number): number {
  let tailStart = start;
  for (;;) {
    let widenedTo = tailStart;
    for (let i = tailStart; i < conversation.length; i++) {
      const message = conversation[i];
      if (!ToolMessage.isInstance(message) || !message.tool_call_id) continue;
      const issuer = issuerOf(conversation, i, message.tool_call_id);
      if (issuer !== -1 && issuer < widenedTo) widenedTo = issuer;
    }
    if (widenedTo === tailStart) return tailStart;
    tailStart = widenedTo;
  }
}

/**
 * **The cut rule.** Returns the index in `messages` where the kept tail begins, or `null` when
 * there is nothing to fold.
 *
 * The tail is the last `keepRecent` messages, widened backwards so no `tool_call` is separated from
 * its `tool_result` ({@link widenTailToPairStart}). A system prompt at the head is never part of
 * either side. A previous summary sits at the head of the conversation and is always in the folded
 * span, never in the tail — and when it would be the ONLY thing folded, nothing is folded: rewriting
 * a summary with no new material behind it is the thrash invariant (d) forbids.
 */
export function compactionCutIndex(
  messages: readonly BaseMessage[],
  keepRecent: number = DEFAULT_KEEP_RECENT
): number | null {
  const keep = Math.max(1, Math.floor(keepRecent));
  const systemEnd = leadingSystemCount(messages);
  const conversation = messages.slice(systemEnd);
  if (conversation.length <= keep) return null;
  const tailStart = widenTailToPairStart(conversation, conversation.length - keep);
  if (tailStart <= 0) return null;
  if (tailStart === 1 && isCompactionSummary(conversation[0])) return null;
  return systemEnd + tailStart;
}

/**
 * Fold the older part of `messages` into one summary message. See the module doc for the four
 * invariants this holds and the tests that pin them.
 *
 * `summarize` is called exactly once, over the folded span (a previous summary included, so its
 * content is carried forward rather than lost), and its failure propagates: a compaction that
 * cannot get a summary leaves the conversation alone and says so, rather than replacing history
 * with an error string.
 */
export async function compactMessages(input: CompactMessagesInput): Promise<CompactMessagesResult> {
  const messages = [...input.messages];
  const unchanged: CompactMessagesResult = {
    messages,
    summaryText: '',
    removedCount: 0,
    keptCount: messages.length,
    changed: false,
  };
  const cut = compactionCutIndex(messages, input.keepRecent);
  if (cut === null) return unchanged;

  const systemEnd = leadingSystemCount(messages);
  const folded = messages.slice(systemEnd, cut);
  const kept = messages.slice(cut);
  const summaryText = (await input.summarize(folded, input.focus)).trim();
  if (summaryText.length === 0) {
    throw new Error('The model returned an empty summary, so the conversation was left unchanged.');
  }
  return {
    messages: [
      ...messages.slice(0, systemEnd),
      createCompactionSummaryMessage(summaryText),
      ...kept,
    ],
    summaryText,
    removedCount: folded.length,
    keptCount: kept.length,
    changed: true,
  };
}

/**
 * The prompt the summariser sends, in the shape of LangChain's `summarizationMiddleware` prompt
 * (role, objective, instructions, then the rendered messages) so the two mechanisms ask the model
 * for the same kind of artifact. The `focus` block is the one addition: the user's own steer on
 * what the summary should keep, appended when `/compact` was given free text.
 */
export function buildCompactionPrompt(span: readonly BaseMessage[], focus?: string): string {
  const focusBlock =
    focus && focus.trim().length > 0
      ? `\n<focus>\nThe user asked that the summary pay particular attention to: ${focus.trim()}\n</focus>\n`
      : '';
  return `<role>
Context Extraction Assistant
</role>

<primary_objective>
Your sole objective in this task is to extract the highest quality, most relevant context from the conversation history below.
</primary_objective>

<objective_information>
The conversation history below is about to be replaced by the context you extract, so that the conversation can continue with room to spare. Because of this, ensure the context you extract is the most important information to the overall goal: what was asked, what was decided, what was done, what was found, and what remains open.
</objective_information>

<instructions>
Extract and record all of the most important context from the conversation history. Do not repeat actions that were already completed; record their outcomes instead. Keep file paths, identifiers, commands, numbers and error messages exact. If the history opens with an earlier summary, fold it into yours rather than repeating it separately.
Respond ONLY with the extracted context. Do not include any additional information, or text before or after the extracted context.
</instructions>
${focusBlock}
<messages>
Messages to summarize:
${getBufferString(span as BaseMessage[])}
</messages>`;
}

/** The narrowest thing a summariser needs from a chat model: `invoke(prompt)` returning a message. */
export interface SummarizingModel {
  invoke(input: string): Promise<{ content: unknown }>;
}

/** The text of a model reply, whether it came back as a string or as content blocks. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (
        block &&
        typeof block === 'object' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text;
      }
      return '';
    })
    .join('');
}

/**
 * A {@link ConversationSummarizer} bound to a chat model: renders the span with
 * {@link buildCompactionPrompt} and returns the reply's text. The session model is what the runner
 * binds; a caller with a cheaper model for summaries binds that instead.
 */
export function createModelSummarizer(model: SummarizingModel): ConversationSummarizer {
  return async (span, focus) =>
    contentText((await model.invoke(buildCompactionPrompt(span, focus))).content);
}

/** A message-count and character-based size of a conversation — an estimate, never tokens. */
export interface ConversationSize {
  messages: number;
  characters: number;
}

/** The characters of one message as a model would read them: its text, its tool calls, its result. */
function messageCharacters(message: BaseMessage): number {
  let total = contentText(message.content).length;
  if (AIMessage.isInstance(message)) {
    for (const call of message.tool_calls ?? []) {
      total += call.name.length;
      try {
        total += JSON.stringify(call.args ?? {}).length;
      } catch {
        /* an argument that cannot be serialised contributes only its name */
      }
    }
  }
  return total;
}

/**
 * The size of a conversation as a message count and a character estimate. Characters, not tokens,
 * on purpose: precise token accounting belongs with the threshold that needs it (EXT-161), and a
 * before/after comparison only has to agree with itself.
 */
export function conversationSize(messages: readonly BaseMessage[]): ConversationSize {
  let characters = 0;
  for (const message of messages) characters += messageCharacters(message);
  return { messages: messages.length, characters };
}

/** The structural surface of a compiled LangGraph graph that a replacement needs. */
export interface MessagesGraph {
  updateState(
    config: RunnableConfig,
    values: { messages: BaseMessage[] },
    asNode?: string
  ): Promise<unknown>;
}

/**
 * Replace a thread's whole message list with `messages`, through the graph's own `updateState`.
 *
 * The write is `RemoveMessage(REMOVE_ALL_MESSAGES)` followed by the replacement, which the
 * `messagesStateReducer` behind `state.messages` turns into "discard everything, keep what
 * follows". Going through `updateState` is what makes a compaction durable for free: the graph
 * writes a new checkpoint, so the next turn and a later resume both load the compacted history.
 */
export async function replaceGraphMessages(
  graph: MessagesGraph,
  runConfig: RunnableConfig,
  messages: readonly BaseMessage[]
): Promise<void> {
  await graph.updateState(runConfig, {
    messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...messages],
  });
}

/** What `GthAgentRunner.compactConversation` reports about the compaction it applied. */
export interface ConversationCompaction {
  /** Whether anything was folded. When false, nothing was written and `after` equals `before`. */
  changed: boolean;
  /** Messages folded into the summary. */
  removedCount: number;
  /** Messages kept verbatim after the summary (the whole conversation when nothing changed). */
  keptCount: number;
  /** The tail length that was asked for; the kept count can be wider (a tool pair was protected). */
  keepRecent: number;
  /** The summary the model produced, or `''` when nothing changed. */
  summaryText: string;
  /** The conversation's size before the compaction. */
  before: ConversationSize;
  /** The conversation's size as the graph holds it afterwards, read back rather than computed. */
  after: ConversationSize;
}

/** Options for `GthAgentRunner.compactConversation`. */
export interface CompactConversationOptions {
  /** Free text after `/compact`: what the summary should concentrate on. */
  focus?: string;
  /** Trailing messages to keep verbatim; {@link DEFAULT_KEEP_RECENT} when omitted. */
  keepRecent?: number;
}
