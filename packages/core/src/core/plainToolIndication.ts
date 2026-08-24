/**
 * @module plainToolIndication
 * TUI-C30 — compact tool-call indication for the PLAIN surface (`--no-tui` readline sessions,
 * piped/single-shot `ask`/`exec`/`review`/`pr`). The Ink TUI renders tool calls from the typed
 * event stream; the plain surface streams strings, so until now a tool call only surfaced
 * through the tools' own transient notices (`📁 Reading file: …`, `🔧 Executing …` + raw child
 * output via the tool-output channel's default sink). This module watches the SAME LangGraph
 * message stream the string path already iterates and, when each `ToolMessage` lands, prints
 * one compact indication built from the shared {@link toolDisplay} registry:
 *
 *     ✓ 📁 read_file(path=README.md)
 *         # Readme            ← up to the canonical 10 preview lines, dim
 *         … (+42 more lines)
 *
 * Stream discipline (matches how the plain surface prints tool activity today): the block is
 * emitted at INFO level through `displayToolIndication` — same stdout channel, same
 * `consoleLevel` gate and session-log treatment as the existing tool notices — so scripted
 * consumers that already silence INFO chatter silence this too. Colour is used exactly when the
 * resolved `useColour` (the CFG-30 ladder in `config/colour.ts`) says so — TUI-C35 removed the
 * local `&& stdout.isTTY` narrowing this module used to apply on top, which was redundant against
 * the ladder's own rung-4 TTY auto-detection everywhere except `FORCE_COLOR` on a pipe, the one
 * case that variable exists to serve. An ordinary piped run is therefore still clean monochrome
 * (DL-7) — rung 4 decides that — with diff lines readable via their `+`/`-` prefixes.
 *
 * Live-output dedupe: shell-shaped results (`<COMMAND_OUTPUT>`) belong to tools whose child
 * output ALREADY streamed raw via the channel's default sink, so those render with
 * `liveOutputAlreadyShown` and show only the closing status line — never a repeat of output
 * the user just watched.
 */
import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {
  buildToolPreviewLines,
  getToolGlyph,
  isShellShapedResult,
  renderToolLineAnsi,
  summariseToolCall,
  toolStatusDisplay,
} from '#src/core/toolDisplay.js';
import { displayToolIndication } from '#src/utils/consoleUtils.js';
import { getUseColour } from '#src/utils/systemUtils.js';

const INDENT = '    ';

/** One tracked (possibly still-streaming) tool call. */
interface TrackedToolCall {
  id?: string;
  name: string;
  argsText: string;
}

export interface PlainToolIndicationObserver {
  /** Feed every streamed message/chunk (the string path's existing loop) through this. */
  observe(chunk: unknown): void;
}

/**
 * Create the per-stream observer. State is scoped to one stream (one `agent.stream()` call);
 * tool_call deltas are accumulated from `tool_call_chunks` (keyed by the provider's chunk
 * `index`, which restarts per LLM round — the map is flushed into the by-id map whenever a
 * `ToolMessage` arrives, mirroring `processEventStream`'s reset-per-round). Deliberately does
 * NOT `concat()` whole `AIMessageChunk`s: only the tool-call slices are needed, which also
 * sidesteps the TUI-C29 `__raw_response` aggregation-growth trap entirely.
 *
 * `emit` is injectable for tests; production uses the INFO-level `displayToolIndication`.
 */
export function createPlainToolIndication(
  emit: (text: string) => void = displayToolIndication,
  /**
   * [[TUI-C69]] §5.4 — **was this call refused back to the agent as a negotiation round?** Asked
   * per tool-call id at the moment the result is rendered, never earlier: the gate decides while
   * this stream is being drained, so a snapshot taken when the observer was built would always
   * say no.
   *
   * Defaults to *"nothing is a clarification"*, which is what a surface with no gate behind it
   * (and every existing caller) means.
   */
  isRaterClarification: (toolCallId: string) => boolean = () => false
): PlainToolIndicationObserver {
  /** Streaming tool-call deltas for the CURRENT round, keyed by tool_call_chunk index. */
  const streaming = new Map<number, TrackedToolCall>();
  /** Completed calls awaiting their ToolMessage, keyed by tool call id. */
  const byId = new Map<string, TrackedToolCall>();

  const flushStreamingIntoById = (): void => {
    for (const call of streaming.values()) {
      if (call.id) byId.set(call.id, call);
    }
    streaming.clear();
  };

  const renderToolMessage = (message: ToolMessage): void => {
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
    const tracked = id ? byId.get(id) : undefined;
    if (id) byId.delete(id);
    const name = tracked?.name || (typeof message.name === 'string' ? message.name : '') || '';
    const result =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const isError = message.status === 'error';
    // [[TUI-C69]] §5.4 — asked on the id, at render time, from the gate's own decision. Never
    // from the result text: legitimate output may begin with "Error handling…".
    const raterClarification = id ? isRaterClarification(id) : false;
    // TUI-C35 — colour is exactly what the resolved ladder says, with no local narrowing.
    // This used to AND in `stdout.isTTY`, which was redundant in every case but one: rung 4 of
    // `config/colour.ts` already auto-detects from stdout's TTY status, so an unconfigured piped
    // run is monochrome either way. The one case it changed was `FORCE_COLOR` into a pipe — which
    // it suppressed, defeating the only thing that variable is for.
    const colour = getUseColour();

    // [[TUI-C69]] §5.4 — one decision, shared with the Ink surface, about what a finished call's
    // status row says. This surface prints no `[label]` after the summary, so the WORDS are added
    // as their own tail on the clarification row: the glyph alone would leave the distinction to
    // a symbol, and §5.4's requirement has to survive a terminal with no colour at all.
    const status = toolStatusDisplay({ isError, raterClarification });
    const ansi = status.tone === 'error' ? '31' : status.tone === 'warn' ? '33' : '32';
    const statusGlyph = colour ? `\x1b[${ansi}m${status.glyph}\x1b[0m` : status.glyph;
    const summary = summariseToolCall(name, tracked?.argsText);
    const summaryText = colour ? `\x1b[2m${summary}\x1b[0m` : summary;
    const note = raterClarification ? `  [${status.label}]` : '';
    const noteText = colour && note ? `\x1b[33m${note}\x1b[0m` : note;
    const head = `${statusGlyph} ${getToolGlyph(name)} ${summaryText}${noteText}`;

    const preview = buildToolPreviewLines({
      name,
      argsText: tracked?.argsText,
      result,
      isError,
      // Shell-shaped results stream their child output live through the channel's default
      // sink on this surface — suppress the duplicated body, keep the status tail. TUI-C32
      // residual c: gate on the tool NAME + shape (not shape alone), so a non-shell tool whose
      // result merely quotes `<COMMAND_OUTPUT>` keeps its preview body instead of being suppressed.
      liveOutputAlreadyShown: isShellShapedResult(name, result),
    });
    const body = preview.map((line) => INDENT + renderToolLineAnsi(line, colour));
    // Leading newline mirrors the historical notice framing (the model text stream may have
    // left the cursor mid-line).
    emit(['', head, ...body].join('\n'));
  };

  return {
    observe(chunk: unknown): void {
      // Order matters: AIMessageChunk extends AIMessage, so test the chunk shape first
      // (mirrors processEventStream).
      if (AIMessageChunk.isInstance(chunk as BaseMessage)) {
        // TUI-C32 residual e — fail-soft, matching the ToolMessage branch: accumulating tool-call
        // deltas (`JSON.stringify(tc.args)` can throw on an unserialisable arg, e.g. a BigInt) must
        // never break the run's stream loop. On any error we simply skip this chunk's tracking.
        try {
          const c = chunk as AIMessageChunk;
          const deltas = c.tool_call_chunks ?? [];
          if (deltas.length > 0) {
            for (const delta of deltas) {
              const index = typeof delta.index === 'number' ? delta.index : 0;
              const entry = streaming.get(index) ?? { name: '', argsText: '' };
              if (delta.id) entry.id = delta.id;
              if (delta.name) entry.name = entry.name || delta.name;
              if (delta.args) entry.argsText += delta.args;
              streaming.set(index, entry);
            }
          } else {
            // Some providers surface COMPLETE tool_calls on a chunk instead of deltas.
            for (const tc of c.tool_calls ?? []) {
              if (tc.id) {
                byId.set(tc.id, {
                  id: tc.id,
                  name: tc.name,
                  argsText: JSON.stringify(tc.args ?? {}),
                });
              }
            }
          }
        } catch {
          /* indication is best-effort; the model-facing stream is untouched */
        }
        return;
      }
      if (AIMessage.isInstance(chunk as BaseMessage)) {
        // A non-chunk AIMessage (resumed/checkpoint-replayed runs) carries final tool_calls.
        // TUI-C32 residual e — same fail-soft wrap as above/the ToolMessage branch.
        try {
          const m = chunk as AIMessage;
          for (const tc of m.tool_calls ?? []) {
            if (tc.id) {
              byId.set(tc.id, {
                id: tc.id,
                name: tc.name,
                argsText: JSON.stringify(tc.args ?? {}),
              });
            }
          }
        } catch {
          /* indication is best-effort; the model-facing stream is untouched */
        }
        return;
      }
      if (chunk instanceof ToolMessage) {
        // The round is over: park any streamed calls under their ids (chunk indexes restart
        // next round), then render the arrived result. Fail-soft — rendering must never break
        // the run.
        try {
          flushStreamingIntoById();
          renderToolMessage(chunk);
        } catch {
          /* indication is best-effort; the model-facing stream is untouched */
        }
      }
    },
  };
}
