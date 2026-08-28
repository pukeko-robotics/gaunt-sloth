import type { AgentStreamEvent, PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';
import { neutralizeUntrustedText } from '@gaunt-sloth/core/core/shell/framing.js';
import type { TranscriptItem } from '#src/tui/types.js';

/**
 * Pure view-model layer for the Ink TUI.
 *
 * The TUI is a second consumer of {@link AgentStreamEvent} (the same typed event
 * contract the AG-UI SSE encoder renders); it must NOT be wired through `consoleUtils`.
 * `foldEvents` is the single source of truth for turning a stream of agent events into a
 * renderable shape, kept deliberately free of React/Ink so it is unit-testable in
 * isolation (see spec). The Ink component layer folds events into this model via React
 * state and renders it; nothing about rendering leaks into here.
 */

/** A single tool call within the live assistant turn, keyed by the stream's tool id. */
export interface ToolCallViewModel {
  id: string;
  /** Tool name from `tool_start`; '' if a later event referenced an unseen id first. */
  name: string;
  /** Accumulated `tool_args` deltas (raw JSON text as streamed). */
  argsText: string;
  status: 'running' | 'done';
  /**
   * TUI-C17 — accumulated LIVE output streamed while the tool executed (`tool_output` events:
   * verbatim child stdout/stderr chunks, in arrival order). Distinct from `result` (the final
   * model-facing tool result): this is what the child printed as it ran. Living here (React
   * state, not ephemeral stdout) is what makes it survive re-renders; TUI-C30 consumes it for
   * the per-tool output preview.
   */
  output?: string;
  /**
   * TUI-C30 — the "🔧 Executing …" announcement (`tool_output` events with `isNotice`), kept
   * SEPARATE from `output` so the raw-output preview never counts the notice as an output line
   * and the expanded panel can style it as chrome rather than child output.
   */
  notice?: string;
  /** Present once a `tool_result` arrives. */
  result?: string;
  /**
   * True when the `tool_result` event reported `isError` (the real LangChain
   * `ToolMessage.status === 'error'` signal). Undefined means success; the renderer drives
   * the ✗/error glyph from this, never from sniffing the result text.
   */
  isError?: boolean;
  /**
   * [[TUI-C69]] §5.4 — true when the `tool_result` event reported `raterClarification`: the gate
   * refused this call back to the AGENT as a negotiation round, so the row is warn-toned and
   * labelled a clarification request rather than drawn in the failed-tool vocabulary.
   *
   * Additive to {@link isError}, which stays true beside it and still says the call did not run.
   */
  raterClarification?: boolean;
  /**
   * [[TUI-C99]] — the human's answer at the approval gate, held ON the call it was about.
   *
   * A decision belongs to a call, not to a turn, and that is what this field is for. Held instead
   * as a transcript item pushed when the question is asked — the shape this replaces — it landed
   * above every tool row of the turn it interrupted, because the viewport draws the whole committed
   * list before the in-flight turn; and it could not be moved, because the two live in different
   * regions of the tree and one region is unconditionally above the other. Attached here it has no
   * wall to sit above, and it cannot drift as the turn grows.
   *
   * **It never reaches the model.** {@link turnText} concatenates `text` segments alone, so nothing
   * hung off a tool call can enter the conversation history — which is the property that made this
   * shape available at all.
   */
  approval?: ToolApprovalViewModel;
}

/** [[TUI-C99]] — which way a human answered at the approval gate. */
export type ApprovalDecisionKind = 'approved' | 'rejected';

/**
 * [[TUI-C99]] — one answered approval, as the tool row draws it.
 *
 * **The decision and nothing else, deliberately: no lifetime, no scope.** [[EXT-150]]'s rule is
 * *one notice, once, when it is known*, and a scope is not known at the keystroke — `always`
 * degrades to `session` whenever the write did not reach disk, and the runner decides that after
 * the answer has been handed back. A line written from the key pressed would therefore be a claim
 * that is sometimes corrected afterwards, which is the defect EXT-150 exists to prevent. The
 * lifetimes stay in the decision notices, which are committed from what LANDED.
 *
 * The `request` is the whole interrupt, so the Ctrl+T expansion can paint the same rows the dialog
 * showed rather than a summary of them — [[EXT-137]] put the untrusted halves in the conversation
 * so a reader could audit what a model or a third-party server claimed, and Ctrl+T is now the route
 * to that.
 */
export interface ToolApprovalViewModel {
  decision: ApprovalDecisionKind;
  /** The interrupt the human was answering, kept whole for the Ctrl+T expansion. */
  request: PendingToolInterrupt;
}

/** The hint the collapsed outcome line carries, naming the affordance that opens the detail. */
export const APPROVAL_OUTCOME_EXPAND_HINT = '  (Ctrl+T for the request)';

/**
 * [[TUI-C99]] — the one line a tool row draws under itself once its approval has been answered.
 *
 * Lives here, beside {@link displaySegments}, and for the same reason: `<LiveTurn>` paints it and
 * `transcriptWindow`'s row oracle counts it, and an oracle holding its own copy of a rendered
 * string drifts from the renderer silently — an under-count shows as conversation quietly going
 * missing rather than as an error. One builder is what makes that impossible rather than unlikely.
 *
 * The hint is on the COLLAPSED line only, because expanded is where the request already is. That
 * asymmetry changes the line's width between fold states, which is precisely why both sides ask
 * this function instead of measuring a string they wrote themselves.
 *
 * Note it does NOT also gate on the turn still being live, though the `(Ctrl+T to expand)` hints on
 * the tool row above it do. Those advertise a detail that is interesting while a call is running;
 * this one advertises the only route to what the human was actually shown when they approved. A
 * reader auditing a decision is by definition doing it afterwards, on a committed turn, so hiding
 * the affordance once the turn ends would retire it exactly when it starts being needed.
 */
export function approvalOutcomeLine(approval: ToolApprovalViewModel, expanded: boolean): string {
  const decision = approval.decision === 'approved' ? 'approved by you' : 'rejected by you';
  return `↳ ${decision}${expanded ? '' : APPROVAL_OUTCOME_EXPAND_HINT}`;
}

/**
 * [[TUI-C99]] — attach a human's answer to the tool call it was about.
 *
 * Returns the turn **unchanged, by reference**, when the answer cannot be attributed: an interrupt
 * with no `id` (the recovery in `getPendingToolInterrupts` is defensive at every step and yields
 * one) or an id no segment in this turn carries. `PendingToolInterrupt.id` is a display attribution
 * and is documented as absent-able, so the caller has to have somewhere else to put the decision —
 * and an identity comparison is how it finds out, rather than by guessing at which call was meant.
 * Pinning an unattributable answer to "the last running call" is the mis-attribution `foldEvents`
 * already refuses for id-less tool output, and it would be worse here: it would report a human's
 * decision against a command they were not asked about.
 */
export function recordApprovalDecision(
  turn: TurnViewModel,
  toolCallId: string | undefined,
  approval: ToolApprovalViewModel
): TurnViewModel {
  if (!toolCallId) return turn;
  const idx = turn.segments.findIndex(
    (segment) => segment.kind === 'tool' && segment.tool.id === toolCallId
  );
  if (idx === -1) return turn;
  const segments = turn.segments.slice();
  segments[idx] = { kind: 'tool', tool: { ...(segments[idx] as ToolSegment).tool, approval } };
  return { ...turn, segments };
}

/** One run of assistant text, uninterrupted by a tool call or a run of reasoning. */
export interface TextSegment {
  kind: 'text';
  /** The `text` deltas that arrived while this run was open, concatenated. */
  text: string;
}

/** One run of the model's reasoning, uninterrupted by assistant text or a tool call. */
export interface ReasoningSegment {
  kind: 'reasoning';
  /** The `reasoning_delta` deltas that arrived while this run was open, concatenated. */
  text: string;
}

/** One tool call, held at the point in the turn where the stream first mentioned it. */
export interface ToolSegment {
  kind: 'tool';
  tool: ToolCallViewModel;
}

/**
 * One renderable piece of a turn, in arrival order.
 *
 * The tool call is nested rather than referenced by id on purpose: order and content then have a
 * single home, so there is no second list that can disagree with this one about which tool calls
 * a turn made or where they sit. {@link turnToolCalls}, {@link turnText} and
 * {@link turnReasoning} derive the flat views the rest of the app used to read off separate
 * fields.
 */
export type TurnSegment = TextSegment | ReasoningSegment | ToolSegment;

/** The two segment kinds that are a run of accumulating characters rather than an event. */
type RunKind = TextSegment['kind'] | ReasoningSegment['kind'];

/** Build a run segment with its discriminant narrowed, so no cast is needed at the call sites. */
const run = (kind: RunKind, text: string): TextSegment | ReasoningSegment =>
  kind === 'text' ? { kind, text } : { kind, text };

/**
 * The renderable state of a single in-progress assistant turn.
 *
 * `segments` is the whole point: a turn that ran text → tool → text → tool is FOUR entries in that
 * order. Held instead as a `text` string beside a `toolCalls` array — the shape this replaces —
 * there was nowhere to record that a text run arrived BETWEEN two calls, so a completed turn could
 * only ever be drawn as every tool followed by all of the text. That is not a rendering choice; it
 * is what two parallel fields can represent.
 */
export interface TurnViewModel {
  /**
   * Reasoning runs, text runs and tool calls interleaved exactly as the stream delivered them.
   *
   * Reasoning is IN this list rather than beside it for the same reason text is: a model that
   * thinks, acts, then thinks again produces two thoughts at two different points in the turn, and
   * a `reasoning: string` field can only ever describe one of them, drawn wherever the renderer
   * chose to put the panel — in practice above the whole turn, so the thought that led to the last
   * tool call sat above the first.
   */
  segments: TurnSegment[];
  /** True between `reasoning_start` and `reasoning_end`. */
  isReasoning: boolean;
}

export const initialTurnViewModel = (): TurnViewModel => ({
  segments: [],
  isReasoning: false,
});

/** Every tool call the turn made, in first-seen order — derived, never stored. */
export function turnToolCalls(turn: TurnViewModel): ToolCallViewModel[] {
  const out: ToolCallViewModel[] = [];
  for (const segment of turn.segments) if (segment.kind === 'tool') out.push(segment.tool);
  return out;
}

/**
 * Every assistant `text` delta of the turn, concatenated — derived, never stored.
 *
 * The runs join with no separator, so this is byte-for-byte the string the deltas built: splitting
 * them into segments changes where they are DRAWN, not what was said.
 */
export function turnText(turn: TurnViewModel): string {
  let out = '';
  for (const segment of turn.segments) if (segment.kind === 'text') out += segment.text;
  return out;
}

/**
 * Every run of the turn's reasoning, joined for a consumer that wants the whole thought — derived,
 * never stored. `/reasoning` reprints a committed turn through this.
 *
 * The runs join with a **blank line**, unlike {@link turnText}, and the difference is deliberate.
 * Text must come back byte for byte because it is what the model said and history keeps it;
 * reasoning is being reassembled for a person to read out of two thoughts the model had at
 * different points of the turn, either side of an action. Joined with no separator they run
 * together into one paragraph mid-sentence, which is the shape this node exists to stop.
 */
export function turnReasoning(turn: TurnViewModel): string {
  const runs: string[] = [];
  for (const segment of turn.segments) if (segment.kind === 'reasoning') runs.push(segment.text);
  return runs.join('\n\n');
}

/**
 * Append a text or reasoning delta: extend the run that is still open, or start a new one when
 * something else closed the last one. That branch IS the fix — concatenating unconditionally is
 * what put every character of a turn's prose below every one of its tool panels, and what put
 * every thought above them.
 *
 * **A run is closed by the next segment, not by the stream's own `reasoning_end`.** The agent
 * stream only closes a reasoning block when answer TEXT arrives (`GthAbstractAgent.emitSegments`),
 * so a think → tool → think turn never sees one, and a rule keyed on `reasoning_end` would merge
 * those two thoughts back into a single panel above the call that separates them. Keying on what
 * has since been appended is what makes the boundary hold for every ordering the stream produces.
 */
function appendRun(segments: TurnSegment[], kind: RunKind, delta: string): TurnSegment[] {
  if (delta === '') return segments;
  const last = segments[segments.length - 1];
  // The `!== 'tool'` test is what narrows `last` to a run, so `last.text` needs no cast.
  if (last && last.kind !== 'tool' && last.kind === kind) {
    const next = segments.slice();
    next[next.length - 1] = run(kind, last.text + delta);
    return next;
  }
  return [...segments, run(kind, delta)];
}

/**
 * Upsert a tool call by id, applying `patch` to its segment IN PLACE. If the id is unknown a
 * placeholder segment is appended (name '') so a stray `tool_args`/`tool_end`/`tool_result` is
 * never silently dropped — robustness mirrors the AG-UI encoder's defensive posture toward local
 * models, and the placeholder path is the common one because `tool_output` normally precedes
 * `tool_start`.
 *
 * Patching in place is load-bearing: a call's later events routinely arrive after the next text
 * run has started, and appending a second segment for them would re-order the very thing this
 * model exists to keep in order.
 */
function upsertTool(
  segments: TurnSegment[],
  id: string,
  patch: (tc: ToolCallViewModel) => ToolCallViewModel
): TurnSegment[] {
  const idx = segments.findIndex((segment) => segment.kind === 'tool' && segment.tool.id === id);
  if (idx === -1) {
    const created: ToolCallViewModel = { id, name: '', argsText: '', status: 'running' };
    return [...segments, { kind: 'tool', tool: patch(created) }];
  }
  const next = segments.slice();
  next[idx] = { kind: 'tool', tool: patch((next[idx] as ToolSegment).tool) };
  return next;
}

/**
 * Reduce one {@link AgentStreamEvent} into the turn view-model. Pure and immutable:
 * always returns a new object on change so React can rely on reference equality.
 */
export function foldEvents(state: TurnViewModel, event: AgentStreamEvent): TurnViewModel {
  switch (event.type) {
    case 'text': {
      const segments = appendRun(state.segments, 'text', event.delta);
      return segments === state.segments ? state : { ...state, segments };
    }
    case 'reasoning_start':
      return { ...state, isReasoning: true };
    case 'reasoning_delta': {
      // No `reasoning_start` is required first: a provider that streams a thought without opening
      // one still gets a run, mirroring `upsertTool`'s placeholder posture toward local models.
      const segments = appendRun(state.segments, 'reasoning', event.delta);
      return segments === state.segments ? state : { ...state, segments };
    }
    case 'reasoning_end':
      return { ...state, isReasoning: false };
    case 'tool_start':
      return {
        ...state,
        segments: upsertTool(state.segments, event.id, (tc) => ({
          ...tc,
          name: event.name,
          status: 'running',
        })),
      };
    case 'tool_args':
      return {
        ...state,
        segments: upsertTool(state.segments, event.id, (tc) => ({
          ...tc,
          argsText: tc.argsText + event.delta,
        })),
      };
    case 'tool_end':
      return {
        ...state,
        segments: upsertTool(state.segments, event.id, (tc) => ({
          ...tc,
          status: 'done',
        })),
      };
    case 'tool_result':
      return {
        ...state,
        segments: upsertTool(state.segments, event.id, (tc) => ({
          ...tc,
          status: 'done',
          result: event.content,
          isError: event.isError,
          raterClarification: event.raterClarification,
        })),
      };
    case 'tool_output': {
      // TUI-C17 — live output streamed while the tool executes. Chunks normally arrive BEFORE the
      // call's `tool_start` (the agent stream only flushes tool_start when the round's ToolMessage
      // lands), so upsertTool's placeholder path is the common case: seed the name from the event
      // so the panel is labelled while running.
      // Without an id (defensive: the invoking framework supplied no tool call), attribute to a
      // synthetic per-name bucket (`${name}#live`), NOT to a running same-name call. TUI-C31 (e):
      // pinning an id-less chunk to "the latest running same-name call" could MIS-attribute output
      // across concurrent same-name calls (two parallel run_shell_command runs), silently splicing
      // one call's output into another's panel. LangGraph always supplies the id today, so this is
      // a defensive path — and the safe defensive choice is to mark the chunk (a clearly-synthetic
      // bucket) rather than pin it to a possibly-wrong real call. Output is still never dropped.
      // TUI-C30 — notices accumulate on the SEPARATE `notice` field (newline-joined; they carry
      // no trailing newline of their own) so the output preview counts only real child output.
      const id = event.id ?? `${event.name}#live`;
      return {
        ...state,
        segments: upsertTool(state.segments, id, (tc) => ({
          ...tc,
          name: tc.name || event.name,
          ...(event.isNotice
            ? { notice: tc.notice ? `${tc.notice}\n${event.chunk}` : event.chunk }
            : { output: (tc.output ?? '') + event.chunk }),
        })),
      };
    }
    default: {
      // Exhaustiveness guard: a new AgentStreamEvent variant fails the build here.
      const _never: never = event;
      return state ?? _never;
    }
  }
}

/** Fold an entire sequence (handy for tests and replay). */
export function foldEventSequence(
  events: AgentStreamEvent[],
  state: TurnViewModel = initialTurnViewModel()
): TurnViewModel {
  return events.reduce(foldEvents, state);
}

/* ------------------------------------------------------------------------- *
 * Subagent tree (the `task` tool)                                            *
 * ------------------------------------------------------------------------- *
 * A subagent is spawned through a single tool named `task`, whose call
 * arguments carry `{ subagent_type, description }`. We fold those task tool-call
 * events (already present in the AgentStreamEvent stream) into a flat list of
 * subagent nodes for the debug panel. This is pure view-model work over events
 * the TUI already receives — no new event types, no streaming-core changes.
 *
 * No agent backend emits a `task` call in this release, so nothing reaches this
 * fold today; it is kept for the lean subagent primitive (GS2-25).            */

/**
 * The tool name a subagent is dispatched by. Dormant like the fold below: the `task` tool went with
 * the deepagents runtime (EXT-114) and nothing emits one until GS2-25 lands the lean subagent
 * primitive. The guard in {@link foldSubagentEvents} still reads it on every event, so this is live
 * code awaiting a producer, not an unused constant.
 */
export const SUBAGENT_TOOL_NAME = 'task';

/** A single subagent invocation, derived from one `task` tool call. */
export interface SubagentNode {
  /** The originating tool-call id (stable key). */
  id: string;
  /** `subagent_type` from the task args, or 'subagent' until parseable. */
  type: string;
  /** `description` from the task args (the prompt handed to the subagent). */
  description: string;
  status: 'running' | 'done';
  /** The subagent's returned result text, once `tool_result` arrives. */
  result?: string;
}

/** The renderable subagent tree: subagents in first-spawned order. */
export interface SubagentTreeViewModel {
  nodes: SubagentNode[];
}

export const initialSubagentTree = (): SubagentTreeViewModel => ({ nodes: [] });

/**
 * Best-effort parse of the (possibly partial) streamed `task` args JSON into the
 * fields we care about. Mirrors the defensive posture elsewhere: a half-streamed
 * or malformed buffer never throws — we just keep whatever we already had.
 */
function parseTaskArgs(argsText: string): { type?: string; description?: string } {
  if (!argsText.trim()) return {};
  try {
    const parsed = JSON.parse(argsText) as Record<string, unknown>;
    const type = typeof parsed.subagent_type === 'string' ? parsed.subagent_type : undefined;
    const description = typeof parsed.description === 'string' ? parsed.description : undefined;
    return { type, description };
  } catch {
    return {};
  }
}

function upsertSubagent(
  nodes: SubagentNode[],
  id: string,
  patch: (n: SubagentNode) => SubagentNode
): SubagentNode[] {
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx === -1) {
    const created: SubagentNode = { id, type: 'subagent', description: '', status: 'running' };
    return [...nodes, patch(created)];
  }
  const next = nodes.slice();
  next[idx] = patch(next[idx]);
  return next;
}

/**
 * Fold one {@link AgentStreamEvent} into the subagent tree. Only `task` tool calls
 * are tracked; every other event passes through untouched (so the same stream can
 * be folded into both the turn view-model and this tree independently). Because
 * `tool_args` for `task` are streamed as JSON deltas, we accumulate the raw text on
 * the node and re-parse on each delta so `type`/`description` fill in as soon as the
 * buffer is valid JSON — without ever dropping a stray/out-of-order event.
 */
export function foldSubagentEvents(
  state: SubagentTreeViewModel,
  event: AgentStreamEvent,
  /** Internal: per-id raw args buffers, kept out of the rendered model. */
  argsBuffers: Map<string, string> = new Map()
): SubagentTreeViewModel {
  switch (event.type) {
    case 'tool_start': {
      if (event.name !== SUBAGENT_TOOL_NAME) return state;
      argsBuffers.set(event.id, argsBuffers.get(event.id) ?? '');
      return {
        nodes: upsertSubagent(state.nodes, event.id, (n) => ({ ...n, status: 'running' })),
      };
    }
    case 'tool_args': {
      if (!argsBuffers.has(event.id)) return state; // not a task call we are tracking
      const buf = (argsBuffers.get(event.id) ?? '') + event.delta;
      argsBuffers.set(event.id, buf);
      const { type, description } = parseTaskArgs(buf);
      return {
        nodes: upsertSubagent(state.nodes, event.id, (n) => ({
          ...n,
          type: type ?? n.type,
          description: description ?? n.description,
        })),
      };
    }
    case 'tool_end': {
      if (!argsBuffers.has(event.id)) return state;
      return {
        nodes: upsertSubagent(state.nodes, event.id, (n) => ({ ...n, status: 'done' })),
      };
    }
    case 'tool_result': {
      if (!argsBuffers.has(event.id)) return state;
      return {
        nodes: upsertSubagent(state.nodes, event.id, (n) => ({
          ...n,
          status: 'done',
          result: event.content,
        })),
      };
    }
    default:
      return state;
  }
}

/**
 * Fold a whole event sequence into a subagent tree. Allocates a fresh args-buffer
 * map per call so the reducer stays referentially honest for tests and replay.
 */
export function foldSubagentTree(
  events: AgentStreamEvent[],
  state: SubagentTreeViewModel = initialSubagentTree()
): SubagentTreeViewModel {
  const buffers = new Map<string, string>();
  return events.reduce((acc, ev) => foldSubagentEvents(acc, ev, buffers), state);
}

/* ------------------------------------------------------------------------- *
 * Checklist tool (`gth_checklist`)                                           *
 * ------------------------------------------------------------------------- *
 * The lean agent's planning tool takes `{ items: [{ content, status }] }`. When the TUI sees a
 * tool call for this name it renders the streamed args as a live checkbox panel instead of a
 * generic tool card. The name is kept as a local literal (like SUBAGENT_TOOL_NAME) so the TUI
 * stays decoupled from the agent package.                                                       */

/** The tool name the lean agent uses to record its checklist. Matches `gthChecklistTool.ts`. */
export const CHECKLIST_TOOL_NAME = 'gth_checklist';

/* ------------------------------------------------------------------------- *
 * What a turn DRAWS                                                          *
 * ------------------------------------------------------------------------- */

/**
 * True for a segment the turn records but paints NOTHING for.
 *
 * Today that is the checklist tool alone: it is recorded because the turn's segment list is the
 * record of what happened (and {@link extractActiveChecklist} reads it), but it renders as the
 * pinned dock panel rather than anywhere inside the turn. An UNNAMED tool call — `upsertTool`'s
 * placeholder, created by whichever event mentions an id first — does draw: it paints a running
 * panel under a placeholder label until its name arrives.
 */
function drawsNothing(segment: TurnSegment): boolean {
  if (segment.kind !== 'tool') return segment.text === '';
  return segment.tool.name === CHECKLIST_TOOL_NAME;
}

/**
 * The segments a turn actually DRAWS, in order — with same-kind runs re-joined across anything
 * that paints nothing between them.
 *
 * Recording arrival order and drawing it are different jobs, and this is where they separate.
 * {@link TurnViewModel.segments} stays a truthful record; this is what the reader sees. A text run
 * is split by a tool call because the action happened between the two halves and the reader can
 * see it there — a rationale that does not survive the call painting nothing at all. Left
 * unhandled, a checklist call (which the lean agent makes mid-turn routinely) breaks a streamed
 * paragraph across two rows with no visible cause.
 *
 * The runs re-join with **no separator**, so a re-joined run is byte-for-byte the text the deltas
 * built — which is also what closes a markdown construct that the call fell inside of.
 *
 * **The renderer and the row-count oracle both go through here.** They have to agree about what is
 * on screen — one draws it and the other decides how much of the conversation the viewport mounts
 * — and a divergence between them shows up as content in the wrong place rather than as an error.
 * One definition, two callers, is what makes that structural rather than a convention.
 */
export function displaySegments(turn: TurnViewModel): TurnSegment[] {
  const drawn: TurnSegment[] = [];
  for (const segment of turn.segments) {
    if (drawsNothing(segment)) continue;
    const last = drawn[drawn.length - 1];
    // Two runs of the SAME kind with only invisible segments between them re-join; a text run and
    // a reasoning run never do, because they are different layers of the turn.
    if (segment.kind !== 'tool' && last && last.kind !== 'tool' && last.kind === segment.kind) {
      drawn[drawn.length - 1] = run(segment.kind, last.text + segment.text);
      continue;
    }
    drawn.push(segment);
  }
  return drawn;
}

export type ChecklistItemStatus = 'pending' | 'in_progress' | 'completed';

/** One checklist row parsed from a `gth_checklist` tool call's args. */
export interface ChecklistItemViewModel {
  /**
   * The row's text, **already neutralised and safe to paint verbatim**.
   *
   * This is a model-written string — under prompt injection, attacker-chosen — and the panel it
   * feeds is pinned directly above the input dock, closer to the prompt than anything else on the
   * screen. Painted raw, SGR plus cursor positioning forges something shaped like gsloth's own
   * output right beside a decision the user is about to make, on a panel that is by design glanced
   * at rather than read.
   *
   * The invariant is stated **here, on the type**, and not only inside the parser that establishes
   * it: whoever builds these rows next owes the same treatment, and a renderer is entitled to trust
   * it without repeating the guard.
   */
  content: string;
  status: ChecklistItemStatus;
}

/**
 * Best-effort parse of a (possibly partial) streamed `gth_checklist` args JSON into rows. Mirrors
 * {@link parseTaskArgs}: a half-streamed or malformed buffer never throws — it returns `null` so
 * the renderer keeps showing the last good state (or falls back to the generic tool panel).
 *
 * **Every row's text is neutralised here**, with the same shared helper the tool-display and
 * approval paths use, so control characters and ANSI reach the screen as printable escapes instead
 * of as instructions to the terminal. It sits on the producer rather than at the panel because this
 * is the only place checklist rows are made: a renderer rewritten around a different layout inherits
 * the guard, and there is no second call site for someone to forget. `status` needs no treatment —
 * it is accepted only when it matches one of three literals — and the glyphs and header the panel
 * draws around the text are the renderer's own constants.
 */
export function parseChecklistArgs(argsText: string): ChecklistItemViewModel[] | null {
  if (!argsText.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const rows: ChecklistItemViewModel[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const content = (raw as { content?: unknown }).content;
    const status = (raw as { status?: unknown }).status;
    if (
      typeof content === 'string' &&
      (status === 'pending' || status === 'in_progress' || status === 'completed')
    ) {
      rows.push({ content: neutralizeUntrustedText(content), status });
    }
  }
  return rows.length ? rows : null;
}

/**
 * The newest parseable checklist call in one turn, or `null`.
 *
 * Walks `segments` in reverse directly instead of deriving a tool-call array: the caller re-runs
 * this on every streamed event, so materialising a filtered list per turn per event would put work
 * proportional to the whole transcript on the live path.
 */
function latestChecklistIn(turn: TurnViewModel): ChecklistItemViewModel[] | null {
  for (let i = turn.segments.length - 1; i >= 0; i--) {
    const segment = turn.segments[i];
    if (segment.kind !== 'tool' || segment.tool.name !== CHECKLIST_TOOL_NAME) continue;
    const items = parseChecklistArgs(segment.tool.argsText);
    if (items) return items;
  }
  return null;
}

/**
 * Extract the most recent checklist items from the in-progress live turn or committed transcript.
 * Returns `null` if no valid checklist tool calls exist.
 */
export function extractActiveChecklist(
  live: TurnViewModel | null,
  transcript: TranscriptItem[]
): ChecklistItemViewModel[] | null {
  // First check the live turn's tool calls in reverse order
  if (live) {
    const items = latestChecklistIn(live);
    if (items) return items;
  }

  // Next search transcript items in reverse order
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (item.kind !== 'assistant') continue;
    const items = latestChecklistIn(item.turn);
    if (items) return items;
  }

  return null;
}
