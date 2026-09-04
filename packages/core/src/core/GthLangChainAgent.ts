import {
  GthConfig,
  SHELL_TOOL_NAME,
  commandAnswersApprovals,
  resolveApprovals,
  resolveGatedToolNames,
  resolveInterruptToolNames,
  resolveShellApprovalGate,
} from '#src/config.js';
import { GthAgentInitOptions, GthCommand, StatusLevel } from '#src/core/types.js';
import { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';
import { debugLog, debugLogObject } from '#src/utils/debugUtils.js';
import { buildSystemMessages, formatToolCalls, readModePrompt } from '#src/utils/llmUtils.js';
import { getCurrentWorkDir } from '#src/utils/systemUtils.js';
import { isToolAllowed } from '#src/utils/toolMatching.js';
import {
  appendOsShellNote,
  appendCwdNote,
  appendCommitCoAuthorNote,
  appendModelContextNote,
  appendMcpServerInstructionsNote,
  resolveModelIdentity,
} from '#src/utils/systemPromptNotes.js';
import { isShellCommandFailedError } from '#src/core/shell/ShellCommandFailedError.js';
import { extractDebugRequestExtras, type DebugRequestExtras } from '#src/core/debugCapture.js';
import { promoteTextEmittedToolCallMessage } from '#src/core/toolCallRepair/index.js';
import { terminationReason, type GthTerminationReason } from '#src/core/terminationReason.js';
import {
  compactMessages,
  conversationSize,
  createModelSummarizer,
  type CompactMessagesResult,
} from '#src/core/compaction.js';
import { resolveContextWindowSource, type ContextWindowSource } from '#src/core/contextWindow.js';
import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseCheckpointSaver, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import {
  createAgent,
  createMiddleware,
  humanInTheLoopMiddleware,
  type InterruptOnConfig,
} from 'langchain';

// AgentStreamEvent moved to #src/core/types.js (it is the shared renderer contract).
// Re-exported here for backwards compatibility with importers of this module.
export type { AgentStreamEvent } from '#src/core/types.js';

/**
 * GS2-36 — default cap for the tool-error retry budget: how many status:'error' tool results may
 * accrue back-to-back (no successful tool result in between) before the run is ended gracefully.
 * Small on purpose: it still lets the model try a couple of genuine recovery variants (the whole
 * point of feeding errors back — GS2-32 showed the model routes around a surfaced error in 1–2
 * tries) while stopping a runaway self-inflicted loop long before createAgent's coarse
 * recursionLimit backstop would.
 */
export const MAX_CONSECUTIVE_TOOL_ERRORS = 5;

/**
 * GS2-36 — the tool-error retry budget as a standalone, testable middleware factory (exported so the
 * real thing can be unit-tested and exercised in a real `createAgent` graph, mirroring
 * `createPathNamespaceCorrectionMiddleware`).
 *
 * Runs in `beforeModel` (like langchain's own `modelCallLimitMiddleware`): after the tools node has
 * appended its result(s) and before the next model call is spent, it walks the trailing messages and
 * counts CONSECUTIVE errored tool results — a `ToolMessage` with `status: 'error'` (the shape the
 * shell/MCP softeners produce; GthAbstractAgent maps `status==='error' → isError`). The walk skips
 * the assistant tool-call requests between rounds, and RESETS on the first successful tool result
 * (progress / diagnosis) or a Human/System message (a fresh user turn). Once the count reaches the
 * cap it returns `{ jumpTo: 'end', messages: [<action-oriented notice>] }`, ending the run without
 * spending another model call.
 *
 * Scope: counts `status: 'error'` results only. The recoverable fs error STRINGS
 * (`write_file`/`edit_file`/…) are `status: 'success'` by the write_file precedent, so a pure fs
 * error loop is deliberately NOT capped here — it stays bounded by the coarse `recursionLimit` and is
 * the remit of the loop-DETECTION node (EXT-36). Counting `status: 'error'` overall (not per-tool)
 * catches both same-tool and alternating-tool error loops with one robust rule.
 */
export function createToolErrorBudgetMiddleware(
  maxConsecutiveErrors: number = MAX_CONSECUTIVE_TOOL_ERRORS,
  onHalt?: (_reason: GthTerminationReason) => void
) {
  return createMiddleware({
    name: 'GthLeanToolErrorBudget',
    beforeModel: {
      canJumpTo: ['end'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: (state: any) => {
        const messages: unknown[] = Array.isArray(state?.messages) ? state.messages : [];
        let consecutive = 0;
        let lastErrorContent = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (ToolMessage.isInstance(msg)) {
            if (msg.status === 'error') {
              consecutive++;
              if (!lastErrorContent) {
                lastErrorContent = typeof msg.content === 'string' ? msg.content : '';
              }
            } else {
              // A successful tool result — the model is making progress / diagnosing, so the
              // unrecovered-error streak is broken. Stop the walk (reset).
              break;
            }
          } else if (AIMessage.isInstance(msg)) {
            // The assistant tool-call request that produced the error above; skip and keep counting.
            // GS2-72: this `continue` INTENTIONALLY also skips the budget's OWN injected terminal
            // notice (itself an AIMessage). If the run re-enters beforeModel on the same thread after
            // a jumpTo:'end' (a re-invoke on the same thread — e.g. the no-checkpointer degrade of
            // the string path's empty-stream fallback, or a later turn that keeps erroring), skipping
            // the notice lets the walk still reach the errored results and re-trip deterministically.
            // Do NOT special-case the notice to reset/break here — treating it as a fresh-turn
            // boundary would let the capped loop resume.
            continue;
          } else {
            // A Human/System message: a fresh user-turn boundary — earlier errors don't count.
            break;
          }
        }
        if (consecutive >= maxConsecutiveErrors) {
          const firstLine = (lastErrorContent.split('\n')[0] ?? '').slice(0, 300);
          const notice =
            `Stopped after ${consecutive} consecutive failed tool calls to avoid a retry loop that ` +
            'keeps spending tokens without making progress' +
            (firstLine ? ` (last error: ${firstLine})` : '') +
            '. Do not repeat the same call: inspect the error, then change your approach — different ' +
            'arguments, a narrower path, or a different tool — or report the blocker to the user.';
          // [[EXT-159]] — a run this middleware ends deliberately is a termination like any other,
          // and the only thing that reaches the surface is the notice above: a sentence a consumer
          // would have to pattern-match to learn what happened. The typed reason is the parallel
          // channel, so the classification never depends on the wording.
          onHalt?.(
            terminationReason('middleware.tool-error-budget', 'control', {
              category: 'tool_error_budget',
              detail: `${consecutive} consecutive tool errors`,
            })
          );
          return { jumpTo: 'end', messages: [new AIMessage(notice)] };
        }
        return undefined;
      },
    },
  });
}

/**
 * EXT-36 — default number of consecutive identical `(tool, args)` calls before the tool-loop guard
 * fires. Small on purpose: it must catch a genuine no-progress loop (a model re-issuing the SAME
 * call verbatim) while never tripping a legitimate one-off retry (2x). Kept below GS2-36's coarser
 * error cap (5) because a same-signature repeat is a stronger, more specific loop signal than "an
 * error happened again".
 */
export const DEFAULT_TOOL_LOOP_THRESHOLD = 3;

/** EXT-36 — resolved knobs for {@link createToolLoopGuardMiddleware}. */
export interface ToolLoopGuardOptions {
  /** Surface a user-visible notice at threshold (NO model-input mutation). Default ON. */
  warn?: boolean;
  /** End the run via `jumpTo:'end'` at threshold (opt-in, active loop-breaking). Default OFF. */
  halt?: boolean;
  /** Consecutive identical-signature repeats that trip the guard. Default {@link DEFAULT_TOOL_LOOP_THRESHOLD}. */
  threshold?: number;
}

/**
 * EXT-36 — normalise the `toolLoopGuard` config union (`false | true | { warn?, halt?, threshold? }`)
 * into concrete {@link ToolLoopGuardOptions}, applying the WARN-ON-by-default policy at the read site
 * (mirrors how `debugDump.redact` defaults with `!== false`, NOT in DEFAULT_CONFIG, so the
 * effective-config snapshot never churns).
 * - `false` → both modes off (a no-op guard);
 * - `true` / absent → warn on, halt off, default threshold;
 * - object → per-field, with warn defaulting ON and halt defaulting OFF.
 */
export function resolveToolLoopGuardOptions(
  setting: boolean | ToolLoopGuardOptions | undefined | null
): ToolLoopGuardOptions {
  if (setting === false) return { warn: false, halt: false };
  if (setting === true || setting === undefined || setting === null) return {};
  return { warn: setting.warn, halt: setting.halt, threshold: setting.threshold };
}

/**
 * EXT-36 — a deterministic, key-sorted stringify so `(tool, args)` signatures are stable regardless
 * of object key order. No-args (`{}`) collapses to `"{}"`, so identical no-arg repeats collide BY
 * DESIGN — that is exactly the loop signal. Known limitation: args carrying a volatile value (a
 * timestamp / uuid) make every call look distinct, so the guard cannot see that loop; volatile-key
 * stripping is deliberately NOT attempted (over-engineering for a rare, model-authored case).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/**
 * The delimiter between a tool name and its serialised arguments in a call signature. U+0000 is
 * chosen because a tool name cannot contain a control character, so no `(name, args)` pair can be
 * spelled two ways and no pair of distinct calls can collide on one signature.
 *
 * It MUST stay written as this escape. A raw NUL byte in the source makes the whole file binary to
 * ripgrep and ugrep, which then skip it in silence — every symbol in this file becomes invisible to
 * a repo-wide search, and an empty result reads as proof of absence. `noRawControlBytes.spec.ts` guards
 * the repo against the raw form returning.
 */
export const TOOL_CALL_SIGNATURE_DELIMITER = '\u0000';

/**
 * EXT-36 — the `(tool, args)` identity a repeat-detection streak is counted over. Exported so the
 * delimiter invariant above is asserted directly rather than inferred from loop behaviour.
 */
export function toolCallSignature(name: string, args: unknown): string {
  return `${name}${TOOL_CALL_SIGNATURE_DELIMITER}${stableStringify(args ?? {})}`;
}

/**
 * EXT-36 — the tool-loop guardrail as a standalone, testable middleware factory. The ORTHOGONAL
 * sibling of {@link createToolErrorBudgetMiddleware}: GS2-36 caps a consecutive-tool-ERROR streak;
 * this catches a **repeated identical `(tool, args)` / no-progress loop** — the same call re-issued
 * verbatim, whether it keeps erroring OR keeps "succeeding" with the same result (the fs-error-string
 * loop GS2-36's comment explicitly leaves to EXT-36).
 *
 * STATELESS (the critical trap): the factory runs ONCE per session, so a closure-held counter would
 * bleed across every turn. Like GS2-36 it holds NO state — each `beforeModel` recomputes the streak
 * from the message tail.
 *
 * Detection. A signature is `(tool_name, args_hash)`. Name + args live on `AIMessage.tool_calls[]`,
 * NOT on the `ToolMessage` (softener ToolMessages carry only content+tool_call_id+status), so each
 * `ToolMessage` is paired to its call by `tool_call_id === AIMessage.tool_calls[].id` to recover the
 * signature. The backward walk counts CONSECUTIVE ToolMessages with the SAME signature; a DIFFERENT
 * signature breaks the streak (the model tried something else = progress), and a Human/System message
 * is a fresh-turn boundary. Assistant messages (the tool-call requests) are skipped. Known no-op
 * (safe, never a false trip): a single AIMessage issuing PARALLEL tool calls yields back-to-back
 * differing signatures, which the walk reads as progress and resets.
 *
 * Two modes (composable):
 * - WARN (default ON, provably harmless): the default path must NOT change what the model sees.
 *   Appending ANY message then re-invoking the model mutates its input — a *steer*, not a *warn* —
 *   and is provider-unsafe by default (Gemini expects a trailing user turn → crash risk; Anthropic
 *   treats a trailing assistant as PREFILL → the note silently becomes the opening of the model's own
 *   next reply, corrupt with no error; a HumanMessage after a ToolMessage is two consecutive user
 *   turns for Anthropic/Gemini). So WARN instead SURFACES a user-visible notice via {@link onWarn}
 *   and returns `undefined` — zero `state.messages` mutation, zero control-flow. Fired statelessly
 *   ONCE per streak at the exact crossing (`streak === threshold`): a still-looping streak on later
 *   turns (`streak > threshold`) does not re-surface, while an interrupted-then-resumed loop
 *   re-reaches `threshold` and surfaces again — no marker/`additional_kwargs` machinery needed.
 * - HALT (opt-in only, active loop-breaking): at/over threshold, return
 *   `{ jumpTo: 'end', messages: [new AIMessage(reason)] }` — a TERMINAL notice (the model is never
 *   re-invoked after it, so the prefill/role hazard cannot arise; the GS2-72-proven clean-stream
 *   path). NEVER throws. A validated behaviour change lives behind this opt-in.
 *
 * @param onWarn TUI-safe user-notice sink for WARN, wired at the read site to
 *   `statusUpdate(StatusLevel.WARNING, …)` (routed through the agent's status callback the renderer
 *   consumes, never raw stdout, so it can't leak over the Ink frame). Omitted → WARN still runs but
 *   surfaces nothing (still zero model-input mutation).
 */
export function createToolLoopGuardMiddleware(
  options: ToolLoopGuardOptions = {},
  onWarn?: (message: string) => void,
  onHalt?: (_reason: GthTerminationReason) => void
) {
  const warn = options.warn ?? true;
  const halt = options.halt ?? false;
  const threshold = options.threshold ?? DEFAULT_TOOL_LOOP_THRESHOLD;
  return createMiddleware({
    name: 'GthLeanToolLoopGuard',
    beforeModel: {
      canJumpTo: ['end'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: (state: any) => {
        // `false` config resolves to warn:false + halt:false — a genuine no-op (fast bail).
        if (!warn && !halt) return undefined;
        const messages: unknown[] = Array.isArray(state?.messages) ? state.messages : [];

        // Recover each tool call's signature by id — name + args are on the AIMessage, not the
        // ToolMessage. One pass over all AIMessages builds the id → {sig, name} lookup.
        const callById = new Map<string, { sig: string; name: string }>();
        for (const msg of messages) {
          if (AIMessage.isInstance(msg) && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              const id = tc?.id;
              if (typeof id === 'string') {
                const name = typeof tc.name === 'string' ? tc.name : '';
                // Signature identity + its delimiter: see toolCallSignature.
                callById.set(id, { sig: toolCallSignature(name, tc.args), name });
              }
            }
          }
        }

        // Walk the tail backward, counting consecutive identical signatures since the last boundary.
        let streak = 0;
        let currentSig: string | undefined;
        let currentName = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (ToolMessage.isInstance(msg)) {
            const call = callById.get(msg.tool_call_id as string);
            // No paired call → cannot prove a repeat; treat as a boundary (never a false trip).
            if (!call) break;
            if (currentSig === undefined) {
              currentSig = call.sig;
              currentName = call.name;
              streak = 1;
            } else if (call.sig === currentSig) {
              streak++;
            } else {
              break; // different signature = the model tried something else = progress
            }
          } else if (AIMessage.isInstance(msg)) {
            continue; // the tool-call request — skip and keep counting the streak
          } else {
            break; // Human/System message: a fresh user turn resets everything.
          }
        }

        if (currentSig === undefined || streak < threshold) return undefined;

        // HALT (opt-in): end the run cleanly — never a throw. Terminal, so the model is never
        // re-invoked after this AIMessage (no prefill/role hazard). Takes precedence over WARN.
        if (halt) {
          const notice =
            `Stopped after ${streak} identical calls to the \`${currentName}\` tool with the same ` +
            'arguments to avoid a loop that keeps spending tokens without making progress. ' +
            'The same call cannot yield a different result: change your approach — different ' +
            'arguments, a narrower step, or a different tool — or report the blocker to the user.';
          // [[EXT-159]] — the loop guard's twin of the error budget's site, and its own taxonomy
          // member: "the agent repeated one call" and "the agent kept failing" are different facts
          // about why the run ended, and only the notices tell them apart today.
          onHalt?.(
            terminationReason('middleware.tool-loop-guard', 'control', {
              category: 'tool_loop_guard',
              detail: `${streak} identical calls to ${currentName}`,
            })
          );
          return { jumpTo: 'end', messages: [new AIMessage(notice)] };
        }

        // WARN (default): SURFACE a user-visible notice and DO NOT touch state.messages (return
        // undefined → the model's input is byte-for-byte unchanged, so no prefill/role hazard on any
        // provider). Fire once per streak at the exact crossing: `streak === threshold` is a
        // stateless "fire once" — a still-looping streak (streak > threshold) stays quiet, while an
        // interrupted-then-resumed loop re-reaches threshold and surfaces again.
        if (warn && streak === threshold) {
          onWarn?.(
            `Tool-loop guard: the agent has called \`${currentName}\` with the same arguments ` +
              `${streak} times without new progress. It may be stuck — consider interrupting and ` +
              'refining the request.'
          );
        }
        return undefined;
      },
    },
  });
}

/**
 * EXT-160 — how many characters of prompt one token is assumed to carry.
 *
 * 3.5 rather than the usual English rule of thumb of 4, because the prompt this guard measures is
 * not English: it is a system prompt full of tool schemas, JSON tool arguments and file paths, which
 * tokenise far worse than prose. Erring low makes the estimate HIGH, which is the safe direction —
 * an early compaction costs one summary call, a late one costs a silently truncated conversation.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 3.5;

/**
 * EXT-160 — the multiplier applied to the whole estimate, on top of the pessimistic ratio above.
 *
 * The estimate is anchored on a real token count and extrapolates only the delta, so 10% covers the
 * part that is genuinely guessed: the tokens of messages added since the anchor, plus whatever the
 * provider adds per message that no character count can see (role headers, tool-call framing).
 */
export const ESTIMATE_SAFETY_MARGIN = 1.1;

/**
 * EXT-160 — tokens reserved for the model's own answer when nothing else says.
 *
 * On ollama `num_ctx` covers the prompt **and** the generation from one budget, so a prompt that
 * "fits" with nothing left over does not fail — it produces a truncated answer, which is the second
 * failure of the spike's three wearing the first's clothes. Reserving the room is what keeps a
 * guard that is about input overflow from shipping output truncation instead.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 2048;

/**
 * EXT-160 — the most any ONE non-text content block may add to the estimate, in tokens.
 *
 * **This is an approximation and does not model any provider's image tokenisation.** It cannot: the
 * real number depends on the provider, the model, and how the image is tiled, and none of that is
 * knowable from the block. What it does instead is bound the damage in both directions.
 *
 * The bound is needed because a block's ENCODED LENGTH is not a proxy for its size at all. A 100 KB
 * inline image is roughly 136 500 base64 characters, which at the ratio above is about 43 000
 * tokens, while providers charge on the order of a thousand for it — an over-count near 33×, larger
 * than any window this project wires. Charging that would fold the conversation on every single
 * turn, which is the same thrashing the reserve clamp exists to prevent, arriving from the other
 * side.
 *
 * 1600 sits at the top of the range providers charge for a large image, so it **errs high** — the
 * same direction as every other approximation here, and the direction the node prefers, because an
 * early compaction costs one summary call while a late one costs a silently truncated conversation.
 * It errs high by a bounded factor rather than an unbounded one, which is the whole point.
 *
 * It is a CAP, not a flat charge: a block shorter than this is counted at its real length, so a
 * small structured tool result stays accurate instead of being inflated to an image's cost.
 */
export const NON_TEXT_BLOCK_TOKEN_ALLOWANCE = 1600;

/**
 * EXT-160 — {@link NON_TEXT_BLOCK_TOKEN_ALLOWANCE} in the characters the estimator actually sums,
 * so the cap survives the division by {@link ESTIMATE_CHARS_PER_TOKEN} that follows.
 */
export const NON_TEXT_BLOCK_CHARACTER_ALLOWANCE = Math.round(
  NON_TEXT_BLOCK_TOKEN_ALLOWANCE * ESTIMATE_CHARS_PER_TOKEN
);

/**
 * EXT-160 — a residual this small is a block's structural keys, not its payload.
 *
 * After a block's `text` is removed (already counted elsewhere) an ordinary text block leaves only
 * its discriminator — `{"type":"text"}` is fifteen characters. Charging that would add noise
 * proportional to the NUMBER of blocks rather than to what they carry, and the system prompt alone
 * is an array of them. Anything above this floor is treated as payload and counted.
 *
 * This is the one approximation here that errs LOW, and only ever by this many characters per
 * block, because a residual under the floor cannot be a payload worth compacting for.
 */
export const BLOCK_STRUCTURE_FLOOR_CHARACTERS = 64;

/**
 * EXT-160 — the largest fraction of the window the **default** reserve is allowed to claim.
 *
 * A fixed reserve is meaningless against a window near its own size: measured live on a
 * deliberately small `num_ctx` of 2048, the flat 2048-token reserve made `estimate + reserve >
 * window` true for every call whatever the conversation held, so the guard folded on every turn and
 * spent a summary call each time. The clamp keeps the reserve proportionate — a quarter of the
 * window is still real headroom for an answer, and it can never be the whole budget.
 *
 * This applies to the number nobody chose. A reserve the user configured is clamped by
 * {@link MAX_EXPLICIT_RESERVE_FRACTION_OF_WINDOW} instead, and the reason is below.
 */
export const MAX_RESERVE_FRACTION_OF_WINDOW = 0.25;

/**
 * EXT-160 — the largest fraction of the window a **configured** reserve is allowed to claim.
 *
 * A user who sets `llm.numPredict` has named an answer budget, which the default has not, so
 * clamping it to a quarter of the window silently gives them less than they asked for and then
 * truncates the answer — the exact failure the reserve exists to prevent, reintroduced by the fix
 * for a different one. Measured: at `numCtx: 16384` with `numPredict: 8192`, a quarter-clamp holds
 * back 4096, the guard sees 16140 against 16384 and passes the turn, and the answer is then short
 * by 3852 tokens.
 *
 * **A configured number can still be reduced, and this is where.** Above half the window it is cut
 * to half, because a reserve larger than that leaves less room for the conversation than for the
 * answer, and at that point no conversation fits and the guard would fold on every turn — the
 * thrashing the default clamp exists to stop. So: honoured up to half the window, reduced beyond
 * it.
 */
export const MAX_EXPLICIT_RESERVE_FRACTION_OF_WINDOW = 0.5;

/** EXT-160 — what {@link createContextGuardMiddleware} needs to decide, all of it injectable. */
export interface ContextGuardOptions {
  /**
   * The window to guard against, in tokens. **`null` is a first-class answer meaning "unknown", and
   * an unknown window never triggers a compaction** — see `contextWindow.ts`.
   */
  windowSource: ContextWindowSource;
  /**
   * Compact the conversation. Returns the unchanged list with `changed: false` when there is
   * nothing worth folding, which is what stops this guard looping (see the hook).
   */
  compact: (_messages: BaseMessage[]) => Promise<CompactMessagesResult>;
  /**
   * Tokens held back for the answer; {@link DEFAULT_OUTPUT_RESERVE_TOKENS} when omitted.
   *
   * Whether this was set matters, not just its value: an omitted reserve is clamped by
   * {@link MAX_RESERVE_FRACTION_OF_WINDOW}, a configured one by the more generous
   * {@link MAX_EXPLICIT_RESERVE_FRACTION_OF_WINDOW}, because a number the user chose says something
   * the default does not. Passing the default value explicitly therefore takes the configured
   * path — which is what a caller forwarding `llm.numPredict` wants, and what a test pinning the
   * default must avoid.
   */
  reserve?: number;
  /**
   * The static system prompt's characters, read at call time. `createAgent` applies the system
   * prompt on every call without ever putting it in `state.messages`, so a guard that measured only
   * the state would under-count by the largest single block in the request. A function rather than
   * a number because the graph's middleware is assembled before the prompt it will be built with.
   */
  systemPromptCharacters?: () => number;
  /** Estimator override; {@link estimatePromptTokens} when omitted. Injected by the tests. */
  estimateTokens?: (_messages: readonly BaseMessage[], _systemPromptCharacters: number) => number;
  /** User-visible notice sink, wired to the agent's status channel. */
  onCompact?: (_message: string) => void;
}

/**
 * EXT-160 — **an estimate, and it says so in its name.**
 *
 * Ollama exposes no tokenizer over its API, so there is no way to count the prompt exactly before
 * sending it. Rather than guess from characters alone, this anchors on the last REAL number the
 * provider gave us: `usage_metadata.input_tokens` on the most recent `AIMessage` (ChatOllama maps
 * ollama's `prompt_eval_count` into it), which is exactly the token count of everything that
 * preceded that message — system prompt included. Only what has arrived SINCE the anchor is
 * extrapolated from characters, so the guessed fraction shrinks as the conversation grows, which is
 * precisely when the number starts to matter.
 *
 * With no anchor (the first call of a session) everything is extrapolated, and the system prompt's
 * characters are added because nothing has measured them yet. With an anchor they are already
 * inside the anchor's count and adding them again would double-count the single largest block.
 */
/**
 * EXT-160 — the characters `conversationSize` cannot see, added back.
 *
 * `conversationSize` reads message content through `compaction.ts`'s `contentText`, which keeps a
 * string block and a block with a string `text` field and returns `''` for everything else. That is
 * right for compaction, whose before/after comparison only has to agree with itself, but it is
 * wrong for a token estimate: an image block or a structured MCP tool result would contribute zero
 * characters, so the guard would under-count precisely the payload most likely to fill the window.
 *
 * That is the UNSAFE direction, and it is the only approximation the estimator errs that way — every
 * other one deliberately reads high.
 *
 * **What is counted is the block MINUS its `text`, capped.** Both halves matter:
 *
 * - Removing `text` is what stops a block from being counted twice, since `contentText` already
 *   returned it. It also closes the gap the mirror-the-skip-conditions version left: a block
 *   carrying BOTH a `text` field and a payload used to be skipped whole, so `contentText` counted
 *   its text and its payload was free. That is the under-count this function exists to fix,
 *   surviving inside the fix.
 * - Capping at {@link NON_TEXT_BLOCK_CHARACTER_ALLOWANCE} is what stops the opposite failure: an
 *   encoded payload's LENGTH is not its cost, and charging it in full over-counts an inline image by
 *   enough to fold the conversation on every turn. That constant carries the reasoning.
 *
 * A residual at or below {@link BLOCK_STRUCTURE_FLOOR_CHARACTERS} is a type discriminator rather
 * than a payload and is not charged.
 */
function nonTextBlockCharacters(messages: readonly BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      // A bare string block is content `contentText` already returned in full.
      if (typeof block === 'string') continue;
      if (!block || typeof block !== 'object') continue;
      let payload: string;
      try {
        const { text: _countedByContentText, ...rest } = block as Record<string, unknown>;
        payload = JSON.stringify(
          typeof (block as { text?: unknown }).text === 'string' ? rest : block
        );
      } catch {
        /* a block that cannot be serialised is left uncounted rather than crashing the estimate */
        continue;
      }
      const length = payload?.length ?? 0;
      if (length <= BLOCK_STRUCTURE_FLOOR_CHARACTERS) continue;
      total += Math.min(length, NON_TEXT_BLOCK_CHARACTER_ALLOWANCE);
    }
  }
  return total;
}

export function estimatePromptTokens(
  messages: readonly BaseMessage[],
  systemPromptCharacters = 0
): number {
  let anchorIndex = -1;
  let anchorTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!AIMessage.isInstance(message)) continue;
    const input = message.usage_metadata?.input_tokens;
    if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
      anchorIndex = i;
      anchorTokens = input;
      break;
    }
  }
  // From the anchor message onward: the anchor's own tokens covered everything BEFORE it, so the
  // anchor message itself is part of the next prompt and is counted in the delta.
  const counted = anchorIndex === -1 ? messages : messages.slice(anchorIndex);
  const deltaCharacters =
    conversationSize(counted).characters +
    nonTextBlockCharacters(counted) +
    (anchorIndex === -1 ? systemPromptCharacters : 0);
  const estimate = anchorTokens + deltaCharacters / ESTIMATE_CHARS_PER_TOKEN;
  return Math.ceil(estimate * ESTIMATE_SAFETY_MARGIN);
}

/**
 * EXT-160 — **the pre-call context guard: compact BEFORE the request, never after the damage.**
 *
 * Why a `beforeModel` middleware and not the runner's turn funnel: every model call inside a tool
 * loop grows the context, and the runner only ever sees the turn boundary — so a turn that fits
 * when it starts and overflows on its fourth tool round is invisible there. A `beforeModel` hook
 * sees `state.messages` on every call, which is the only place this can be caught.
 *
 * **Pre-call means pre-call, and that is the whole point.** Ollama does not raise on overflow: the
 * daemon silently drops the oldest tokens to fit `num_ctx` and answers happily from what is left,
 * so there is no error, no stop reason, and nothing on the wire that differs from a healthy turn.
 * By the time a response exists the evidence is gone — a check that ran after it could only ever
 * confirm damage already done, and the damage is not a missing answer but a plausible one built on
 * a conversation whose head was quietly discarded.
 *
 * **The loop hazard, and the bail that closes it.** The factory runs once per session, so like its
 * two siblings above this hook holds NO state and recomputes everything from `state.messages`. That
 * means a compaction which folds nothing would leave the state identical, the estimate identical,
 * and this hook firing again on the next entry — forever. So `changed: false` **lets the call
 * proceed**: a conversation already at its irreducible minimum is sent as it is and allowed to fail
 * honestly (reactively compacted or reported), which is strictly better than a hang.
 *
 * The `compact` closure must call the model DIRECTLY, never through the graph, or the summariser's
 * own call re-enters this hook.
 */
export function createContextGuardMiddleware(options: ContextGuardOptions) {
  // Whether the caller named a reserve, kept separately from its value: the two are clamped
  // differently, and `reserve === DEFAULT_OUTPUT_RESERVE_TOKENS` cannot tell "chose the default"
  // from "said nothing".
  const reserveWasConfigured = typeof options.reserve === 'number';
  const reserve = options.reserve ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const reserveFraction = reserveWasConfigured
    ? MAX_EXPLICIT_RESERVE_FRACTION_OF_WINDOW
    : MAX_RESERVE_FRACTION_OF_WINDOW;
  const systemPromptCharacters = options.systemPromptCharacters ?? (() => 0);
  const estimateTokens = options.estimateTokens ?? estimatePromptTokens;
  return createMiddleware({
    name: 'GthContextGuard',
    beforeModel: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: async (state: any) => {
        const messages: BaseMessage[] = Array.isArray(state?.messages) ? state.messages : [];
        if (messages.length === 0) return undefined;
        let window: number | null = null;
        try {
          window = await options.windowSource();
        } catch {
          /* a source that failed knows nothing, which is already the no-trigger answer */
        }
        // The 4097 case: an unknown window yields no guard, never a guess.
        if (window === null || !Number.isFinite(window) || window <= 0) return undefined;
        const estimate = estimateTokens(messages, systemPromptCharacters());
        // Proportionate, never absolute — and how proportionate depends on who chose the number:
        // a quarter of the window for the default, half for a reserve the user configured.
        const effectiveReserve = Math.min(reserve, Math.floor(window * reserveFraction));
        if (estimate + effectiveReserve <= window) return undefined;
        debugLog(
          `Context guard: estimated ${estimate} prompt tokens + ${effectiveReserve} reserved for ` +
            `the answer exceeds the ${window}-token window; compacting before the call.`
        );
        let result: CompactMessagesResult;
        try {
          result = await options.compact(messages);
        } catch (error) {
          // A compaction that could not get a summary leaves the conversation alone and says so.
          // Proceeding is right: the request may still succeed, and on a provider that throws, the
          // reactive seam gets its turn.
          debugLog(
            `Context guard: compaction failed, sending the request as it is: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return undefined;
        }
        if (!result.changed) return undefined;
        options.onCompact?.(
          `Context is nearly full (about ${estimate} tokens of a ${window}-token window, with ` +
            `${effectiveReserve} reserved for the answer), so ${result.removedCount} earlier ` +
            `messages were folded into a summary before this call. ${result.keptCount} kept verbatim.`
        );
        // The same write shape GS2-23 uses: discard everything, keep what follows.
        return {
          messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...result.messages],
        };
      },
    },
  });
}

/**
 * Lean agent: builds a standard `createAgent` (ReAct) graph. All run/stream/event
 * plumbing lives in {@link GthAbstractAgent}; this class only knows how to construct
 * the graph in {@link init}.
 */
export class GthLangChainAgent extends GthAbstractAgent {
  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointer?: BaseCheckpointSaver | undefined,
    options?: GthAgentInitOptions
  ): Promise<void> {
    this.command = command;
    // GS2-95 — the header's name for this run, when the command supplied one. Read by
    // `compactHeaderStatus` and by nothing else; it deliberately does NOT feed `this.command`,
    // which selects the mode prompt.
    this.displayCommand = options?.displayCommand;
    debugLog(`GthLangChainAgent.init called with command: ${command || 'default'}`);

    // Merge command-specific filesystem config if provided
    this.config = this.getEffectiveConfig(configIn, command);
    debugLogObject('Effective Config', {
      filesystem: this.config.filesystem,
      builtInTools: this.config.builtInTools,
      streamOutput: this.config.streamOutput,
      debugLog: this.config.debugLog,
    });

    // GS2-93: the run header opens here. Exactly one of these two speaks, decided by the rung —
    // `compact` emits the attribution line and nothing else, every `headerStatus` below is the
    // `debug` rung's preamble, and `none` silences both.
    this.compactHeaderStatus();
    this.headerStatus(`Workdir: ${getCurrentWorkDir()}`);

    if (this.config.modelDisplayName) {
      this.headerStatus(`Model: ${this.config.modelDisplayName}`);
    }

    // An empty allowedTools allow-list disables every tool. Skip resolution entirely so we
    // don't contact MCP servers (and trigger OAuth) just to discard the result.
    const allowedTools = this.config.allowedTools;
    const toolsDisabled = Array.isArray(allowedTools) && allowedTools.length === 0;
    if (toolsDisabled) {
      this.headerStatus(
        'Tool loading disabled by allowedTools: []; MCP/A2A servers will not be contacted. Omit allowedTools for no filtering.'
      );
    }

    // Resolve tools via resolver or fall back to config tools only
    debugLog('Resolving tools...');
    const resolvedTools =
      !toolsDisabled && this.resolvers?.resolveTools
        ? await this.resolvers.resolveTools(this.config, command)
        : [];
    debugLog(`Resolved tools loaded: ${resolvedTools.length}`);

    // Get user config tools
    const flattenedConfigTools = toolsDisabled
      ? []
      : this.extractAndFlattenTools(this.config.tools || []);
    debugLog(`User config tools loaded: ${flattenedConfigTools.length}`);

    // Combine all tools, then apply the allowedTools name allow-list when configured.
    let tools = [...resolvedTools, ...flattenedConfigTools];
    if (Array.isArray(allowedTools)) {
      // Filter named tools by the allow-list. Entries match by exact name, or glob-style when
      // they contain `*` (e.g. `mcp__unimarket__*`) — see isToolAllowed. ServerTools
      // (provider-native "magic objects" such as Anthropic web search) may have no `name`, so
      // they can never be referenced in the allow-list - drop-by-default would silently remove
      // them with no recourse. Retain such nameless tools instead; the allow-list is a name-based
      // filter and cannot target them.
      tools = tools.filter((tool) => !tool.name || isToolAllowed(tool.name, allowedTools));
    }

    if (tools.length > 0) {
      const toolNames = tools
        .map((tool) => tool.name)
        .filter((name) => name)
        .join(', ');
      this.headerStatus(`Loaded tools: ${toolNames}`);
      debugLog(`Total tools available: ${tools.length}`);
      debugLogObject('All Tools', toolNames.split(', '));
    }

    // Create the React agent
    debugLog('Creating React agent...');

    // Resolve middleware via resolver or fall back to empty
    const configuredMiddleware = this.resolvers?.resolveMiddleware
      ? await this.resolvers.resolveMiddleware(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.config.middleware as any[] | undefined,
          this.config
        )
      : [];

    // Add tool call status update middleware
    const statusUpdate = this.statusUpdate;
    const toolCallStatusMiddleware = createMiddleware({
      name: 'GthMiddlewareToolCallStatusUpdate',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterModel: (state: any) => {
        debugLogObject('postModel state', state);
        const lastMessage = state.messages[state.messages.length - 1];
        if (
          AIMessage.isInstance(lastMessage) &&
          lastMessage.tool_calls &&
          lastMessage.tool_calls?.length > 0
        ) {
          statusUpdate(
            StatusLevel.INFO,
            `\nRequested tools: ${formatToolCalls(lastMessage.tool_calls)}\n`
          );
        }
        return state;
      },
    });

    // EXT-35: promote a text-emitted tool call to a native tool_call so the loop doesn't stall.
    // Small/local models (Gemma, lmstudio, gpt-oss) often serialise a tool call as assistant TEXT
    // instead of a native `tool_call`; the ReAct router then sees no tool_calls on the last message
    // and ENDS the turn ("no tool calls = done"). This afterModel hook runs ONLY when the last
    // AIMessage carries no native tool_calls (the native happy path is byte-for-byte untouched):
    // it parses a STANDALONE text-emitted call (bracket / <function=…> / Harmony), gated HARD by the
    // bound-tool allow-list + a payload-size cap + standalone-only, and — when it promotes — returns
    // the rewritten message. Preserving the original message id is load-bearing: LangGraph's
    // message-state reducer merges by id, so a same-id message REPLACES the model's text message in
    // graph state; the router then sees the native tool_calls and routes to the tools node, so the
    // loop continues instead of concluding done. Ported from the openclaw tool-call-repair reference.
    // Bound-tool names are the allow-list; an empty toolset promotes nothing (prose-safe default).
    const repairToolNames = new Set(
      tools.map((t) => t.name).filter((name): name is string => Boolean(name))
    );
    const toolCallRepairMiddleware = createMiddleware({
      name: 'GthMiddlewareToolCallRepair',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterModel: (state: any) => {
        const lastMessage = state.messages[state.messages.length - 1];
        if (!AIMessage.isInstance(lastMessage)) return state;
        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) return state;
        const promoted = promoteTextEmittedToolCallMessage(lastMessage, {
          allowedToolNames: repairToolNames,
        });
        if (!promoted) return state;
        debugLog(
          `Repaired a text-emitted tool call into a native tool_call: ${formatToolCalls(
            promoted.tool_calls ?? []
          )}`
        );
        // Replace-by-id (same id) so the reducer swaps the text message rather than appending.
        return { messages: [promoted] };
      },
    });

    // EXT-21: `exec` / `ask --write` route through this `createAgent` graph, whose run_* shell/dev
    // tools (GthDevToolkit.executeCommand) THROW a ShellCommandFailedError on a non-zero exit or a
    // timeout-kill. langchain's default ToolNode would catch that throw into a ToolMessage but leave
    // it status:'success' (✓) — misreporting a failed command. Catch it here at the tool-wrap layer
    // and return an error ToolMessage that PRESERVES the full stdout/stderr body: the model's
    // observation is unchanged except the status flips to 'error', which drives the ✗ (isError)
    // glyph (GthAbstractAgent maps status==='error' → isError). Returning a ToolMessage (rather than
    // rethrowing) keeps it a normal, observed tool result — no run-abort, no retry loop. Recognised
    // via isShellCommandFailedError (instanceof + structural fallback) since core cannot import the
    // throw site in the agent package. Every OTHER throw is rethrown untouched so genuine failures
    // and control-flow (GraphInterrupt / AbortError) still surface.
    const shellExitSoftening = createMiddleware({
      name: 'GthLeanShellExitSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          if (isShellCommandFailedError(e)) {
            debugLog(
              `Softened shell/dev command failure (exit ${e.exitCode ?? 'timeout'}) into an ` +
                `error ToolMessage for '${e.command}'`
            );
            return new ToolMessage({
              content: e.output,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tool_call_id: (request.toolCall as any)?.id ?? '',
              status: 'error',
            });
          }
          throw e;
        }
      },
    });

    // MCP tool-execution errors are spec-compliant RESULTS, not fatal faults. Per the MCP spec
    // (2025-11-25 & draft, "Server › Tools › Error Handling"), a tool that hits an API failure, an
    // input-validation problem, or a business-logic error (e.g. a disabled capability) returns a
    // normal tools/call result with `isError: true`, and the CLIENT *SHOULD* hand that error to the
    // model so it can self-correct. `@langchain/mcp-adapters` instead surfaces such a result by
    // THROWING a ToolException at call time (its `_convertCallToolResult`). Because we install a
    // wrapToolCall middleware, langchain's ToolNode treats any error a middleware rethrows as a fatal
    // "middleware error" (`errorFromMiddleware && handleToolErrors !== true` → throw) and aborts the
    // whole turn instead of relaying the error to the model — the opposite of the spec's client
    // SHOULD. This middleware closes that gap: it catches a thrown ToolException and RETURNS it as a
    // status:'error' ToolMessage (→ isError → ✗), so the model observes the error and can retry or
    // explain (matching the non-stream invoke path's ToolException handling). Scope & safety: matched
    // by name === 'ToolException' (the adapter's marker), so GraphInterrupt and every non-MCP throw
    // fall through the final rethrow untouched. The adapter ALSO wraps a call-time AbortError into a
    // ToolException (its `_callTool` catch-all), so we RETHROW when the run's abort signal is set —
    // otherwise softening here would swallow user cancellation that ToolNode's own `signal?.aborted`
    // guard normally enforces (bypassed once we handle the error in middleware). MCP connect/auth
    // (401/403) and load failures are handled at CONNECT time (resolvers.ts throwOnLoadError +
    // onConnectionError), not here, so they stay fatal as intended.
    const mcpToolErrorSoftening = createMiddleware({
      name: 'GthMcpToolErrorSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          if (
            e instanceof Error &&
            e.name === 'ToolException' &&
            !request.runtime?.signal?.aborted
          ) {
            debugLog(`Softened MCP tool error into an error ToolMessage: ${e.message}`);
            return new ToolMessage({
              content: e.message,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tool_call_id: (request.toolCall as any)?.id ?? '',
              status: 'error',
            });
          }
          throw e;
        }
      },
    });

    // Debug-capture middleware (TUI `/debug` panel); the contract lives in core's debugCapture.
    // Always installed but lazy: it reads `this.debugCapture` per call, so until the TUI attaches a
    // sink it is a transparent pass-through (one extra await around the handler — the normal path
    // pays nothing). `request.messages` is the real history at call time; `handler(request)`
    // resolves to the AIMessage response. Without this, the TUI's System-prompt/Tools/Chat-history
    // tabs stay empty on the (now default) lean backend.
    const getDebugCapture = () => this.debugCapture;
    const debugCaptureMiddleware = createMiddleware({
      name: 'GthMiddlewareDebugCapture',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapModelCall: async (request: any, handler: any) => {
        // GS2-56: stash the always-on last-model-request snapshot (extras + as-sent messages)
        // UNCONDITIONALLY — before the `capture` short-circuit — so `/debug-dump` has the full
        // model input even when no TUI `/debug` sink is attached (a non-TUI surface, or `/debug`
        // never opened). Guarded: snapshotting must never break the run. The computed extras are
        // reused for the sink below so extraction runs once.
        let extras: DebugRequestExtras | undefined;
        try {
          extras = extractDebugRequestExtras(request);
          this.setLastModelRequest(request.messages, extras);
        } catch {
          /* the always-on snapshot must never break the run */
        }
        const capture = getDebugCapture();
        if (!capture) return handler(request);
        try {
          capture.onRequest?.(request.messages, extras);
        } catch {
          /* a debug sink must never break the run */
        }
        const response = await handler(request);
        try {
          capture.onResponse?.(response);
        } catch {
          /* a debug sink must never break the run */
        }
        return response;
      },
    });

    // shellExitSoftening FIRST so it is the outermost wrapToolCall — it must see the raw
    // ShellCommandFailedError throw before any user-configured middleware could transform it.
    // mcpToolErrorSoftening sits right after it, still outboard of any user-configured middleware so
    // it sees the raw ToolException before a user wrapToolCall could transform it. Order between the
    // two softeners is not load-bearing: they catch DISJOINT conditions (a ShellCommandFailedError
    // vs a name==='ToolException') and each rethrows what it doesn't recognize, so neither can
    // swallow the other.
    // EXT-35: toolCallRepairMiddleware sits AFTER toolCallStatusMiddleware in the array. afterModel
    // nodes execute in reverse array order (the later one runs first), so repair runs BEFORE the
    // status middleware — a promoted call is therefore reported by the "Requested tools:" line too.
    // Correctness (routing) is order-independent: the router reads final graph state after all
    // afterModel nodes, and repair replaces-by-id, so the promoted tool_calls are present regardless.
    // GS2-36: cap a self-inflicted tool-error loop. The shell/MCP softeners above turn a failed
    // run_*/MCP call into a status:'error' ToolMessage the model observes; a model that keeps
    // re-issuing the same failing call would drain tokens turn after turn. This beforeModel guard
    // ends the run gracefully once MAX_CONSECUTIVE_TOOL_ERRORS such results accrue with no successful
    // tool result in between — a tighter, error-specific complement to createAgent's coarse
    // recursionLimit (loop DETECTION proper is the separate EXT-36). Placed after the softeners and
    // before user middleware so it can't be bypassed. Lean backend only (per GS2-36 scope); the deep
    // backend keeps its own recursionLimit backstop.
    // [[EXT-159]] — the halt sink records WHY the run ended on the agent, where the runner reads it.
    const toolErrorBudget = createToolErrorBudgetMiddleware(undefined, (reason) =>
      this.noteTermination(reason)
    );

    // EXT-36: the ORTHOGONAL loop guard — repeated identical (tool, args) / no-progress detection,
    // the sibling of GS2-36's error budget above. It catches the case GS2-36 explicitly leaves open:
    // a model re-issuing the SAME call verbatim, whether it keeps erroring or keeps "succeeding" with
    // the same result. Placed at index 3, immediately AFTER toolErrorBudget (index 2) and BEFORE user
    // middleware: beforeModel hooks run in forward order with jumpTo short-circuiting, so on a
    // simultaneous trip GS2-36's coarse error cap wins first and EXT-36 fires on its own
    // signature-repeat threshold otherwise; keeping it outboard of user middleware means it can't be
    // bypassed. WARN is on by default and SURFACES a user notice WITHOUT touching state.messages (the
    // default path must never mutate the model's input — appending a message + re-invoking is a
    // provider-unsafe steer, not a warn); HALT (opt-in) actively breaks the loop via a terminal
    // jumpTo:'end'. Default WARN-ON is applied here at the read site (resolveToolLoopGuardOptions),
    // NOT in DEFAULT_CONFIG, so the
    // effective-config snapshot never churns.
    // `toolLoopGuard: false` resolves to a no-op guard (still installed at index 3 so the
    // placement is stable).
    const toolLoopGuard = createToolLoopGuardMiddleware(
      resolveToolLoopGuardOptions(this.config.toolLoopGuard),
      // WARN surfaces through the same TUI-safe status channel every other agent notice uses
      // (renderer-consumed, never raw stdout) so it can't leak over the Ink frame (TUI-C31).
      (message) => statusUpdate(StatusLevel.WARNING, message),
      // [[EXT-159]] — HALT ends the run, so it owes a reason; WARN does not end anything and sets
      // none.
      (reason) => this.noteTermination(reason)
    );

    // EXT-160: the PRE-CALL context guard. Installed UNCONDITIONALLY, and inert on every provider
    // no window source is wired for — `resolveContextWindowSource` answers `null` there, and a null
    // window never triggers. Wiring it that way rather than behind an `if (provider === 'ollama')`
    // is what makes "unknown window ⇒ no compaction" the production default for nine of ten
    // providers instead of a path only a test ever walks, and leaves [[EXT-161]] a pure addition in
    // one file.
    //
    // The summariser is bound DIRECTLY to the session model — `createModelSummarizer` calls
    // `model.invoke`, not the graph — because a summary routed through the graph would re-enter
    // this same `beforeModel` hook. The system prompt is read through a closure because the
    // middleware array below is assembled before the prompt is composed further down.
    let systemPromptCharacters = 0;
    const sessionModel = this.config.llm;
    // The output headroom the user actually configured, when they configured one: on ollama
    // `num_predict` caps the generation, so it is the true answer budget and a better number than
    // any default. Absent, the default stands.
    //
    // Both are clamped to a fraction of the window — that is what stops a small `num_ctx` reserving
    // its whole budget — but not to the SAME fraction, and the difference is deliberate: a number
    // the user set is honoured up to half the window, the default only to a quarter. So a
    // configured `numPredict` can still be reduced, and above half the window it is.
    const configuredNumPredict = (sessionModel as { numPredict?: number } | undefined)?.numPredict;
    const contextGuard = createContextGuardMiddleware({
      windowSource: resolveContextWindowSource(sessionModel),
      compact: (messages) =>
        compactMessages({ messages, summarize: createModelSummarizer(sessionModel) }),
      systemPromptCharacters: () => systemPromptCharacters,
      ...(typeof configuredNumPredict === 'number' && configuredNumPredict > 0
        ? { reserve: configuredNumPredict }
        : {}),
      onCompact: (message) => statusUpdate(StatusLevel.INFO, message),
    });

    // EXT-52: gate the opt-in run_shell_command tool behind the per-command approval interrupt —
    // langchain's `humanInTheLoopMiddleware`. Without it,
    // no interrupt ever fires, so the runner's whole approval stack
    // (`GthAgentRunner.decideToolApproval`: sessionYolo → allow-list → judge → human callback,
    // fail-closed reject) was DEAD CODE on lean and shell commands ran unprompted. A matching tool
    // call now suspends the graph with a HITLRequest interrupt; the runner drains it via
    // getPendingToolInterrupts/streamResume (both backend-agnostic in GthAbstractAgent), so ONE
    // gating code path drives the agent and the existing TUI + readline approval prompts fire
    // identically on lean.
    //
    // The gate condition and its user-facing notices are the SHARED policy
    // (`resolveShellApprovalGate`, EXT-12 semantics documented there); the interrupt itself is
    // installed directly as middleware here.
    const { gateShell, notice: shellGateNotice } = resolveShellApprovalGate(
      this.config ?? undefined,
      this.command
    );
    //
    // EXT-80: the shell is not the whole story. At `manual` and `write` every bound tool the
    // rung's access class does not auto-grant — the write built-ins, MCP tools, custom tools — must
    // reach the human, because those two rungs promise the user that anything beyond reading
    // (respectively, beyond reading and writing files here) comes to them.
    //
    // **The interrupt is wired rung-INDEPENDENTLY, over every tool any rung could gate.** It is
    // installed once, here, while `/approvals <rung>` moves the rung for the rest of the session
    // without rebuilding this graph; a set that carried the rung would be frozen at the rung the
    // session started on, and since the default is `assisted`, typing `/approvals manual` would
    // leave exactly the write tools ungated. `GthAgentRunner.decideToolApproval` decides on the rung
    // in force instead, which is where the rung has always been read — so wiring wider does not gate
    // wider: at a rated rung a non-shell call is approved there with no rating call and no prompt.
    //
    // Both sets come from core's shared policy, which the runner also calls, so
    // the two cannot disagree; and both read the FINAL tool array below rather than any
    // static list, because a hand-written list cannot contain an MCP or custom tool, which is
    // exactly what has to escalate.
    const rung = resolveApprovals(this.config ?? undefined, this.command).rung;
    const boundToolNames = tools
      .map((tool) => tool?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    // **What a surface that answers no approval gets — for BOTH sets below.** An interrupt nobody
    // can answer suspends the graph forever: the tool never runs and the client is never asked. So
    // such a surface is wired with exactly what the shell gate itself requires and nothing more,
    // and is not TOLD it will be asked either. Neither the live set nor the interrupt set is a safe
    // fallback here — both are non-empty at `manual` and `write`, which is precisely where an
    // AG-UI server's writes and MCP calls would vanish, or be announced as approvable when nothing
    // will ever approve them.
    const answersApprovals = commandAnswersApprovals(this.command);
    const noDrainTools = gateShell ? [SHELL_TOOL_NAME] : [];
    // The LIVE gated set — what THIS rung gates — for the §4.5 tool descriptions below. Narrower
    // than the interrupt set at the rated rungs, and it must stay so: a description promising an
    // approval the runner will not ask for is the drift §4.5 calls worse than no description.
    const gatedTools = answersApprovals
      ? resolveGatedToolNames({ rung, gateShell, boundToolNames })
      : noDrainTools;
    // Rung-independent ONLY where something answers the interrupt.
    const interruptTools = answersApprovals
      ? resolveInterruptToolNames({ gateShell, boundToolNames })
      : noDrainTools;
    // Installed on the interrupt SET, not on `gateShell`: at a deterministic rung there is a gate to
    // install even when the shell tool is disabled or the command emits no dev tools (a plain
    // `chat` session with MCP servers). Keying the install off `gateShell` there would leave every
    // one of those tools ungated while the rung's description promised otherwise.
    const approvalMiddleware =
      interruptTools.length > 0
        ? [
            humanInTheLoopMiddleware({
              interruptOn: Object.fromEntries(
                interruptTools.map((name) => [
                  name,
                  { allowedDecisions: ['approve', 'reject'] } satisfies InterruptOnConfig,
                ])
              ),
            }),
          ]
        : [];
    if (shellGateNotice) {
      this.statusUpdate(shellGateNotice.level, shellGateNotice.message);
    }

    // EXT-58 (spec §4.5) — state the approvals posture where the model reads it: on the tool
    // descriptions themselves. Every tool NOT auto-approved at the resolved rung gets the rung's
    // sentence appended; every granted tool keeps its description exactly as written, because the
    // ABSENCE of the sentence is what marks it free. `gatedTools` is the LIVE set for the rung in
    // force — narrower than the interrupt set above, which covers every rung so the rung can still
    // move — so a description can never promise an approval this rung will not ask for. Applied
    // after the allowedTools filter and before createAgent, so the model only ever sees the final,
    // suffixed set.
    this.registerApprovalsAwareTools(tools, { rung, gatedTools });

    // EXT-52 placement note: the HITL gate sits EARLY in the array — before user-configured
    // middleware and, crucially, before toolCallRepairMiddleware — because afterModel hooks run in
    // REVERSE array order (the EXT-35 rule above). The gate's afterModel therefore executes LAST,
    // after EXT-35's repair has promoted a text-emitted `run_shell_command` into a native
    // tool_call, so a small local model that serialises the call as text is gated too (were the
    // gate appended last it would run FIRST and a promoted shell call would bypass approval
    // entirely).
    const middleware = [
      shellExitSoftening,
      mcpToolErrorSoftening,
      toolErrorBudget,
      toolLoopGuard,
      // EXT-160: after the two guards and before user middleware. `beforeModel` hooks run forward
      // with `jumpTo` short-circuiting, so a run the error budget or the loop guard is about to end
      // never first pays for a summary call; and outboard of user middleware means it cannot be
      // bypassed, like its two siblings.
      contextGuard,
      ...approvalMiddleware,
      ...configuredMiddleware,
      toolCallStatusMiddleware,
      toolCallRepairMiddleware,
      debugCaptureMiddleware,
    ];

    this.headerStatus(`Loaded middleware: ${middleware.map((m) => m.name).join(', ')}`);

    // GS2-21: compose gsloth's system prompt (backstory + guidelines + per-command mode prompt +
    // system prompt), so identity profiles and `.gsloth.*.md` reach the model.
    // This is passed to createAgent as `systemPrompt`, which langchain applies as the agent's
    // static system message on every turn — NOT injected as a separate mid-conversation
    // SystemMessage (a non-first system message that Anthropic rejects). GS2-79: which mode prompt
    // a command gets is decided ONCE, in core's `readModePrompt` — 'code' the code-mode prompt,
    // 'exec' the exec-mode prompt, 'review'/'pr' the REVIEW INSTRUCTIONS, chat/api/others the chat
    // prompt — so a command left out of the selection can no longer be served the chat prompt by
    // silent default.
    const modePrompt = readModePrompt(this.command, this.config);
    const systemMessages = buildSystemMessages(this.config, modePrompt);
    const baseSystemPrompt =
      typeof systemMessages[0]?.content === 'string' ? systemMessages[0].content : undefined;

    // GS2-27: in `code` mode append the SHARED code-mode notes — the real-cwd / path-model note
    // (EXT-13) and the OS + shell-dialect note (EXT-26). They are backend-agnostic (they describe
    // the opt-in `run_shell_command` tool and the real-fs cwd), which is why they are composed from
    // core's `systemPromptNotes` rather than inline here. Order: cwd note first, OS/shell note
    // last. `getCurrentWorkDir()` is already read above for the status line, so the value is free.
    // GS2-34/EXT-83: resolve the active model identity ONCE, honouring the `injectModelContext`
    // opt-out (default ON) at this single read site. Both consumers below take this same value, so
    // the commit trailer and the model-context note can never disagree about which model is serving
    // the session — and the opt-out means "my model identity stays out of the prompt", which covers
    // the trailer as much as the identity line.
    const modelIdentity =
      this.config.injectModelContext !== false ? resolveModelIdentity(this.config) : undefined;

    // GS2-35: also append the commit co-authoring rule so the agent credits Gaunt Sloth (config
    // `commit.coAuthor`, defaulting to the Gaunt Sloth account) in the `Co-Authored-By` trailer, and
    // the EXT-83 commit-message rules (plain English, and passed by file — never inline, where the
    // shell would expand the message before git runs). Same code-mode gate as the shell/cwd notes —
    // the git-commit capability rides on `run_shell_command`, which is a code-mode tool.
    // EXT-84: the effective `filesystem` is threaded in so the note names the writing tool only
    // where that tool is registered. `this.config` is the command-merged value (getEffectiveConfig,
    // above) — the SAME value handed to the tool resolver, so the note and the registered toolset
    // cannot disagree.
    const codeNotesPrompt =
      this.command === 'code'
        ? appendCommitCoAuthorNote(
            appendOsShellNote(appendCwdNote(baseSystemPrompt, getCurrentWorkDir())),
            this.config.commit?.coAuthor,
            modelIdentity,
            this.config.filesystem
          )
        : baseSystemPrompt;

    // GS2-34: inject the resolved provider:model identity so the agent knows which model is serving
    // it (to answer "what model are you?" and reason about its own capabilities/limits). Composed
    // OUTSIDE the code-mode gate above — unlike the cwd/os-shell/commit notes, that question can
    // arise in ANY mode (chat/ask/code/exec), so the identity must be visible everywhere. The
    // `injectModelContext` opt-out is applied at the single read site above; when it is off — or
    // when no model resolves — `modelIdentity` is undefined, nothing is appended, and the prompt is
    // exactly as before. GS2-6's capability note is a deferred follow-up (bare provider:model
    // identity only for now).
    const modelContextPrompt = appendModelContextNote(codeNotesPrompt, modelIdentity);

    // EXT-32: inject each connected MCP server's discovery `instructions` (captured during tool
    // resolution) into the prompt — fenced + per-server-labelled as untrusted server-provided
    // context. Mode-independent: MCP tools load in every mode, so their usage guidance applies in
    // every mode (not just `code`). Empty/absent capture (or a resolver without the accessor) adds
    // nothing. Composed through the shared path in core so any backend reaches it alike.
    // When tools are disabled, resolveTools is skipped entirely (no MCP contact), so a REUSED
    // resolver could still hold a prior run's capture — gate on toolsDisabled so no stale
    // instructions leak into a tools-disabled session.
    const mcpInstructions = toolsDisabled
      ? []
      : (this.resolvers?.getMcpServerInstructions?.() ?? []);
    const systemPrompt = appendMcpServerInstructionsNote(modelContextPrompt, mcpInstructions);
    // EXT-160: the guard above reads this through its closure. `createAgent` applies the system
    // prompt on every call without ever putting it in `state.messages`, so without this the guard
    // would under-count each request by its largest single block.
    systemPromptCharacters = systemPrompt?.length ?? 0;

    // Create agent with configured middleware. Only pass systemPrompt when non-empty so we never
    // hand createAgent an empty system message.
    this.agent = createAgent({
      model: this.config.llm,
      tools,
      middleware,
      checkpointer,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    debugLog('React agent created successfully');
  }
}
