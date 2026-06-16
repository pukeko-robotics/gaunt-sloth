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
  /** Present once a `tool_result` arrives. */
  result?: string;
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
        })),
      };
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
