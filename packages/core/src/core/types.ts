import type { GthConfig } from '#src/config.js';
import type { DeclaredToolAnnotations } from '#src/core/approvals/annotations.js';
import type { ApprovalSubject } from '#src/core/approvals/matcher.js';
import type { RaterNegotiationRound, ShellSafetyVerdict } from '#src/core/shell/rater.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { IterableReadableStream } from '@langchain/core/utils/stream';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

/**
 * The approval and shell types this module's own surface is written in, re-exported so a consumer
 * of the root barrel can NAME each of them. Every one is the declared type of something already
 * reachable here — {@link PendingToolInterrupt}'s `subject`, `safetyVerdict` and
 * `negotiationRounds`, and {@link GthAgentInterface#getDeclaredMcpToolAnnotations} — so without
 * them an embedder receives values it cannot type, which is precisely what writing a typed
 * {@link ToolApprovalCallback} asks of it.
 *
 * They stay declared where they are: the matcher owns the subject it matches on and the rater owns
 * the verdict it returns, so a type moved here to become exportable would sit apart from the code
 * that decides it. The re-export is type-only and erases at emit, so the barrel gains no runtime
 * edge.
 *
 * The two modules' **runtime** surface is deliberately not re-exported, including the closed
 * vocabularies `RATER_OUTCOMES` and `ShellSafetyVerdictSchema` that {@link RaterOutcome} and
 * {@link ShellSafetyVerdict} are derived from: a type alias resolves its referent inside the
 * declaration file it is emitted into, so naming either type needs neither value in scope. Values
 * stay reachable at their own deep paths (`@gaunt-sloth/core/core/shell/rater.js`,
 * `@gaunt-sloth/core/core/approvals/matcher.js`) at the usual deep-path risk.
 *
 * `packages/core/spec/coreBarrelTypeSurface.spec.ts` pins this: it type-checks a probe against the
 * built `dist/` declarations, so dropping a name here fails as a named missing export rather than
 * as a later consumer's problem.
 */
export type { DeclaredToolAnnotations } from '#src/core/approvals/annotations.js';
export type {
  ApprovalSubject,
  McpToolApprovalSubject,
  ShellApprovalSubject,
  ToolApprovalSubject,
} from '#src/core/approvals/matcher.js';
export type {
  RaterNegotiationRound,
  RaterOutcome,
  ShellSafetyVerdict,
} from '#src/core/shell/rater.js';

export type Message = BaseMessage;

export type StatusUpdateCallback = (level: StatusLevel, message: string) => void;

/**
 * Status level for logging and output control.
 * Levels are ordered by importance, with lower ordinal values being more verbose.
 * DEBUG (0) is the most verbose, STREAM (6) is the least verbose.
 */
export enum StatusLevel {
  DEBUG = 0,
  INFO = 1,
  DISPLAY = 2,
  SUCCESS = 3,
  WARNING = 4,
  ERROR = 5,
  STREAM = 6,
}
export type GthCommand = 'ask' | 'pr' | 'review' | 'chat' | 'code' | 'api' | 'exec';

/**
 * GS2-16 — per-run analytics harvested from a finished agent turn, threaded into the opt-in
 * history recorder ({@link recordSessionSafe}) so `gth insights` reports real numbers instead of
 * zeros. All fields are best-effort: token counts are only present when the provider actually
 * reported `usage_metadata` (otherwise omitted so the recorder stores NULL and the insights
 * formatter suppresses the misleading `0`), and `tools` lists the names of tools invoked during
 * the run (deduplicated, order-insensitive). There is no `costUsd` — cost requires a reliable
 * price table this project does not carry, so it is deliberately never invented here.
 */
export interface GthRunStats {
  /** Total prompt/input tokens across the run's LLM calls, when the provider reported usage. */
  tokensInput?: number;
  /** Total completion/output tokens across the run's LLM calls, when the provider reported usage. */
  tokensOutput?: number;
  /** Names of tools invoked during the run (deduplicated); empty when no tools were used. */
  tools: string[];
  /**
   * BATCH-21 — one record per executed tool result (`ToolMessage`) observed during the run, in
   * arrival order and NOT deduplicated (a tool called twice yields two records), so `gth eval`'s
   * tool-RESULT assertions (`must_error` / `tool_result_json_path`) can grade what a tool
   * *returned*, not just that it was called. Optional (additive): producers that predate the field
   * simply omit it; {@link runStats.js finalizeRunStats} always sets it.
   */
  toolResults?: GthToolResult[];
}

/**
 * BATCH-21 — one executed tool call's result, harvested from its `ToolMessage` by the GS2-16
 * run-stats accumulator (`core/runStats.ts`). Fail-soft like everything else there: `content` is
 * omitted when no text payload could be derived, and is size-capped
 * ({@link runStats.js TOOL_RESULT_CONTENT_CAP}) so a giant payload can't bloat run stats.
 */
export interface GthToolResult {
  /** The tool that produced the result (`ToolMessage.name`). */
  name: string;
  /** `true` iff the result carried LangChain's real error signal (`ToolMessage.status === 'error'`). */
  isError: boolean;
  /** The result payload as text (a non-string payload is JSON-stringified), capped in length. */
  content?: string;
}

/**
 * Typed events emitted by the agent's {@link GthAgentInterface#streamWithEvents} path.
 * This is the renderer contract shared by every consumer of an agent run — the AG-UI
 * SSE encoder, the (future) TUI, and any embedder — so it is intentionally agnostic of
 * how the underlying graph was built (lean `createAgent` or `createDeepAgent`).
 */
export type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning_start' }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'reasoning_end' }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_args'; id: string; delta: string }
  | { type: 'tool_end'; id: string }
  | {
      /**
       * TUI-C17 — one live output chunk from an EXECUTING tool (a custom/dev toolkit child
       * process's stdout/stderr, or its "Executing …" announcement), surfaced through the managed
       * event stream instead of raw `process.stdout` so a renderer (the Ink TUI) can fold it into
       * its view-model. Emitted by the tool-output channel merge
       * (see `core/toolOutputChannel.js#mergeToolOutputIntoEvents`), NOT by `processEventStream`
       * itself — consumers that don't opt into the merge (e.g. the AG-UI SSE encoder) never see it
       * and the toolkits keep writing to stdout for them (today's headless behaviour).
       */
      type: 'tool_output';
      /**
       * The tool call this chunk belongs to (LangChain's `ToolRunnableConfig.toolCall.id`,
       * threaded through the toolkits), so a renderer can nest output under the exact call —
       * TUI-C30 consumes this for per-call output previews. Optional only defensively: absent
       * when the executing framework did not supply a tool call, in which case consumers should
       * fall back to `name` attribution.
       */
      id?: string;
      /** The gth tool name (e.g. `run_shell_command`, a custom tool's name). Always known. */
      name: string;
      /** One verbatim streamed chunk of the child's stdout/stderr (or the notice text). */
      chunk: string;
      /**
       * True when this chunk is the "🔧 Executing …" announcement rather than child output, so
       * a richer renderer (TUI-C30) can style or strip it when previewing raw output lines.
       */
      isNotice?: boolean;
    }
  | {
      type: 'tool_result';
      id: string;
      content: string;
      /**
       * True when the underlying `ToolMessage.status` is `'error'` (LangChain's real
       * tool-result error signal). Absent/undefined means success — consumers must not
       * sniff the result text to infer failure. Optional for backward compatibility with
       * producers that predate the field.
       */
      isError?: boolean;
      /**
       * [[TUI-C69]] §5.4 — **this result is the auto-rater asking the agent to narrow the call,
       * not a tool that failed.** A round-1 rejection is the middle of a working negotiation, and
       * on the happy path the very next round succeeds.
       *
       * **Additive, and {@link isError} stays true beside it.** The error status is the real
       * LangChain signal and three readers grade on it — the model, which must know the call did
       * not run; `gth eval`'s `must_error` tool-result assertions; and the ACP bridge's
       * `failed` status. Clearing it to fix the rendering would quietly rewrite all three. This
       * field is display-only: it says how to TONE the row, never what happened to the call.
       *
       * Set from the gate's own decision, threaded on the call's id — never from the result text,
       * because legitimate output may begin with "Error handling…".
       */
      raterClarification?: boolean;
    };

/**
 * The minimal structural surface of a compiled LangGraph agent that the shared agent
 * plumbing in {@link GthAbstractAgent} drives. Both `createAgent` (lean) and
 * `createDeepAgent` return graphs that satisfy this, so the base class can stream/invoke
 * either without knowing which builder produced it. Inputs are intentionally loose
 * (`any`) so concrete builder return types assign without casts; the base re-applies
 * precise typing at the point of use via `AIMessage`/`AIMessageChunk` guards.
 */
export interface GthCompiledGraph {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(input: any, config?: RunnableConfig): Promise<{ messages: BaseMessage[] }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream(input: any, config?: any): Promise<IterableReadableStream<any>>;
  /**
   * Read the checkpointed graph state for a thread. Present on LangGraph compiled graphs
   * (both `createAgent` and `createDeepAgent`); used to detect a graph suspended on a
   * human-in-the-loop `interrupt()` (its pending {@link PendingToolInterrupt} lives in
   * `state.tasks[].interrupts[].value`). Optional because the structural surface predates it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getState?(config: RunnableConfig): Promise<any>;
}

/**
 * A single tool call a human-in-the-loop interrupt is waiting on, surfaced from the
 * suspended graph state so a consumer (the interactive session) can render an approve/reject
 * prompt. Mirrors LangChain's HITL `ActionRequest` (tool name + the args it would run with).
 */
export interface PendingToolInterrupt {
  name: string;
  args: Record<string, unknown>;
  /**
   * [[TUI-C69]] §5.4 — **the LangChain `tool_call` id this interrupt is holding**, so a decision
   * about the call can be attributed to the call on screen.
   *
   * LangChain's HITL `ActionRequest` is `{ name, args, description }` and carries no id, so the
   * suspended-state reader recovers it from the AI message the requests were built from: the
   * same `getState` snapshot that holds `tasks[].interrupts` also holds `values.messages`, whose
   * last `AIMessage` carries the very `tool_calls` the middleware filtered. Matched back by name
   * and arguments within that one message, in order, so it is the call's own id rather than a
   * correlation.
   *
   * **It is a display attribution, never a decision input.** Nothing about whether a call is
   * allowed may read it: the gate decides on the command and the subject, and an id is neither.
   * Optional because the recovery is defensive at every step — an unexpected state shape yields an
   * interrupt with no id, and every consumer of the id treats its absence as "attribute nothing".
   */
  id?: string;
  /**
   * [[TUI-C67]] — **what kind of call this is, as the gate itself decided it** (§3.1/§4.7.5): a
   * `shell` subject carrying the command, a `tool` subject, or an `mcpTool` subject carrying the
   * user's own `mcpServers` key. It is the discriminator `decideToolApprovalInner` matched rules
   * on, travelling to the surface so the prompt can branch on the same one.
   *
   * Both terminal approval surfaces used to open with *the agent wants to run a shell command*,
   * which EXT-80 made false for the most common prompt in `manual` and `write` — a file write, an
   * MCP call or a custom tool, each announced as a shell command.
   * `core/approvals/promptHeader.ts` renders the sentence from this field for both of them;
   * re-deriving the kind from {@link name} on each surface would be a second classifier, free to
   * disagree with the one that gated the call.
   *
   * **The ACP server is currently that second classifier, and the rule above still stands.**
   * `acpPermissions.ts` titles its permission request from its own `shellCommandOf`, keyed on
   * {@link name} rather than on this field, which it never reads — a divergence pinned by an
   * assertion in `packages/agent/spec/acpServer.spec.ts`. Closing it means reading this field there
   * rather than the tool name, and that is [[TUI-C89]]'s work; do not read the divergence's
   * existence as licence to re-derive the kind anywhere else.
   *
   * **The runner attaches it to every interrupt it hands the approval callback**, including the
   * plainest case where nothing else on this interface is set. Optional only because an interrupt
   * read back out of graph state (`getPendingToolInterrupts`) is assembled before any subject
   * exists; a surface that renders through `promptHeader` and is handed one of those renders the
   * generic tool sentence, never a wrong one.
   */
  subject?: ApprovalSubject;
  /**
   * CFG-26 — when the AI rater escalated this `run_shell_command` to the human (rather than
   * approving it or bouncing it back to the model), the rater's verdict is attached here so the
   * approval surface can show an "AI rater (<tier>): <reason>" notice. Absent when the rater is
   * off, or when the command reached the human without being rated.
   */
  safetyVerdict?: ShellSafetyVerdict;
  /**
   * EXT-71 §3.2 — when this call reached the human because a declared `approvals.escalate` entry
   * matched it, the entry that fired, rendered for display. It is the provenance the prompt shows:
   * an escalation the user cannot trace to the line they wrote reads as the gate malfunctioning.
   * Absent whenever the escalation came from the rung or the rater instead.
   */
  escalatedBy?: string;
  /**
   * EXT-71 §6 — **what a sticky choice will store**, rendered in the object form the user would
   * write in a config file, e.g. `{ "type": "shell", "matcher": "exact", "pattern": "npm test" }`.
   * The menu MUST show this at the moment of the choice, on every surface: the user is shown the
   * thing they are agreeing to rather than a generalization of it, which is what makes the display
   * honest and cheap at once.
   *
   * **For a tool call the stored thing is the tool, not the arguments** (§4.7.4), so this reads
   * e.g. `{ "type": "mcpTool", "server": "fetcher", "matcher": "exact", "pattern": "fetch_url",
   * "host": "docs.internal.example" }`. That is the one place a grant is deliberately broader than
   * what the human was shown, which is why the display carries the most weight there.
   *
   * Absent exactly where no sticky grant is on offer — a `catastrophic` outcome (§4.2 withdraws
   * the persistent grants), a rung that remembers nothing, a command that does not statically
   * resolve, or a tool call naming more than one host (which has no honest single-host entry) — so
   * a prompt never advertises a control that has already been withdrawn.
   */
  grantPreview?: string;
  /**
   * §6 — **the same grant in the words a menu control is written in**: `npm test` for a shell
   * command, `tool gth_web_fetch (host docs.internal.example)` or `mcpTool jira/create_issue` for a
   * tool call. It is what the *always approve* control names, so the control reads as
   * *always approve this tool for this host* rather than as a bare key.
   *
   * It is rendered by `describeApprovalEntry` — the one-liner every other provenance message uses,
   * including the §4.7.4 notice that later withdraws the grant. Sharing the renderer is the point:
   * a menu that describes a grant differently from the notice that withdraws it is how a user stops
   * trusting either.
   *
   * Present exactly when {@link grantPreview} is, since both are rendered from the one entry
   * `recordApproval` would write.
   */
  grantSummary?: string;
  /**
   * [[TUI-C26]] §6 — **what the menu's *always reject* choice will record**, in the object form the
   * user would write in a config file. The deny mirror of {@link grantPreview}, shown at the moment
   * of the choice for the same reason: a control that does not say what it stores is one the user
   * has to guess at.
   *
   * **Its availability is NOT the grant's**, and reading one off the other is the mistake this
   * field exists to prevent. The matcher's own rule is *undecidable → no match on the allow side, a
   * match on the deny side*, so a command the gate cannot statically resolve **can** be refused
   * permanently even though it can never be allowed permanently. `always reject` also stays offered
   * on a `catastrophic` verdict, where §4.2 withdraws every sticky grant: sticky refusal is safe in
   * every direction, and it is only the grant that is ever made harder.
   *
   * Absent only where the entry grammar cannot hold one at all — today, an MCP call whose server
   * could not be attributed (the grammar's `server` cannot be empty). Absent means the control is
   * **not offered**, never offered-and-disabled.
   */
  denyPreview?: string;
  /**
   * §6 — the same deny entry in the words the control is written in, through the one-liner every
   * other provenance message uses. Present exactly when {@link denyPreview} is, since both are
   * rendered from the one entry the runner would record.
   */
  denySummary?: string;
  /**
   * [[EXT-29]] §6 — **every round of the §5 negotiation that preceded this escalation**, oldest
   * first, when one did.
   *
   * The user is not asked to rule on the final command in isolation: *that the agent proposed
   * `git reset --hard origin/main` three times unchanged, against two rejections that each told it
   * what to fix, is itself the most important thing on the screen, and it is invisible if only the
   * last attempt is shown.* `core/shell/negotiation.ts`'s `renderNegotiationTranscript` is the
   * shared renderer, so two surfaces cannot describe one exchange two ways.
   *
   * Absent for every escalation that had no negotiation — `catastrophic` (§4.2 gives it no rounds
   * at all), a declared `approvals.escalate` entry, an unrated rung, a tool subject.
   */
  negotiationRounds?: readonly RaterNegotiationRound[];
  /**
   * [[EXT-29]] §5.3 — **how many attempts the agent actually made**, counted since a human was last
   * involved rather than since the last approved call.
   *
   * Persistence is the single most decision-relevant fact this block carries, and it is measured
   * against a real under-report: on the escalation this comes from, the agent proposed the same
   * command five times, was refused every time, and the human was shown three, because the two
   * approved calls it made in between (`git stash`, `git status`) each erased the rounds before
   * them. [[EXT-108]] removed that erasure, so the array and this count are now the same set as
   * they leave the state machine.
   *
   * It stays a separate number for the reason that survives: both values are handed over whole and
   * the renderer is what slices for the screen, so sending both is what lets it number the rounds it
   * prints by their true attempt number instead of from one.
   *
   * Present exactly when {@link negotiationRounds} is, and never smaller than its length.
   */
  negotiationAttempts?: number;
}

/**
 * Persistence scope for an `approve` decision (spec §6):
 * - `once`    — run this single invocation only; remember nothing (the default).
 * - `session` — remember **this command**, as an `exact` entry (§3.1), for the life of this runner
 *   instance, so the same command stops re-prompting. A longer variant of it still asks: the menu
 *   never widens, and breadth is something a human writes in a config file.
 * - `always`  — additionally persist that entry to the project store
 *   (`.gsloth/.gsloth-settings/shell-allowlist.json`) so it survives across runs.
 */
export type ToolApprovalScope = 'once' | 'session' | 'always';

/**
 * §6 — persistence scope for a `reject` decision, the *always reject* half of the escalation menu:
 * - `once`    — refuse this single invocation; remember nothing (the default).
 * - `session` — additionally record a **deny** entry for this call, in the one entry grammar, for
 *   the life of this runner instance. The matcher consults it before anything else, so the next
 *   identical call is refused without reaching a person at all.
 *
 * **There is deliberately no `always`.** An `approve` can persist because there is a project store
 * to persist it to; there is no persisted deny store, and inventing one is a decision about a file
 * users will have to live with rather than a rendering choice. So the scopes here are the ones the
 * gate can actually honour, and a control that promised more would be §6's own failure mode — an
 * affordance offered and then quietly refused.
 */
export type ToolRejectScope = 'once' | 'session';

/**
 * A consumer-supplied decision on a {@link PendingToolInterrupt}: approve runs the tool,
 * reject feeds the model a tool-rejected message (with the optional reason).
 *
 * Each arm carries an optional scope; when absent it means `once` (backward compatible — a bare
 * `{ type: 'approve' }` or `{ type: 'reject' }` still type-checks and behaves as the single-shot
 * decision that persists nothing).
 *
 * The two scopes are **different types on purpose**. Sharing {@link ToolApprovalScope} would let a
 * surface send `{ type: 'reject', scope: 'always' }`, which type-checks, promises a persistence
 * nothing implements, and degrades to a session refusal with no diagnostic.
 */
export type ToolApprovalDecision =
  | { type: 'approve'; scope?: ToolApprovalScope }
  | { type: 'reject'; message?: string; scope?: ToolRejectScope };

/**
 * Callback the {@link GthAgentRunner} invokes when a run suspends on a tool-approval
 * interrupt, once per pending tool call. Returns the human's decision. When no handler is
 * wired (e.g. a non-interactive run), the runner defaults to reject so a run can never
 * silently hang or auto-approve.
 */
export type ToolApprovalCallback = (
  pending: PendingToolInterrupt
) => Promise<ToolApprovalDecision> | ToolApprovalDecision;

/**
 * [[TUI-C68]] §6.1 — what the **attack banner** is about: the command whose own structure the
 * rater called hostile, and the rater's explanation of what it saw. Both are untrusted text and a
 * surface must paint them through `core/shell/framing`.
 *
 * A separate shape from {@link PendingToolInterrupt} because it is a separate question. An approval
 * prompt asks *may this run*, and every control on its menu is a legitimate answer carrying a
 * scope; this asks *do you believe the rating is wrong*, has exactly one way through, and offers no
 * scope at all — so a surface cannot reach for a menu control that does not exist here.
 */
export interface PendingAttackHalt {
  /** The command the rater rated an attack, as the model wrote it. Untrusted text. */
  command: string;
  /** The rater's own explanation of what the command's structure showed. Untrusted text. */
  reason: string;
}

/**
 * §6.1 — the human's answer at the attack banner.
 *
 * **A string union rather than a boolean, and the polarity is deliberate.** `run-anyway` is the
 * only value that runs anything; every other value — one a future surface invents, or `undefined`
 * from a surface that forgot to return — stops the run. A boolean would put the irreversible answer
 * one inverted comparison away, and there is nothing here worth being one typo from.
 */
export type AttackHaltAnswer = 'run-anyway' | 'stop';

/**
 * §6.1 — callback the {@link GthAgentRunner} invokes when the rater rates a command an `attack`, so
 * an interactive surface can show the red banner and let a human type their way past it.
 *
 * **Absent means halt**, exactly as an absent {@link ToolApprovalCallback} means the §6.2
 * non-interactive exit. A surface that never wires this — a CI run, an AG-UI server, a surface
 * nobody has written yet — keeps the halt, so forgetting fails safe. It may never block a
 * non-interactive run, and no timeout turns waiting into a grant: waiting is something only a wired
 * surface can cause.
 */
export type AttackHaltCallback = (
  halt: PendingAttackHalt
) => Promise<AttackHaltAnswer> | AttackHaltAnswer;

/**
 * GS2-95 — options for {@link GthAgentInterface#init} that name the run without changing how it
 * behaves.
 */
export interface GthAgentInitOptions {
  /**
   * The name of the command the USER typed, for the run header only (`eval`, `batch`, `workflow`,
   * `gth-batch`). Supplied by the command; the agent never invents it.
   *
   * It is a SEPARATE input from `command` because `command` is not a label: it selects the mode
   * prompt (`readModePrompt`), the per-command approvals posture and the command-specific
   * filesystem config. A command that runs its work through another verb's prompt — `gth eval`
   * through `ask`, `gth batch` through `exec` — must be able to say its own name without moving the
   * prompt it runs under. Omitted, the header falls back to the init verb, which is the right
   * answer for every command whose verb IS its name.
   */
  displayCommand?: string;
}

export interface GthAgentInterface {
  init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointSaver?: BaseCheckpointSaver | undefined,
    options?: GthAgentInitOptions
  ): Promise<void>;

  invoke(messages: Message[], runConfig: RunnableConfig): Promise<string>;

  stream(messages: Message[], runConfig: RunnableConfig): Promise<IterableReadableStream<string>>;

  /**
   * Stream the run as typed {@link AgentStreamEvent}s. If a client tool triggers
   * `interrupt()` the underlying graph suspends; this generator ends cleanly so the
   * transport can finish the run with the tool call hanging. Resume via
   * {@link streamWithEventsResume} on the same `thread_id`.
   */
  streamWithEvents(
    messages: Message[],
    runConfig: RunnableConfig,
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent>;

  /** Resume a graph suspended via `interrupt()` with the supplied value. */
  streamWithEventsResume(
    resumeValue: unknown,
    runConfig: RunnableConfig,
    queuedMessages?: BaseMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent>;

  /**
   * Resume a graph suspended on a human-in-the-loop `interrupt()` and stream the continuation
   * as text (the string counterpart to {@link streamWithEventsResume}, for the readline path).
   * Optional: only implemented by agents that support tool-approval interrupts.
   */
  streamResume?(
    resumeValue: unknown,
    runConfig: RunnableConfig
  ): Promise<IterableReadableStream<string>>;

  /**
   * Inspect the checkpointed state for the thread and return any tool calls currently pending
   * human approval (empty when the run completed normally). Optional: only implemented by
   * agents whose graph exposes `getState`. Used by {@link GthAgentRunner} to drive the
   * approve/reject confirmation loop.
   */
  getPendingToolInterrupts?(runConfig: RunnableConfig): Promise<PendingToolInterrupt[]>;

  /**
   * [[TUI-C69]] §5.4 — **name the tool calls the auto-rater bounced back for clarification**, so
   * both display paths can tone those rows as a negotiation round rather than as a failed tool.
   *
   * Called by {@link GthAgentRunner} with the id of a call it has just refused BACK TO THE MODEL
   * under §5 — never for a human's "no", a deny entry or the §8 floor, which are refusals rather
   * than rounds of an argument. The agent holds the ids only until the results carrying them have
   * been rendered — {@link clearRaterClarifications} is what makes that true — and a run that never
   * negotiates never calls this.
   *
   * Optional: an agent that renders nothing simply omits it, and every row keeps today's tone.
   */
  noteRaterClarification?(toolCallId: string): void;

  /**
   * [[TUI-C69]] §5.4 — **drop the ids {@link noteRaterClarification} collected**, at the top of
   * every turn and on `/clear`.
   *
   * The runner owns the *when* because it owns the turn; the agent owns the set because it owns the
   * rendering. Without this the ids live as long as the process, and a later call reusing one would
   * be drawn as a negotiation round it had no part in.
   *
   * Optional and fail-soft, like its sibling: an agent that never notes anything need not implement
   * it.
   */
  clearRaterClarifications?(): void;

  /**
   * EXT-58 (spec §4.4) — the names of the tools registered with the graph at `init`. The runner
   * intersects them with the built-in summaries table to tell the rater which already-granted
   * built-ins it may offer as an alternative, so a suggestion can never name a tool the model does
   * not have. Optional: an agent that does not track its tools simply omits it, and the rater then
   * receives no granted list (and so suggests nothing).
   */
  getRegisteredToolNames?(): string[];

  /**
   * EXT-70 (spec §4.7.1) — what the connected MCP servers declared about their own tools in their
   * `tools/list` responses, keyed by the REGISTERED tool name (`mcp__<server>__<tool>`). The runner
   * reads it as the `mcp` half of a declared-annotation lookup when it computes a call's effective
   * annotation set.
   *
   * These are **claims, not credentials**: nothing here has been trusted, and an entry only becomes
   * load-bearing where the user's `approvals.mcp` block believes that hint from that server.
   * Optional — an agent that tracks no tools omits it, and every tool is then fail-closed, which is
   * exactly what a fully distrustful configuration computes anyway.
   */
  getDeclaredMcpToolAnnotations?(): ReadonlyMap<string, DeclaredToolAnnotations>;

  /**
   * GS2-16 — reset the per-run analytics accumulator so the NEXT turn's token/tool totals start
   * from zero. Called by {@link GthAgentRunner} at each turn boundary (the runner is reused across
   * turns in interactive sessions). Optional: agents that don't collect stats simply omit it.
   */
  resetRunStats?(): void;

  /**
   * GS2-16 — the analytics harvested from the run(s) since the last {@link resetRunStats}. Used by
   * the runner to thread token/tool data into the opt-in history recorder. Optional; when absent
   * the runner records no analytics for that turn. Reading must never throw.
   */
  getRunStats?(): GthRunStats;

  cleanup?(): Promise<void>;
}

/**
 * Factory that produces a {@link GthAgentInterface} implementation. Injected into
 * {@link GthAgentRunner} so embedders can swap the lean `GthLangChainAgent` (the default, in
 * core) for another graph builder without core ever importing it.
 */
export type GthAgentFactory = (
  statusUpdate: StatusUpdateCallback,
  resolvers?: AgentResolvers
) => GthAgentInterface;

export type ToolsResolver = (
  config: GthConfig,
  command?: GthCommand
) => Promise<StructuredToolInterface[]>;
export type ToolsCleanup = () => Promise<void>;

export type MiddlewareResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware: any[] | undefined,
  config: GthConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any[]>;
export type MiddlewareCleanup = () => Promise<void>;

/**
 * EXT-32 — one connected MCP server's discovery `instructions` string (from its MCP `initialize`
 * handshake), paired with the server name it came from. Captured once during tool resolution and
 * reused: injected (fenced + per-server-labelled) into the composed system prompt, and available
 * for [[TUI-C20]]'s MCP debug tab to render the same captured text. Only servers that actually
 * supplied non-empty instructions appear here.
 */
export interface McpServerInstruction {
  /** The configured MCP server name (the key under `config.mcpServers`). */
  server: string;
  /** The server-provided instructions text (trimmed, non-empty). */
  instructions: string;
}

/**
 * A per-server MCP connection failure captured during the most recent {@link ToolsResolver} call.
 * Recorded when a configured MCP server can't be reached (connection/handshake/auth error), so the
 * failure — otherwise a transient `displayWarning` that scrolls away the moment the Ink TUI takes
 * over the screen — can be re-surfaced persistently in the chrome AND named in the /debug MCP tab
 * (which renders per configured server and would otherwise show only a bare "no tools" line, with
 * no hint that the server never connected). Mirrors {@link McpServerInstruction}.
 */
export interface McpConnectionFailure {
  /** The configured MCP server name (the key under `config.mcpServers`). */
  server: string;
  /** A concise, human-readable reason (the underlying connection error's message). */
  reason: string;
}

export interface AgentResolvers {
  resolveTools?: ToolsResolver;
  cleanupTools?: ToolsCleanup;
  resolveMiddleware?: MiddlewareResolver;
  cleanupMiddleware?: MiddlewareCleanup;
  /**
   * EXT-32 — the per-server MCP discovery instructions captured during the most recent
   * {@link ToolsResolver} call (empty when no MCP servers are configured or none supplied
   * instructions). Optional: resolvers without MCP support simply omit it, and the prompt
   * composition treats an absent accessor as "no instructions" (no MCP section is emitted).
   */
  getMcpServerInstructions?(): McpServerInstruction[];
  /**
   * The per-server MCP connection failures captured during the most recent {@link ToolsResolver}
   * call (empty when every configured server connected, or none is configured). Optional: resolvers
   * without MCP support omit it, and callers treat an absent accessor as "no failures". Read by the
   * TUI to surface a persistent notice and to annotate the /debug MCP tab.
   */
  getMcpConnectionFailures?(): McpConnectionFailure[];
}
