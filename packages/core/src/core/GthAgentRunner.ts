import {
  type AllowlistCounts,
  type ApprovalMode,
  GthConfig,
  type ResolvedApprovals,
  resolveApprovals,
} from '#src/config.js';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  AgentResolvers,
  AgentStreamEvent,
  GthAgentFactory,
  GthAgentInterface,
  GthCommand,
  GthRunStats,
  Message,
  PendingToolInterrupt,
  StatusUpdateCallback,
  ToolApprovalCallback,
  ToolApprovalDecision,
} from '#src/core/types.js';
import { GthLangChainAgent } from '#src/core/GthLangChainAgent.js';
import {
  AllowlistStore,
  PersistedAllowlist,
  matchesApproval,
  type ApprovalScope,
} from '#src/core/shell/allowlist.js';
import { classifyCommand } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';
import {
  mapVerdictToAction,
  rateShellCommand,
  type ShellSafetyVerdict,
} from '#src/core/shell/rater.js';
import { resolveRaterModel } from '#src/core/shell/raterModel.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env } from '#src/utils/systemUtils.js';
import { getGslothConfigWritePath } from '#src/utils/fileUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';
import { enhanceVertexUnauthorizedMessage } from '#src/utils/vertexaiUtils.js';
import { RunnableConfig } from '@langchain/core/runnables';
import { getNewRunnableConfig } from '#src/utils/llmUtils.js';
import {
  initDebugLogging,
  debugLog,
  debugLogError,
  debugLogObject,
} from '#src/utils/debugUtils.js';
import { updateCrashContext } from '#src/utils/crashHandler.js';
import { setToolDisplayConfig } from '#src/core/toolDisplay.js';

/**
 * GS2-48 — how many trailing messages of the in-flight turn to hand the crash handler as the
 * transcript tail. A crash file is triage, not the full session, so only the last few messages are
 * kept; they are redacted (GS2-47) by the crash snapshot writer before anything reaches disk.
 */
const CRASH_TRANSCRIPT_TAIL_MESSAGES = 8;

/**
 * Agent simplifies interaction with LLM and reduces it to calling a few methods
 * {@link GthAgentRunner#init} and {@link GthAgentRunner#processMessages}.
 */
export class GthAgentRunner {
  private statusUpdate: StatusUpdateCallback;
  private resolvers: AgentResolvers | undefined;
  private agent: GthAgentInterface | null = null;
  private config: GthConfig | null = null;
  private runConfig: RunnableConfig | null = null;
  private agentFactory: GthAgentFactory;
  /**
   * Consumer hook invoked when a run suspends on a tool-approval interrupt (e.g. the opt-in
   * `run_shell_command` confirmation). Set via {@link setToolApprovalCallback}; when unset the
   * runner REJECTS pending tool calls rather than hanging or auto-approving — the safe default
   * for non-interactive entrypoints (a scripted `exec` run with no TTY to prompt on).
   */
  private toolApprovalCallback: ToolApprovalCallback | null = null;

  /** The command the runner was initialized for; selects which `devTools` config applies. */
  private command: GthCommand | undefined = undefined;

  /**
   * GS2-16 — snapshot of the last turn's analytics (token usage + invoked tools), captured from
   * the agent at {@link cleanup} time. Needed because {@link runSingleShot} reads stats AFTER it
   * has already called `cleanup()` (which nulls the agent); interactive callers read live via
   * {@link getRunStats} before cleanup. Defaults to an empty tally.
   */
  private lastRunStats: GthRunStats = { tools: [] };

  /**
   * CFG-26 — the runtime, session-scoped approval posture, seeded at {@link init} from
   * {@link resolveApprovals} (config + the context defaults matrix) and thereafter switchable for
   * the session by the `/approvals` command family. Because the shell tool stays gated (in
   * `interruptOn`) in interactive `code` mode, this is consulted at the TOP of
   * {@link decideToolApproval}, so a config that pre-selects `bypass` still keeps the tool gated
   * and therefore switchable back mid-session. Never persisted.
   *
   * It does NOT disable the hardline floor — catastrophic commands are still refused at exec time
   * in `GthDevToolkit.executeCommand` under every mode.
   */
  private sessionApprovals: ResolvedApprovals = {
    mode: 'ask',
    rater: { enabled: false, strictness: 'standard', escalate: 'danger' },
    allowlist: true,
    persistAllowlist: true,
  };

  /**
   * EXT-9 Tier-2 session allow-list — approved command prefixes that auto-approve for the
   * life of THIS runner instance. Instance-scoped (not module-global) so concurrent
   * sessions (ACP / AG-UI multi-session) cannot stomp each other's approvals.
   */
  /**
   * CFG-26 — the model the AI rater rates with, when `approvals.rater.profile` names an identity
   * profile. Resolved ONCE at {@link init} (never mid-turn) and handed to `rateShellCommand`;
   * `undefined` means no profile is configured and the rater uses the session model.
   */
  private raterModel: BaseChatModel | undefined;

  private readonly sessionAllowlist = new AllowlistStore();

  /**
   * EXT-9 Tier-2 persisted (`always`) allow-list, loaded lazily on first use from
   * `.gsloth/.gsloth-settings/shell-allowlist.json`. Null until the shell tool is gated
   * and the allow-list is enabled; null also when persistence is disabled by config.
   */
  private persistedAllowlist: PersistedAllowlist | null = null;
  private persistedAllowlistLoaded = false;

  /**
   * @param agentFactory Produces the {@link GthAgentInterface} the runner drives.
   *   Defaults to the lean {@link GthLangChainAgent} (core). `@gaunt-sloth/agent`
   *   passes a factory returning a deep `GthDeepAgent` so the same runner can drive a
   *   `createDeepAgent` graph without core depending on deepagents.
   */
  constructor(
    statusUpdate: StatusUpdateCallback,
    resolvers?: AgentResolvers,
    agentFactory?: GthAgentFactory
  ) {
    this.statusUpdate = statusUpdate;
    this.resolvers = resolvers;
    this.agentFactory =
      agentFactory ?? ((status, agentResolvers) => new GthLangChainAgent(status, agentResolvers));
  }

  /**
   * Register the tool-approval handler the runner calls when a run suspends on a tool-approval
   * interrupt (the interactive readline session wires a y/n prompt here). Pass `null` to clear.
   * Without a handler the runner rejects pending tool calls (see {@link toolApprovalCallback}).
   */
  public setToolApprovalCallback(callback: ToolApprovalCallback | null): void {
    this.toolApprovalCallback = callback;
  }

  /**
   * CFG-26 — switch the session-scoped approval mode (the `/approvals auto|ask|bypass` family).
   * Idempotent; returns the NEW mode so the caller can render a notice. Session-scoped only —
   * nothing is written to config.
   *
   * Switching TO `auto` when no rater is configured would be a lie (auto-mode exists only where
   * the rater does), so it turns the rater on with the resolved defaults.
   */
  public setSessionApprovalMode(mode: ApprovalMode): ApprovalMode {
    this.sessionApprovals = {
      ...this.sessionApprovals,
      mode,
      rater:
        mode === 'auto'
          ? { ...this.sessionApprovals.rater, enabled: true }
          : this.sessionApprovals.rater,
    };
    return this.sessionApprovals.mode;
  }

  /** CFG-26 — the session's current approval posture (mode + rater + allow-list knobs). */
  public getSessionApprovals(): ResolvedApprovals {
    return this.sessionApprovals;
  }

  /**
   * CFG-26 — the allow-list sizes for the `/approvals` display: how many command prefixes the
   * human has trusted this session, and how many are persisted in the project file.
   *
   * READ-ONLY BY CONSTRUCTION: it reports the persisted count only when the store has ALREADY
   * been loaded (or persistence is on and it can be read), and never through a path that would
   * CREATE the store as a side effect of showing a display — a status command must not mutate
   * session state. `always: undefined` therefore means "not loaded / persistence off", which the
   * caller renders as `—` rather than a misleading `0`.
   */
  public getAllowlistCounts(): AllowlistCounts {
    const always =
      this.sessionApprovals.persistAllowlist && this.persistedAllowlistLoaded
        ? (this.persistedAllowlist?.list().length ?? undefined)
        : undefined;
    return { session: this.sessionAllowlist.list().length, always };
  }

  /**
   * Init is split into a separate method. This may create a number of connections,
   * and we'd better have an instance by that moment, for the case things will go wrong,
   * so we can wrap init into try-catch and then call {@link #cleanup} within finally.
   */
  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointSaver?: BaseCheckpointSaver | undefined
  ): Promise<void> {
    this.config = configIn;
    this.command = command;

    // GS2-48 — register the effective config with the crash handler so an uncaughtException /
    // unhandledRejection mid-run captures it in the (redacted) snapshot. Pure data hand-off; no
    // behaviour change.
    updateCrashContext({ config: configIn, modelDisplayName: configIn.modelDisplayName });

    // TUI-C32 residual a — register the live config with the shared tool-display redactor so its
    // secret-literal collection walks INLINE config secrets (a pasted `apiKey`/`token` value), not
    // only env-derived ones. Both surfaces (plain observer + Ink TUI) render through this module.
    setToolDisplayConfig(configIn);

    // CFG-26 — seed the session approval posture from config + the context defaults matrix, so a
    // config that pre-selects `bypass` starts there while the shell tool stays gated (see
    // GthDeepAgent) and therefore remains switchable (`/approvals ask`). Resolved per-command,
    // mirroring where the shell tool is actually emitted; no effect where the tool is ungated.
    this.sessionApprovals = resolveApprovals(configIn, command);

    // CFG-26 — resolve the rater's own model when a profile is named, so the documented mitigation
    // for a weak model ("point approvals.rater.profile at a stronger one") actually takes effect.
    //
    // EAGERLY, here, rather than lazily at first use: `initConfig` re-runs discovery and prints
    // "Activating profile: …", which mid-turn would write raw over the Ink TUI's managed frame,
    // and a broken profile should fail at startup rather than three turns in. It deliberately does
    // NOT catch — a named-but-unusable rater profile is an error, never a silent fallback to the
    // session model (GS2-62).
    //
    // No extra "will the rater actually run?" gate: NAMING a profile is itself what enables the
    // rater (`resolveApprovals` treats an object `rater` as enabled), so `rater.profile` set
    // implies `rater.enabled`, on every command. A one-shot `exec` with an explicitly configured
    // rater really does rate — the defaults matrix is defaults-only, and explicit config beats it
    // everywhere — so there is no wasted load to guard against, and a gate here would be dead
    // code that reads as if it were doing something.
    const raterProfile = this.sessionApprovals.rater.profile;
    this.raterModel = raterProfile ? await resolveRaterModel(raterProfile) : undefined;

    // Initialize debug logging
    initDebugLogging(configIn.debugLog ?? false);
    debugLog(`Initializing GthAgentRunner with command: ${command || 'default'}`);

    this.runConfig = getNewRunnableConfig();

    debugLogObject('Runnable Config', this.runConfig);

    this.agent = this.agentFactory(this.statusUpdate, this.resolvers);

    // Initialize the agent
    debugLog('Initializing agent...');
    await this.agent.init(command, configIn, checkpointSaver);

    debugLog('Agent initialization complete');
  }

  /**
   * processMessages deals with both streaming and non-streaming approaches.
   */
  async processMessages(messages: Message[]): Promise<string> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }

    // GS2-16: start this turn's analytics tally from zero (the runner is reused across turns).
    this.resetRunStats();
    // GS2-48 — record this turn's transcript tail for the crash handler.
    updateCrashContext({ transcriptTail: messages.slice(-CRASH_TRANSCRIPT_TAIL_MESSAGES) });

    debugLog('Processing messages...');
    debugLogObject('Input Messages', messages);

    try {
      // Decision: Use streaming or non-streaming based on config
      if (this.config.streamOutput) {
        // Use streaming
        debugLog('Using streaming mode');
        const stream = await this.agent.stream(messages, this.runConfig);
        let result = '';
        try {
          result = await this.drainTextStream(stream);
          // A run may suspend on one or more tool-approval interrupts (run_shell_command).
          // Resolve them in a loop: each resume can itself suspend again on the next gated
          // tool call, so keep going until the graph completes with no pending interrupts.
          result += await this.resolveToolInterrupts();
        } catch (streamError) {
          // Handle streaming-specific errors
          debugLogError('Stream processing', streamError);
          throw new Error(
            `Stream processing failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`
          );
        }
        debugLog(`Stream completed. Total response length: ${result.length}`);
        // EXT-37: a content-policy refusal (OpenAI content_filter / Anthropic stop_reason=refusal /
        // Bedrock guardrail_intervened) is detected one layer down in GthAbstractAgent — the only
        // place a message's response_metadata is visible — and surfaced there as a clear, non-empty
        // terminal answer. That non-empty result intentionally bypasses this empty-response retry:
        // a refusal is deterministic, so re-invoking the SAME model would only burn a paid call and
        // fail identically. Only a genuinely empty turn reaches the retry below.
        //
        // Fallback-model EXTENSION POINT: hermes tries a *different* model once on refusal (a
        // different model may not refuse). gaunt-sloth has no runtime fallback-model config today
        // (`getCuratedFallbackModel` is init-time per-provider defaulting, not runtime failover), so
        // per YAGNI none is built. When such a config is added, the one-shot fallback belongs where
        // the refusal is detected (GthAbstractAgent.surfaceRefusal): try the fallback model ONCE
        // before surfacing, and never retry the same model.
        // GS2-72: the GS2-36 retry-budget's terminal notice — injected via a jumpTo:'end' STATE
        // update on the lean createAgent graph — is streamed as an AIMessage chunk under
        // streamMode:'messages' (verified on langchain 1.5.x), so it already arrives as a NON-empty
        // `result` above and does NOT reach this fallback. Only a genuinely empty model turn falls
        // through here, where the single retry invoke is the intended recovery. (If a future
        // langchain stops streaming jumpTo-injected messages, the budget notice would drain empty
        // and hit this fallback; GthAbstractAgentTerminalNotice.spec pins the current behaviour.)
        if (result.trim().length === 0) {
          debugLog('Stream produced empty response, retrying once with non-streaming invoke.');
          const fallback = await this.agent.invoke(messages, this.runConfig);
          debugLog(`Fallback non-stream response length: ${fallback.length}`);
          if (fallback.trim().length === 0) {
            throw new Error(
              'Model returned an empty response after tool execution. Try again or switch to a more stable model.'
            );
          }
          return fallback;
        }
        return result;
      } else {
        // Use non-streaming
        debugLog('Using non-streaming mode');
        let result = await this.agent.invoke(messages, this.runConfig);
        // EXT-52 — the SAME interrupt drain the streaming branch does above. A gated
        // `run_shell_command` suspends the graph, so `invoke` returns with the tool-calling
        // AIMessage (empty content) as the last message and the command not yet run. Draining here
        // — BEFORE the empty-response check — is what makes the approval prompt fire and the
        // approved command's output reach the caller on `streamOutput: false`; without it the turn
        // died with the misleading empty-response error, so the check may only see a genuinely
        // empty turn.
        result += await this.resolveToolInterrupts();
        debugLog(`Non-stream response length: ${result.length}`);
        if (result.trim().length === 0) {
          throw new Error(
            'Model returned an empty response. Try again or switch to a more stable model.'
          );
        }
        return result;
      }
    } catch (error) {
      // Handle agent invocation errors
      debugLogError('Agent processing', error);
      const originalMessage = error instanceof Error ? error.message : String(error);
      const enhancedMessage = enhanceVertexUnauthorizedMessage(originalMessage, this.config?.llm);
      throw new Error(
        `Agent processing failed: ${enhancedMessage}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }

  /**
   * Accumulate a text stream into a single string. Extracted so {@link processMessages} and
   * the interrupt-resume loop ({@link resolveToolInterrupts}) drain streams identically.
   */
  private async drainTextStream(stream: AsyncIterable<string>): Promise<string> {
    let result = '';
    for await (const chunk of stream) {
      debugLogObject('Stream chunk', chunk);
      result += chunk;
    }
    return result;
  }

  /**
   * After a streamed run ends, resolve any tool-approval interrupts it suspended on. For each
   * pending tool call the {@link toolApprovalCallback} is consulted (defaulting to REJECT when
   * no handler is wired, so a non-interactive run never hangs or auto-approves); the collected
   * decisions are then sent back via the agent's `streamResume` as a LangChain HITL resume
   * (`{ decisions }`). Because a resumed run can suspend again on the next gated tool call, this
   * loops until the graph completes with no pending interrupts. Returns the concatenated text
   * streamed across all resume turns (empty when nothing was resumed).
   *
   * No-ops (returns '') when the agent does not support interrupts (`getPendingToolInterrupts`/
   * `streamResume` absent) — that is the only exemption. As of EXT-52 BOTH backends gate
   * `run_shell_command` and expose the interrupt surface, so the lean (default) agent is now
   * exactly the agent this loop serves; only an agent implementation without those methods
   * (e.g. a test double) skips it.
   */
  private async resolveToolInterrupts(): Promise<string> {
    const agent = this.agent;
    const runConfig = this.runConfig;
    if (!agent || !runConfig) return '';
    if (!agent.getPendingToolInterrupts || !agent.streamResume) return '';

    let resumedText = '';
    // Bound the loop defensively so a misbehaving graph that re-suspends forever cannot spin.
    for (let guard = 0; guard < 100; guard++) {
      const pending = await agent.getPendingToolInterrupts(runConfig);
      if (pending.length === 0) break;

      const decisions: ToolApprovalDecision[] = [];
      for (const tool of pending) {
        decisions.push(await this.decideToolApproval(tool));
      }

      const stream = await agent.streamResume({ decisions }, runConfig);
      resumedText += await this.drainTextStream(stream);
    }
    return resumedText;
  }

  /**
   * Decide a single pending tool call. CFG-26 order — `bypass → allow-list → rater → human
   * prompt`, with the hardline floor at exec time regardless:
   *
   * 1. **bypass** — the gate is off for this session; approve at scope `once`.
   * 2. **allow-list** (EXT-9 Tier-2) — if the command's classified prefix is already approved
   *    (session or persisted `always`) and survives the safe-bin anti-widening re-validation,
   *    approve SILENTLY. A human-trusted prefix never pays for a rater call.
   * 3. **AI rater** (under `auto`) — `safe` approves; below the escalate threshold the reason
   *    goes back to the MODEL; at/above it we fall through to the human with the verdict
   *    attached; `critical` is refused outright.
   * 4. **human prompt** — the approval callback; when the human grants `session`/`always` scope,
   *    the command's classified prefix is recorded so future flag-variants stop re-prompting.
   *
   * When no human callback is wired (non-TTY `exec` run, a server) and nothing approved the call
   * earlier, REJECT — never auto-approve. That fail-closed default is what makes the one-shot /
   * server row of the defaults matrix safe, and it deliberately sits ahead of every path that
   * would otherwise reach a prompt that cannot be answered.
   *
   * Hardline catastrophic commands remain refused at exec time regardless of any approval here
   * (defense in depth in `GthDevToolkit.executeCommand`), so an allow-listed `rm -rf /` still
   * cannot run.
   */
  private async decideToolApproval(tool: PendingToolInterrupt): Promise<ToolApprovalDecision> {
    const command = typeof tool.args?.command === 'string' ? (tool.args.command as string) : null;
    const isShellCommand = tool.name === 'run_shell_command' && command !== null;
    const approvals = this.sessionApprovals;
    const allowlistApplies = isShellCommand && approvals.allowlist;

    // CFG-26 — `approvals.mode: bypass` (config or `/approvals bypass`): approve a gated shell
    // command WITHOUT prompting, rating, or persisting. Scope `once` so nothing is written to the
    // allow-list (the bypass is intentionally ephemeral and reversible). The hardline floor is NOT
    // bypassed here — it is enforced at exec time in GthDevToolkit.executeCommand regardless of
    // this decision, so a catastrophic command is still refused even under bypass.
    if (isShellCommand && approvals.mode === 'bypass') {
      return { type: 'approve', scope: 'once' };
    }

    // Approve from the allow-list without prompting. The allow-list ALWAYS wins over the rater:
    // a human-trusted prefix shouldn't pay for an LLM call on every variant.
    if (allowlistApplies && this.isApprovedByAllowlist(command)) {
      return { type: 'approve', scope: 'session' };
    }

    // CFG-26 — the AI rater. Under `auto` it runs BEFORE the human callback for a
    // `run_shell_command` not already allow-listed: `safe` is approved (fatigue reducer), a tier
    // below the escalate threshold is REJECTED WITH THE REASON HANDED BACK TO THE MODEL so it can
    // self-correct, at/above the threshold falls through to the human with the verdict attached,
    // and `critical` is refused outright. With the rater off this is a no-op (pure EXT-9).
    let safetyVerdict: ShellSafetyVerdict | undefined;
    if (isShellCommand && command !== null && approvals.rater.enabled) {
      const verdict = await rateShellCommand(command, this.config as GthConfig, {
        home: env?.HOME,
        strictness: approvals.rater.strictness,
        // The profile's model when one is configured; undefined lets rateShellCommand use the
        // session model. `init` throws rather than leaving this undefined for a NAMED profile, so
        // a configured profile can never silently degrade to the session model here.
        model: this.raterModel,
      });
      const decision = mapVerdictToAction(command, verdict, {
        mode: approvals.mode,
        escalate: approvals.rater.escalate,
      });
      if (decision.action === 'approve') {
        // Scope `once`: rater approvals are NEVER persisted to the allow-list.
        return { type: 'approve', scope: 'once' };
      }
      if (decision.action === 'reject') {
        return {
          type: 'reject',
          message: `AI rater blocked the command (critical): ${decision.verdict.reason}`,
        };
      }
      if (decision.action === 'reject-with-reason') {
        // The EXT-20/21 isError path returns this to the MODEL as the tool result, so it can
        // adjust and retry rather than interrupting the human.
        return {
          type: 'reject',
          message:
            `AI rater declined the command (${decision.verdict.tier}): ` +
            `${decision.verdict.reason} Adjust the command or explain why it is needed.`,
        };
      }
      // Escalate: carry the verdict (the honest one — see mapVerdictToAction) to the human.
      safetyVerdict = decision.verdict;
    }

    if (!this.toolApprovalCallback) {
      // No interactive handler (e.g. non-TTY exec run): reject rather than auto-approve.
      return {
        type: 'reject',
        message: 'Tool call rejected: no interactive approval handler available.',
      };
    }

    // Surface the rater's verdict to the human prompt (if the rater escalated) without mutating
    // the original interrupt object the caller holds.
    const pending: PendingToolInterrupt = safetyVerdict ? { ...tool, safetyVerdict } : tool;
    const decision = await this.toolApprovalCallback(pending);

    // Persist the human's scoped grant so future variants of the same operation skip the prompt.
    if (decision.type === 'approve' && allowlistApplies && command) {
      this.recordApproval(command, decision.scope ?? 'once');
    }
    return decision;
  }

  /**
   * Lazily load (once per instance) the persisted `always` allow-list, unless persistence is
   * disabled by config. Returns null when persistence is off so `always` grants behave as
   * `session` (in-memory only).
   */
  private getPersistedAllowlist(): PersistedAllowlist | null {
    if (this.persistedAllowlistLoaded) return this.persistedAllowlist;
    this.persistedAllowlistLoaded = true;
    if (!this.sessionApprovals.persistAllowlist) {
      this.persistedAllowlist = null;
      return null;
    }
    try {
      const filePath = getGslothConfigWritePath(SHELL_ALLOWLIST_FILE);
      this.persistedAllowlist = new PersistedAllowlist(filePath);
    } catch (e) {
      // Path/IO failure → behave as no persisted store (still safe: just prompts more).
      debugLogError('Loading persisted shell allow-list', e);
      this.persistedAllowlist = null;
    }
    return this.persistedAllowlist;
  }

  /** Check the command against the session + persisted stores (with anti-widening re-validation). */
  private isApprovedByAllowlist(command: string): boolean {
    return matchesApproval(command, {
      session: this.sessionAllowlist,
      always: this.getPersistedAllowlist() ?? undefined,
    });
  }

  /**
   * Record a human-granted approval at the given scope. `once` persists nothing. `session`
   * adds the classified prefix to the in-memory store. `always` additionally persists it (or
   * falls back to session-only when persistence is disabled).
   */
  private recordApproval(command: string, scope: ApprovalScope): void {
    if (scope === 'once') return;
    const classification = classifyCommand(command, normalizeCommand);
    if (!classification) return; // unclassifiable (composition/redirection) → never remember.
    this.sessionAllowlist.add(classification.prefix);
    if (scope === 'always') {
      this.getPersistedAllowlist()?.add(classification.prefix);
    }
  }

  /**
   * Event-stream counterpart to {@link processMessages}: drives the agent's typed
   * {@link AgentStreamEvent} path using the runner's own thread-bound `runConfig`, so a
   * renderer (the Ink TUI) can present the same run the readline path renders via
   * `consoleUtils` while sharing the checkpointer thread for cross-turn memory.
   *
   * Cancellation is via the supplied `signal` (the TUI's Esc → `AbortController`); the
   * underlying `streamWithEvents` ends cleanly on abort or `interrupt()`. The string
   * path's empty-stream retry/`invoke` fallback is intentionally NOT duplicated here — the
   * TUI renders the live event stream directly; revisit if empty-stream retries are needed.
   *
   * Tool-approval round-trip (EXT-11): after the stream ends, a gated `run_shell_command`
   * leaves the graph suspended on a `humanInTheLoopMiddleware` interrupt rather than
   * completing. This is the event-stream counterpart to the readline path's
   * {@link resolveToolInterrupts}: it drains any pending interrupts through
   * {@link decideToolApproval} (bypass → allow-list → rater → bridged human prompt), resumes via
   * `streamWithEventsResume({ decisions })`, and loops until the graph completes with no
   * pending interrupts — so the executed command's output renders into the TUI. Without
   * this the TUI silently finalized an empty turn (approval gate was dead code on the
   * event-stream path).
   */
  async *processMessagesWithEvents(
    messages: Message[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    // GS2-16: start this turn's analytics tally from zero (the runner is reused across turns).
    this.resetRunStats();
    // GS2-48 — record this turn's transcript tail for the crash handler.
    updateCrashContext({ transcriptTail: messages.slice(-CRASH_TRANSCRIPT_TAIL_MESSAGES) });
    debugLog('Processing messages (event stream)...');
    debugLogObject('Input Messages', messages);
    yield* this.agent.streamWithEvents(messages, this.runConfig, signal);
    yield* this.resolveToolInterruptsWithEvents(signal);
  }

  /**
   * Event-stream counterpart to {@link resolveToolInterrupts}: after a streamed run ends,
   * resolve any tool-approval interrupts it suspended on, yielding the resumed run's typed
   * {@link AgentStreamEvent}s so the renderer (the Ink TUI) shows the executed command's
   * output. Each pending tool call is consulted via {@link decideToolApproval} — the SAME
   * gate the readline path uses (bypass → allow-list approve → CFG-26 AI rater →
   * bridged human callback, defaulting to REJECT when no handler is wired) — and the
   * collected decisions are sent back via `streamWithEventsResume` as a LangChain HITL
   * resume (`{ decisions }`). Because a resumed run can suspend again on the next gated
   * tool call, this loops until the graph completes with no pending interrupts.
   *
   * No-ops (yields nothing) when the agent does not support interrupts
   * (`getPendingToolInterrupts`/`streamWithEventsResume` absent) — that is the only exemption.
   * As of EXT-52 BOTH backends gate `run_shell_command` and expose the interrupt surface, so the
   * lean (default) agent is now exactly the agent this loop serves; only an agent implementation
   * without those methods (e.g. a test double) skips it. Aborts (`signal`) propagate through the
   * resumed stream.
   */
  private async *resolveToolInterruptsWithEvents(
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    const agent = this.agent;
    const runConfig = this.runConfig;
    if (!agent || !runConfig) return;
    if (!agent.getPendingToolInterrupts || !agent.streamWithEventsResume) return;

    // Bound the loop defensively so a misbehaving graph that re-suspends forever cannot spin.
    for (let guard = 0; guard < 100; guard++) {
      if (signal?.aborted) return;
      const pending = await agent.getPendingToolInterrupts(runConfig);
      if (pending.length === 0) break;

      const decisions: ToolApprovalDecision[] = [];
      for (const tool of pending) {
        decisions.push(await this.decideToolApproval(tool));
      }

      yield* agent.streamWithEventsResume({ decisions }, runConfig, [], signal);
    }
  }

  // noinspection JSUnusedGlobalSymbols
  public getAgent(): GthAgentInterface | null {
    return this.agent;
  }

  /**
   * GS2-16 — reset the current turn's analytics tally on both the live agent and the runner's
   * cached snapshot, so a new turn starts clean. Fail-soft (an agent without stats support is a
   * no-op). Called at the top of each `processMessages` / `processMessagesWithEvents`.
   */
  private resetRunStats(): void {
    this.lastRunStats = { tools: [] };
    try {
      this.agent?.resetRunStats?.();
    } catch {
      /* fail-soft: analytics must never affect a run */
    }
  }

  /** GS2-16 — read the live agent's run stats (fail-soft; empty tally if unavailable). */
  private captureRunStats(): GthRunStats {
    try {
      const stats = this.agent?.getRunStats?.();
      if (stats) return stats;
    } catch {
      /* fail-soft */
    }
    return { tools: [] };
  }

  /**
   * GS2-16 — the analytics harvested from the just-finished turn (token usage + invoked tools),
   * to thread into the opt-in history recorder. Reads live from the agent when one is present,
   * otherwise the snapshot captured at {@link cleanup} (the single-shot path reads post-cleanup).
   * Never throws.
   */
  public getRunStats(): GthRunStats {
    if (this.agent) {
      this.lastRunStats = this.captureRunStats();
    }
    return this.lastRunStats;
  }

  /**
   * Rotate the thread the runner drives by minting a fresh `runConfig` (new `thread_id`),
   * so subsequent turns start from an empty checkpointer thread rather than retrieving the
   * prior conversation. Used by the TUI's `/clear`, which clears the on-screen transcript;
   * without this the model would still see the full history persisted under the old thread.
   *
   * Rotating the thread_id (rather than deleting from the checkpointer) keeps this independent
   * of any checkpointer-specific delete API, mirroring how `init()` mints the initial config.
   */
  public resetThread(): void {
    this.runConfig = getNewRunnableConfig();
    debugLogObject('Reset Runnable Config', this.runConfig);
  }

  async cleanup(): Promise<void> {
    debugLog('Cleaning up GthAgentRunner...');
    // GS2-16: snapshot the agent's run stats BEFORE nulling it, so a post-cleanup reader
    // (runSingleShot records history after calling cleanup) still gets this turn's analytics.
    this.lastRunStats = this.captureRunStats();
    if (this.agent && 'cleanup' in this.agent && typeof this.agent.cleanup === 'function') {
      await this.agent.cleanup();
    }
    this.agent = null;
    this.config = null;
    debugLog('GthAgentRunner cleanup complete');
  }
}
