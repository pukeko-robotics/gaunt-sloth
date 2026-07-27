import {
  type AllowlistCounts,
  type ApprovalRung,
  DEFAULT_APPROVAL_RUNG,
  describeGrantedBuiltInTools,
  type GrantedToolSummary,
  GthConfig,
  isRatedRung,
  type ResolvedApprovals,
  resolveApprovals,
  resolveShellApprovalGate,
  SHELL_TOOL_NAME,
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
  ApprovalStopError,
  AttackHaltError,
  NonInteractiveEscalationError,
} from '#src/core/shell/approvalStop.js';
import { DenylistStore } from '#src/core/shell/denylist.js';
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
   * CFG-27 — the runtime, session-scoped approvals posture, seeded at {@link init} from
   * {@link resolveApprovals} and thereafter switchable for the session by `/approvals <rung>`.
   * The shell tool stays gated (in `interruptOn`) at EVERY rung, so this is consulted at the top
   * of {@link decideToolApproval} and a config that pre-selects `bypass` remains switchable back
   * mid-session. Never persisted.
   *
   * It does NOT disable the hardline floor — catastrophic commands are still refused at exec time
   * in `GthDevToolkit.executeCommand` under every rung.
   */
  private sessionApprovals: ResolvedApprovals = {
    rung: DEFAULT_APPROVAL_RUNG,
    allow: [],
    deny: [],
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
   * CFG-27 §3 — the session deny list: the entries declared in `approvals.deny` (read-only config
   * input, seeded at {@link init}) merged with whatever the escalation menu's *always reject*
   * choice adds at runtime ([[TUI-C26]] wires that writer). Consulted BEFORE the allow-list and
   * BEFORE the rater, and — uniquely — it still applies under `bypass`.
   */
  private denylist = new DenylistStore();

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
   * CFG-27 — switch the session-scoped rung (`/approvals <rung>`). Idempotent; returns the NEW
   * rung so the caller can render a notice. Session-scoped only — nothing is written to config,
   * and the declared allow/deny lists are unaffected (they are config input, not session state).
   */
  public setSessionApprovalRung(rung: ApprovalRung): ApprovalRung {
    this.sessionApprovals = { ...this.sessionApprovals, rung };
    return this.sessionApprovals.rung;
  }

  /** CFG-27 — the session's current approvals posture (rung + rater profile + declared lists). */
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
    const always = this.persistedAllowlistLoaded
      ? (this.persistedAllowlist?.list().length ?? undefined)
      : undefined;
    return { session: this.sessionAllowlist.list().length, always };
  }

  /** CFG-27 — the session's deny entries (declared in config, plus any added at runtime). */
  public getDenylist(): string[] {
    return this.denylist.list();
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

    // CFG-27 — seed the session posture from config, so a config that pre-selects `bypass` starts
    // there while the shell tool stays gated (see `resolveShellApprovalGate`) and therefore
    // remains switchable (`/approvals write`). Resolved per-command, mirroring where the shell
    // tool is actually emitted; no effect where the tool is ungated.
    this.sessionApprovals = resolveApprovals(configIn, command);

    // §3/§9.1 — the DECLARED lists are read-only config input. `allow` is merged into the session
    // allow-list store (which the human's `session` grants also write to) and `deny` seeds the
    // deny store; neither is ever written back to config.
    this.denylist = new DenylistStore(this.sessionApprovals.deny);
    for (const prefix of this.sessionApprovals.allow) {
      const trimmed = prefix.trim();
      if (trimmed.length > 0) this.sessionAllowlist.add(trimmed);
    }

    // CFG-26 — resolve the rater's own model when a profile is named, so the documented mitigation
    // for a weak model ("point approvals.rater at a stronger one") actually takes effect.
    //
    // EAGERLY, here, rather than lazily at first use: `initConfig` re-runs discovery and prints
    // "Activating profile: …", which mid-turn would write raw over the Ink TUI's managed frame,
    // and a broken profile should fail at startup rather than three turns in. It deliberately does
    // NOT catch — a named-but-unusable rater profile is an error, never a silent fallback to the
    // session model (GS2-62).
    //
    // Loaded whenever a profile is NAMED, without a second "will the rater actually run?" gate:
    // naming a rater profile at an unrated rung is a config the user can hold (they may switch to
    // `auto-safe` mid-session with `/approvals`), and a broken profile should still fail loudly at
    // startup rather than at the moment they switch.
    const raterProfile = this.sessionApprovals.rater;
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
          // CFG-27 — an approvals STOP is not a stream failure: it is the gate deliberately
          // ending the run, and its message IS the explanation the spec requires it to carry.
          // Re-thrown unchanged (the outer catch does the same) so nothing buries it.
          if (streamError instanceof ApprovalStopError) throw streamError;
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
      // CFG-27 §4.2/§6.2 — an approvals STOP is not an agent failure and must reach the user with
      // its own words: the command, the rating and its reason are the whole point of it. Wrapping
      // it as "Agent processing failed: …" would bury the explanation the spec requires it to
      // carry, so it is re-thrown unchanged.
      if (error instanceof ApprovalStopError) throw error;
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
   * Decide a single pending tool call. CFG-27 order — **deny → bypass → allow-list → rater →
   * human prompt**, with the hardline floor at exec time regardless:
   *
   * 1. **deny list** (§3) — a declared (or runtime `always reject`) prefix is refused with no
   *    prompt and no rating call. It is consulted FIRST, and it is the one check that **still
   *    applies under `bypass`**: choosing `bypass` says *"stop asking me"*, not *"forget what I
   *    told you never to do"*. Its matcher is deliberately not the allow-list's — see
   *    `core/shell/denylist.ts` for why the fail-direction has to be the opposite one.
   * 2. **`bypass`** — the gate is off for this session; approve at scope `once`.
   * 3. **allow-list** (§3, EXT-9 Tier-2) — if the command's classified prefix is already approved
   *    (declared in `approvals.allow`, granted this session, or persisted `always`) and survives
   *    the safe-bin anti-widening re-validation, approve SILENTLY. It applies at EVERY rung
   *    except `bypass` (where it is moot) and is consulted **before** the rater, so a trusted
   *    prefix never pays for a rating call.
   * 4. **auto-rater** (`auto-safe` / `full-auto` only) — `safe` approves, `destructive` and
   *    `catastrophic` escalate, and `attack` HALTS the run ({@link AttackHaltError}). The other
   *    three rungs consult no model at all.
   * 5. **human prompt** — the approval callback; when the human grants `session`/`always` scope,
   *    the command's classified prefix is recorded so future flag-variants stop re-prompting.
   *
   * §6.2 — where no human can answer (CI, a one-shot run, a server), an escalation is **not** a
   * rejection handed back to the model: it is an immediate non-zero exit
   * ({@link NonInteractiveEscalationError}) carrying the command, the rating and its reason. No
   * prompt, no waiting, and never a timeout into approval. Declaring commands in `approvals.allow`
   * is the supported way to make a pipeline pass.
   *
   * Hardline catastrophic commands remain refused at exec time regardless of any approval here
   * (defense in depth in `GthDevToolkit.executeCommand`), so an allow-listed `rm -rf /` still
   * cannot run.
   */
  private async decideToolApproval(tool: PendingToolInterrupt): Promise<ToolApprovalDecision> {
    const command = typeof tool.args?.command === 'string' ? (tool.args.command as string) : null;
    const isShellCommand = tool.name === 'run_shell_command' && command !== null;
    const approvals = this.sessionApprovals;

    // (1) The deny list — before everything, including `bypass`.
    if (isShellCommand && command !== null) {
      const denied = this.denylist.match(command);
      if (denied !== null) {
        return {
          type: 'reject',
          message:
            `Refused: your deny list forbids this command (matched "${denied}"). ` +
            'Remove the entry from approvals.deny if you want it to run.',
        };
      }
    }

    // (2) `bypass` (config or `/approvals bypass`): approve a gated shell command WITHOUT
    // prompting or rating. Scope `once` so nothing is written to the allow-list (the bypass is
    // intentionally ephemeral and reversible). The hardline floor is NOT bypassed here — it is
    // enforced at exec time in GthDevToolkit.executeCommand regardless of this decision.
    if (isShellCommand && approvals.rung === 'bypass') {
      return { type: 'approve', scope: 'once' };
    }

    // (3) Approve from the allow-list without prompting. The allow-list ALWAYS wins over the
    // rater: a human-trusted prefix shouldn't pay for an LLM call on every variant.
    const allowlistApplies = isShellCommand && approvals.rung !== 'bypass';
    if (allowlistApplies && this.isApprovedByAllowlist(command)) {
      return { type: 'approve', scope: 'session' };
    }

    // (4) The auto-rater, at the two rated rungs only. `safe` is approved (the fatigue reducer),
    // `destructive` and `catastrophic` fall through to the human with the verdict attached, and
    // `attack` ends the run outright.
    let safetyVerdict: ShellSafetyVerdict | undefined;
    if (isShellCommand && command !== null && isRatedRung(approvals.rung)) {
      const verdict = await rateShellCommand(command, this.config as GthConfig, {
        home: env?.HOME,
        // The profile's model when one is configured; undefined lets rateShellCommand use the
        // session model. `init` throws rather than leaving this undefined for a NAMED profile, so
        // a configured profile can never silently degrade to the session model here.
        model: this.raterModel,
        // EXT-58 (§4.4) — the already-granted built-ins of the CURRENT rung, so a non-`safe`
        // outcome can name one the model could call for free instead. Computed per rating rather
        // than cached at init, because `/approvals <rung>` moves the rung mid-session and a stale
        // list would offer a tool that is no longer granted.
        grantedTools: this.getGrantedBuiltInTools(),
      });
      const decision = mapVerdictToAction(command, verdict, { rung: approvals.rung });
      if (decision.action === 'approve') {
        // Scope `once`: rater approvals are NEVER persisted to the allow-list.
        return { type: 'approve', scope: 'once' };
      }
      if (decision.action === 'halt') {
        // §4.2 — not a rejection the model can respond to. It ends the agent loop.
        throw new AttackHaltError(command, decision.verdict?.reason ?? '');
      }
      // Escalate: carry the verdict (the honest one — see mapVerdictToAction) to the human.
      safetyVerdict = decision.verdict;
    }

    if (!this.toolApprovalCallback) {
      // §6.2 — no one to ask. Exit non-zero with everything a person needs, rather than handing
      // the model a rejection it would just work around.
      throw new NonInteractiveEscalationError(
        command ?? tool.name,
        safetyVerdict?.outcome,
        safetyVerdict?.reason
      );
    }

    // Surface the rater's verdict to the human prompt (if the rater escalated) without mutating
    // the original interrupt object the caller holds.
    const pending: PendingToolInterrupt = safetyVerdict ? { ...tool, safetyVerdict } : tool;
    const decision = await this.toolApprovalCallback(pending);

    // Persist the human's scoped grant so future variants of the same operation skip the prompt.
    //
    // §4.2 — **a `catastrophic` approval is NEVER sticky.** "The human may approve this one
    // invocation, and only this one": no always-allow, and no session-scoped allow either. The
    // surface withdraws the affordance ([[TUI-C26]] drops `always approve` from the menu for this
    // outcome), but the allow-list WRITE is decided here, and §3 has the allow-list consulted
    // *before* the rater — so one sticky grant would remove the command from rating permanently,
    // and the next `terraform destroy` would never be rated at all. Clamping here means the policy
    // does not depend on which surface asked, or on a surface that has not been built yet.
    const catastrophic = safetyVerdict?.outcome === 'catastrophic';
    if (decision.type === 'approve' && allowlistApplies && command && !catastrophic) {
      this.recordApproval(command, decision.scope ?? 'once');
    }
    return decision;
  }

  /**
   * EXT-58 (§4.3/§4.4) — the built-in tools already granted at the session's CURRENT rung, as
   * names plus one-line locally-authored descriptions, for the rater prompt.
   *
   * Two filters make this safe to place outside the rater's fenced untrusted block:
   * - the names come from what the agent actually registered
   *   ({@link GthAgentInterface.getRegisteredToolNames}), so the rater can only ever offer a tool
   *   this session has;
   * - the descriptions come from core's own `BUILT_IN_TOOL_SUMMARIES` table, so no MCP, custom or
   *   A2A tool's own (attacker-influenceable) description can reach the prompt.
   *
   * Empty when the agent does not expose its tools — the rater then gets no list and, per the
   * prompt, offers nothing.
   */
  private getGrantedBuiltInTools(): GrantedToolSummary[] {
    const registered = this.agent?.getRegisteredToolNames?.() ?? [];
    if (registered.length === 0) return [];
    // The gated set is resolved from the SAME shared policy both backends wire their interrupt
    // from, so "granted" here means exactly what it means at tool-registration time (§4.5).
    const { gateShell } = resolveShellApprovalGate(this.config ?? undefined, this.command);
    const gatedTools = gateShell ? [SHELL_TOOL_NAME] : [];
    return describeGrantedBuiltInTools(registered, this.sessionApprovals.rung, gatedTools);
  }

  /**
   * Lazily load (once per instance) the persisted `always` allow-list.
   *
   * CFG-27 removed the `persistAllowlist` switch: §3 makes persistence a per-decision choice in
   * the escalation menu (`approve` forgets, `always approve` persists), and a global "never
   * persist" setting would only duplicate a keystroke. Returns null when the store cannot be
   * loaded at all, in which case `always` grants degrade to `session` (in-memory only).
   */
  private getPersistedAllowlist(): PersistedAllowlist | null {
    if (this.persistedAllowlistLoaded) return this.persistedAllowlist;
    this.persistedAllowlistLoaded = true;
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
