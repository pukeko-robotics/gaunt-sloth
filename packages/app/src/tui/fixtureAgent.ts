import { readFileSync } from 'node:fs';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import {
  compactMessages,
  conversationSize,
  type ConversationCompaction,
  DEFAULT_KEEP_RECENT,
} from '@gaunt-sloth/core/core/compaction.js';
import type { TuiAgent } from '#src/tui/types.js';

/** One scripted turn: a sequence of events replayed with `delayMs` spacing. */
interface FixtureTurn {
  events: AgentStreamEvent[];
  /** Per-event delay (ms) so streaming is observable / interruptible. */
  delayMs?: number;
}

interface Fixture {
  turns: FixtureTurn[];
  /** Fallback per-event delay when a turn omits its own. */
  defaultDelayMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GS2-23 — the messages one replayed turn would have left in a real graph: the user's line, an
 * AI message per tool call it announced, the tool's result, and the streamed text as the closing
 * AI message. Built from the events as they are yielded, so the fixture's conversation grows the
 * way a real one does and `/compact` has a real list to fold.
 */
function messagesOfTurn(userInput: string, events: readonly AgentStreamEvent[]): BaseMessage[] {
  const messages: BaseMessage[] = [new HumanMessage(userInput)];
  const argsById = new Map<string, string>();
  const nameById = new Map<string, string>();
  let text = '';
  for (const event of events) {
    if (event.type === 'tool_start') {
      nameById.set(event.id, event.name);
      argsById.set(event.id, '');
    } else if (event.type === 'tool_args') {
      argsById.set(event.id, (argsById.get(event.id) ?? '') + event.delta);
    } else if (event.type === 'tool_end') {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsById.get(event.id) || '{}') as Record<string, unknown>;
      } catch {
        /* a partial fixture argument is still a tool call */
      }
      messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: event.id, name: nameById.get(event.id) ?? 'tool', args }],
        })
      );
    } else if (event.type === 'tool_result') {
      messages.push(new ToolMessage({ tool_call_id: event.id, content: event.content }));
    } else if (event.type === 'text') {
      text += event.delta;
    }
  }
  messages.push(new AIMessage(text));
  return messages;
}

/**
 * Test-only deterministic agent. Replays recorded {@link AgentStreamEvent}s from a JSON
 * fixture instead of calling a model, so the PTY e2e (Stage D) drives the *real* TUI — the
 * `<App>` component, the `foldEvents` reducer, and Ink's renderer — with hermetic, key-free,
 * fully reproducible output. Selected by {@link import('#src/tui/tuiSessionModule.js')}'s
 * `createTuiSession` only when `GTH_TUI_E2E_FIXTURE` points at a fixture file; the production
 * path never loads this module.
 *
 * Turns are consumed in order (the last turn repeats if the user submits more prompts than
 * the fixture scripts). The replay honours the abort signal — Esc throws mid-stream, mirroring
 * the way the real `streamWithEvents` path surfaces a cancelled run.
 *
 * GS2-23 — it also keeps the conversation those turns would have left in a graph, and
 * `compactConversation` runs the REAL `compactMessages` over it with a canned summary in place of
 * the model call. The PTY `/compact` case therefore exercises the real cut rule and the real
 * notice wiring; only the summary text is scripted.
 */
export function createFixtureTuiAgent(fixturePath: string): TuiAgent {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const turns = fixture.turns ?? [];
  let index = 0;
  let conversation: BaseMessage[] = [];

  return {
    async *runTurn(userInput: string, signal: AbortSignal): AsyncGenerator<AgentStreamEvent> {
      const turn = turns.length > 0 ? turns[Math.min(index, turns.length - 1)] : { events: [] };
      index += 1;
      const gap = turn.delayMs ?? fixture.defaultDelayMs ?? 10;
      const replayed: AgentStreamEvent[] = [];
      for (const event of turn.events) {
        if (signal.aborted) throw new Error('Interrupted');
        await delay(gap);
        if (signal.aborted) throw new Error('Interrupted');
        replayed.push(event);
        yield event;
      }
      conversation = [...conversation, ...messagesOfTurn(userInput, replayed)];
    },
    async compactConversation(input): Promise<ConversationCompaction> {
      const before = conversationSize(conversation);
      const result = await compactMessages({
        messages: conversation,
        summarize: async () => 'The earlier turns read a README and greeted the user.',
        keepRecent: DEFAULT_KEEP_RECENT,
        ...(input.focus !== undefined ? { focus: input.focus } : {}),
      });
      if (result.changed) conversation = result.messages;
      return {
        changed: result.changed,
        removedCount: result.removedCount,
        keptCount: result.keptCount,
        keepRecent: DEFAULT_KEEP_RECENT,
        summaryText: result.summaryText,
        before,
        after: conversationSize(conversation),
      };
    },
  };
}
