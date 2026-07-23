import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';

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
}

/** The renderable state of a single in-progress assistant turn. */
export interface TurnViewModel {
  /** Accumulated assistant `text` deltas. */
  text: string;
  /** Accumulated `reasoning_delta` deltas (the dim "thinking" region). */
  reasoning: string;
  /** True between `reasoning_start` and `reasoning_end`. */
  isReasoning: boolean;
  /** Tool calls in first-seen order. */
  toolCalls: ToolCallViewModel[];
}

export const initialTurnViewModel = (): TurnViewModel => ({
  text: '',
  reasoning: '',
  isReasoning: false,
  toolCalls: [],
});

/**
 * Upsert a tool call by id, applying `patch`. If the id is unknown a placeholder is
 * created (name '') so a stray `tool_args`/`tool_end`/`tool_result` is never silently
 * dropped — robustness mirrors the AG-UI encoder's defensive posture toward local models.
 */
function upsertTool(
  toolCalls: ToolCallViewModel[],
  id: string,
  patch: (tc: ToolCallViewModel) => ToolCallViewModel
): ToolCallViewModel[] {
  const idx = toolCalls.findIndex((tc) => tc.id === id);
  if (idx === -1) {
    const created: ToolCallViewModel = { id, name: '', argsText: '', status: 'running' };
    return [...toolCalls, patch(created)];
  }
  const next = toolCalls.slice();
  next[idx] = patch(next[idx]);
  return next;
}

/**
 * Reduce one {@link AgentStreamEvent} into the turn view-model. Pure and immutable:
 * always returns a new object on change so React can rely on reference equality.
 */
export function foldEvents(state: TurnViewModel, event: AgentStreamEvent): TurnViewModel {
  switch (event.type) {
    case 'text':
      return { ...state, text: state.text + event.delta };
    case 'reasoning_start':
      return { ...state, isReasoning: true };
    case 'reasoning_delta':
      return { ...state, reasoning: state.reasoning + event.delta };
    case 'reasoning_end':
      return { ...state, isReasoning: false };
    case 'tool_start':
      return {
        ...state,
        toolCalls: upsertTool(state.toolCalls, event.id, (tc) => ({
          ...tc,
          name: event.name,
          status: 'running',
        })),
      };
    case 'tool_args':
      return {
        ...state,
        toolCalls: upsertTool(state.toolCalls, event.id, (tc) => ({
          ...tc,
          argsText: tc.argsText + event.delta,
        })),
      };
    case 'tool_end':
      return {
        ...state,
        toolCalls: upsertTool(state.toolCalls, event.id, (tc) => ({
          ...tc,
          status: 'done',
        })),
      };
    case 'tool_result':
      return {
        ...state,
        toolCalls: upsertTool(state.toolCalls, event.id, (tc) => ({
          ...tc,
          status: 'done',
          result: event.content,
          isError: event.isError,
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
        toolCalls: upsertTool(state.toolCalls, id, (tc) => ({
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
 * Subagent tree (deepagents `task` tool)                                     *
 * ------------------------------------------------------------------------- *
 * deepagents spawns subagents through a single tool named `task`; each call's
 * arguments carry `{ subagent_type, description }`. We fold those task tool-call
 * events (already present in the AgentStreamEvent stream) into a flat list of
 * subagent nodes for the debug panel. This is pure view-model work over events
 * the TUI already receives — no new event types, no streaming-core changes.    */

/** The tool name deepagents uses to dispatch a subagent. */
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

export type ChecklistItemStatus = 'pending' | 'in_progress' | 'completed';

/** One checklist row parsed from a `gth_checklist` tool call's args. */
export interface ChecklistItemViewModel {
  content: string;
  status: ChecklistItemStatus;
}

/**
 * Best-effort parse of a (possibly partial) streamed `gth_checklist` args JSON into rows. Mirrors
 * {@link parseTaskArgs}: a half-streamed or malformed buffer never throws — it returns `null` so
 * the renderer keeps showing the last good state (or falls back to the generic tool panel).
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
      rows.push({ content, status });
    }
  }
  return rows.length ? rows : null;
}
