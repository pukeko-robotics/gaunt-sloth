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
  StatusLevel,
  StatusUpdateCallback,
  ToolApprovalCallback,
  ToolApprovalDecision,
  type ToolApprovalScope,
} from '#src/core/types.js';
import { GthLangChainAgent } from '#src/core/GthLangChainAgent.js';
import {
  ApprovalGrantStore,
  type ApprovalGrantScope,
  PersistedApprovalGrants,
  shellGrantEntry,
} from '#src/core/approvals/grants.js';
import { renderApprovalEntryObject } from '#src/config/schema.js';
import { classifyCommand } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';
import {
  ApprovalStopError,
  AttackHaltError,
  NonInteractiveEscalationError,
} from '#src/core/shell/approvalStop.js';
import {
  applyDestructiveFloor,
  isRaterTimeout,
  mapAllowMatchedVerdictToAction,
  mapVerdictToAction,
  openWorldToolFloorReason,
  RATER_DEFAULT_TIMEOUT_MS,
  rateShellCommand,
  type ShellSafetyVerdict,
} from '#src/core/shell/rater.js';
import {
  type ApprovalRuleDecision,
  type ApprovalRuleLists,
  type ApprovalSubject,
  describeApprovalEntry,
  type EffectiveToolAnnotationSource,
  resolveApprovalRules,
} from '#src/core/approvals/matcher.js';
import { createEffectiveToolAnnotationSource } from '#src/core/approvals/annotations.js';
import { approvalSubjectForToolName } from '#src/core/approvals/mcpSubjects.js';
import {
  builtInToolAnnotations,
  mcpDeclaredAnnotationLookup,
} from '#src/core/approvals/toolAnnotationSources.js';
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
    escalate: [],
  };

  /**
   * CFG-26 — the model the AI rater rates with, when `approvals.rater.profile` names an identity
   * profile. Resolved ONCE at {@link init} (never mid-turn) and handed to `rateShellCommand`;
   * `undefined` means no profile is configured and the rater uses the session model.
   */
  private raterModel: BaseChatModel | undefined;

  /**
   * EXT-66 — how many rating calls this session gave up on. Counted so the notice can say "3 times
   * this session" rather than repeating an identical line, and so a silent drift toward
   * escalate-everything has a number attached to it.
   */
  private raterTimeouts = 0;

  /**
   * EXT-71 §3.1/§6 — what the escalation menu granted at run time, for the life of THIS runner
   * instance: {@link ApprovalEntry} objects, never prefixes, and never anything from config (the
   * declared lists are read-only input consulted straight from the posture). Instance-scoped so
   * concurrent sessions (ACP / AG-UI multi-session) cannot stomp each other's approvals.
   */
  private readonly sessionGrants = new ApprovalGrantStore();

  /**
   * CFG-27 §3 — what the escalation menu's *always reject* choice adds at run time, in the same
   * grammar ([[TUI-C26]] wires that writer; the store speaks it already). The entries DECLARED in
   * `approvals.deny` are not here — they are read-only config input, matched from the posture — and
   * both are handed to the same matcher, so a runtime refusal and a declared one are one list.
   */
  private denyGrants = new ApprovalGrantStore();

  /**
   * The persisted (`always`) grant store, loaded lazily on first use from
   * `.gsloth/.gsloth-settings/shell-allowlist.json`. Null until a gated call actually needs it, and
   * null when the file cannot be loaded at all (in which case `always` grants degrade to session).
   */
  private persistedGrants: PersistedApprovalGrants | null = null;
  private persistedGrantsLoaded = false;

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
    const always = this.persistedGrantsLoaded
      ? (this.persistedGrants?.size() ?? undefined)
      : undefined;
    // EXT-71 §3 — every list MUST be inspectable, and the declared entries are in force for this
    // session exactly as the human's own grants are. They are counted alongside them rather than
    // hidden, which is what the count meant before the declared lists stopped seeding the store.
    const session = this.sessionGrants.size() + this.sessionApprovals.allow.length;
    return { session, always };
  }

  /**
   * CFG-27 — the session's deny entries for display: the declared `approvals.deny` entries
   * (rendered one line each) followed by whatever the escalation menu's *always reject* added at
   * run time. Both refuse a call, so both are shown.
   */
  public getDenylist(): string[] {
    return [...this.sessionApprovals.deny, ...this.denyGrants.entries()].map(describeApprovalEntry);
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

    // §3/§9.1 — the DECLARED lists are read-only config input, consulted through the EXT-71 rule
    // matcher (`core/approvals/matcher.ts`) and NEVER copied into the runtime stores, which hold
    // only what the escalation menu grants at run time. Both are handed to the same matcher, so
    // there is one grammar and one comparison, not a config path and a runtime path.
    this.denyGrants = new ApprovalGrantStore();

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
   * EXT-71 §3.1/§3.2, EXT-70 §4.7.5 — the subject a pending tool call presents to the rule matcher.
   *
   * A gated `run_shell_command` is a **shell** subject and nothing else: it is matched by `shell`
   * entries, against the command. It is deliberately NOT also offered as a `tool` subject named
   * `run_shell_command`, which would create a second allow path to every shell command carrying a
   * different §3.2 `rate` default and a match that never saw the command it was approving.
   *
   * **Everything else splits by provenance**, which is the distinction §4.7.1 rests on: `tool` is
   * the TRUSTED provenance, read verbatim, so an MCP tool arriving as one would be asking the
   * trusted path for a third party's annotations — a gate any server can opt itself out of. Every
   * MCP-namespaced name therefore becomes an `mcpTool` subject carrying the user's own `mcpServers`
   * key, and one whose server cannot be resolved stays an `mcpTool` subject under an unnameable
   * server rather than falling back to `tool` (see `approvalSubjectForToolName`).
   *
   * Widening which tools the gate actually suspends on is still [[EXT-30]]; this decides what a
   * suspended call *is* whenever one arrives.
   */
  private approvalSubjectFor(tool: PendingToolInterrupt, command: string | null): ApprovalSubject {
    if (tool.name === SHELL_TOOL_NAME && command !== null) return { kind: 'shell', command };
    return approvalSubjectForToolName(tool.name, this.configuredMcpServerKeys());
  }

  /**
   * §4.7.5 — the user's own `mcpServers` keys, the only identity a server has here. Own enumerable
   * keys via `Object.keys`, so nothing inherited can pose as a configured server.
   */
  private configuredMcpServerKeys(): string[] {
    const servers = this.config?.mcpServers;
    return servers && typeof servers === 'object' ? Object.keys(servers) : [];
  }

  /**
   * EXT-70 §4.7.1 — the source a `hint` entry reads a call's EFFECTIVE annotations through, built
   * from the session's `approvals.mcp` block and the two declared-annotation lookups.
   *
   * Built per decision rather than cached at {@link init}, for two reasons that both bite: the
   * agent registers its tools *inside* `agent.init()`, so an init-time snapshot would be empty; and
   * a re-init re-resolves the tool list, which for MCP may hand back different declarations.
   *
   * The two lookups are deliberately different in kind. `builtIn` reads OUR OWN authored table and
   * never the bound tool list — the bound list contains every server's tools, and a `builtIn`
   * lookup over it would read a third party's declaration through the trusted-verbatim path.
   * `mcp` reads what the servers declared, keyed by the registered tool name so the server key is
   * never split apart and re-joined differently.
   */
  private effectiveToolAnnotationSource(): EffectiveToolAnnotationSource {
    return createEffectiveToolAnnotationSource({
      mcp: this.sessionApprovals.mcp,
      declared: {
        builtIn: builtInToolAnnotations,
        mcp: mcpDeclaredAnnotationLookup(this.agent?.getDeclaredMcpToolAnnotations?.()),
      },
    });
  }

  /**
   * Decide a single pending tool call. Spec order — **deny → bypass → escalate → allow → rater →
   * human prompt**, with the hardline floor at exec time regardless. The two adjacencies that carry
   * the design are that deny comes BEFORE `bypass` and escalate comes AFTER it:
   *
   * 1. **deny** (§3) — a declared entry or a runtime *always reject* grant is refused with no
   *    prompt and no rating call. It is consulted FIRST, and it is the one
   *    check that **still applies under `bypass`**: choosing `bypass` says *"stop asking me"*, not
   *    *"forget what I told you never to do"*. A deny entry MAY match a compound command, because a
   *    prohibition that catches something unresolvable errs in the direction that costs nothing.
   * 2. **`bypass`** — the gate is off for this session; approve at scope `once`.
   * 3. **escalate** (§3.2) — a declared entry always asks the human, whatever the rung would have
   *    done, **including outranking the automatic grants of `read-only` and `write`** and any allow
   *    entry that also matched. It goes straight to the human with **no rating call**, and it never
   *    enters the `full-auto` negotiation. It is **inert at `bypass`**, which is why it sits below
   *    the rung check: the rung chosen for this session wins, and a stop that must survive `bypass`
   *    is a deny entry and only that.
   * 4. **allow** (§3, §3.2) — a declared entry or a grant the human made at an earlier prompt this
   *    session (or persisted), matched against the whole normalized command and only when that
   *    command statically resolves. An allow match settles the human's part: no prompt. Whether the rater
   *    still reviews the call is the entry's own `rate` (§3.2) — honored at the rater rungs and
   *    inert at the deterministic ones, so no entry can smuggle a model call into `read-only` or
   *    `write` — and a rated allow match is a TRIPWIRE, not a re-adjudication
   *    ({@link mapAllowMatchedVerdictToAction}).
   * 5. **auto-rater** (`auto-safe` / `full-auto` only) — `safe` approves, `destructive` and
   *    `catastrophic` escalate, and `attack` HALTS the run ({@link AttackHaltError}). The other
   *    three rungs consult no model at all. At those same two rungs a **tool** call is instead
   *    floored deterministically by §4.7.3's open-world rule ({@link openWorldToolFloorReason} into
   *    {@link applyDestructiveFloor} — the one floor the shell path also reaches): a call whose
   *    effective `openWorldHint` is true is `destructive`, whatever its `readOnlyHint` says.
   * 6. **human prompt** — the approval callback; when the human grants `session`/`always` scope,
   *    **that command** is recorded as an `exact` entry (§3.1/§6 — the menu never widens), so the
   *    same command stops re-prompting and a longer variant of it still asks.
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
    const isShellCommand = tool.name === SHELL_TOOL_NAME && command !== null;
    const approvals = this.sessionApprovals;

    // ONE subject and ONE annotation source per decision, shared by the rule matcher and the
    // §4.7.3 floor below. Building a second source for the floor would let a `hint` entry and the
    // floor read different effective values for the same call — the two-derivations-disagreeing
    // failure `core/approvals/annotations.ts` exists to prevent.
    const subject = this.approvalSubjectFor(tool, command);
    const annotationSource = this.effectiveToolAnnotationSource();

    // The declared lists AND the runtime grant stores, resolved most-restrictive-wins in ONE pass
    // through the ONE comparison engine, so author order and the order the lists were concatenated
    // in cannot change the outcome — and a grant the menu wrote is compared exactly as a line the
    // user typed into their config is.
    const rule: ApprovalRuleDecision | null = resolveApprovalRules(
      subject,
      this.approvalRuleLists(),
      {
        // EXT-70 §4.7.1 — a `hint` entry reads EFFECTIVE annotations, which is where per-server,
        // per-hint trust is applied. Without this the matcher falls back to the fail-closed source,
        // where no tool is ever read-only and a `hint` entry could only ever describe the default.
        annotations: annotationSource,
        onNotice: (notice) => this.statusUpdate(notice.level, notice.message),
      }
    );

    // (1) Deny — before everything, including `bypass`.
    if (rule?.action === 'deny') {
      return {
        type: 'reject',
        message:
          `Refused: your deny list forbids this call (matched "${describeApprovalEntry(rule.entry)}"). ` +
          'Remove the entry from approvals.deny if you want it to run.',
      };
    }

    // (2) `bypass` (config or `/approvals bypass`): approve a gated shell command WITHOUT
    // prompting or rating. Scope `once` so nothing is written to the allow-list (the bypass is
    // intentionally ephemeral and reversible). The hardline floor is NOT bypassed here — it is
    // enforced at exec time in GthDevToolkit.executeCommand regardless of this decision.
    if (isShellCommand && approvals.rung === 'bypass') {
      return { type: 'approve', scope: 'once' };
    }

    // (3) Escalate — §3.2 sends it straight to the human with no rating call, outranking any allow
    // entry that also matched.
    //
    // The `bypass` term is deliberate and not redundant with the early return above. That return
    // only covers a SHELL call, so without this term a non-shell subject would still carry an
    // escalate match into the prompt at `bypass` — unreachable while `run_shell_command` is the
    // only gated tool, but §2.5's rule is about the rung, not about which tool asked. Make the
    // invariant true rather than incidentally true, so [[EXT-30]] widening the gate cannot quietly
    // break it.
    const escalatedBy =
      rule?.action === 'escalate' && approvals.rung !== 'bypass'
        ? describeApprovalEntry(rule.entry)
        : undefined;

    // (4) Approve from the allow list without prompting. It ALWAYS wins over the rater — a
    // human-trusted call shouldn't pay for an LLM call on every variant — but never over escalate.
    const allowlistApplies = approvals.rung !== 'bypass' && escalatedBy === undefined;
    let safetyVerdict: ShellSafetyVerdict | undefined;
    if (allowlistApplies && rule?.action === 'allow') {
      // §3.2 — `rate` is honored at the rater rungs and INERT at the deterministic ones, so an
      // entry can never smuggle a model call into `read-only` or `write`. A tool subject is not
      // rated either: the rater's first implementation covers the shell only (§4.3, [[EXT-30]]).
      if (!rule.rate || !isRatedRung(approvals.rung) || !isShellCommand || command === null) {
        return { type: 'approve', scope: 'session' };
      }
      const verdict = await this.rateCommand(command, { allowMatched: true });
      const tripwire = mapAllowMatchedVerdictToAction(verdict);
      if (tripwire.action === 'approve') return { type: 'approve', scope: 'session' };
      if (tripwire.action === 'halt') {
        // §3.2/§4.2 — `attack` halts exactly as it would have without the match. A standing human
        // grant answers "may this run"; it does not answer "is this command's structure hostile".
        throw new AttackHaltError(command, tripwire.verdict?.reason ?? '');
      }
      // `catastrophic` — the one outcome the tripwire escalates. Fall through to the human.
      safetyVerdict = tripwire.verdict;
    }

    // (5) What the gate makes of the call itself, at the two rated rungs only. Skipped entirely
    // for an escalate match (§3.2: the user pre-decided that a human answers, so a rating would
    // decorate a mandatory prompt) and for a call the tripwire above already rated. The rung test
    // is the SAME one `mapVerdictToAction` applies, so both arms below floor exactly where the
    // shell does and nowhere else: `bypass` and the two deterministic rungs consult neither the
    // rater nor a preflight, and at those rungs the human is asked regardless.
    if (isRatedRung(approvals.rung) && escalatedBy === undefined && safetyVerdict === undefined) {
      if (isShellCommand && command !== null) {
        // The auto-rater. `safe` is approved (the fatigue reducer), `destructive` and
        // `catastrophic` fall through to the human with the verdict attached, and `attack` ends
        // the run outright. §4.6's deterministic preflights are applied inside
        // `mapVerdictToAction`, ahead of the `safe` check.
        const verdict = await this.rateCommand(command, { allowMatched: false });
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
      } else if (subject.kind !== 'shell') {
        // EXT-70 §4.7.2/§4.7.3 — a tool call whose EFFECTIVE `openWorldHint` is true is floored at
        // `destructive`, through the SAME `applyDestructiveFloor` the shell path reaches via
        // `mapVerdictToAction`. No rating call: §4.3's scope boundary keeps the rater on the shell
        // until [[EXT-30]], and the floor is deterministic anyway — §4.6 states it as coming
        // *before* any model call, so it does not wait for one.
        //
        // The annotations are the effective set (§4.7.1), read through the same source the `hint`
        // matcher just used, so an untrusted server's `openWorldHint: false` has already collapsed
        // to the fail-closed `true` and cannot buy its way past this.
        //
        // Reached only when no allow entry claimed the call: §4.6's fourth bullet makes an allow
        // match lift this floor, and step (4) above has already returned in that case.
        safetyVerdict = applyDestructiveFloor(
          safetyVerdict,
          openWorldToolFloorReason(annotationSource(subject))
        );
      }
    }

    if (!this.toolApprovalCallback) {
      // §6.2 — no one to ask. Exit non-zero with everything a person needs, rather than handing
      // the model a rejection it would just work around.
      throw new NonInteractiveEscalationError(
        command ?? tool.name,
        safetyVerdict?.outcome,
        safetyVerdict?.reason,
        escalatedBy
      );
    }

    // §4.2 — **a `catastrophic` approval is NEVER sticky.** "The human may approve this one
    // invocation, and only this one": no always-allow, and no session-scoped allow either. The
    // surface withdraws the affordance ([[TUI-C26]] drops `always approve` from the menu for this
    // outcome), but the allow-list WRITE is decided here, and §3 has the allow-list consulted
    // *before* the rater — so one sticky grant would remove the command from rating permanently,
    // and the next `terraform destroy` would never be rated at all. Clamping here means the policy
    // does not depend on which surface asked, or on a surface that has not been built yet.
    const catastrophic = safetyVerdict?.outcome === 'catastrophic';
    const recordable = isShellCommand && approvals.rung !== 'bypass';

    // §6 — **the menu must display what it is about to store**, at the moment of the choice, on
    // every surface. It is rendered from the very entry {@link recordApproval} will write (one
    // function, {@link shellGrantEntry}), because a menu that describes a grant one way and stores
    // it another is the drift this design cannot afford. Absent exactly where no sticky grant is
    // available — a `catastrophic` outcome, or a call nothing would remember — so the prompt never
    // advertises a control that has already been withdrawn.
    const grantPreview =
      recordable && command && !catastrophic
        ? renderApprovalEntryObject(shellGrantEntry(command))
        : undefined;

    // Surface the rater's verdict, the escalate entry that fired as provenance (§3.2), and what a
    // sticky choice would store (§6) — without mutating the original interrupt object the caller
    // holds.
    const pending: PendingToolInterrupt =
      safetyVerdict || escalatedBy || grantPreview
        ? {
            ...tool,
            ...(safetyVerdict ? { safetyVerdict } : {}),
            ...(escalatedBy ? { escalatedBy } : {}),
            ...(grantPreview ? { grantPreview } : {}),
          }
        : tool;
    const decision = await this.toolApprovalCallback(pending);

    // Record the human's scoped grant so the same command stops re-prompting.
    if (decision.type === 'approve' && recordable && command && !catastrophic) {
      this.recordApproval(command, decision.scope ?? 'once');
    }
    return decision;
  }

  /**
   * One rating call, with EXT-66's timeout reporting attached. Extracted so the §3.2 tripwire (a
   * rated allow match) and the ordinary rater path cannot drift apart in WHAT they hand the rater —
   * only in what they do with the answer.
   */
  private async rateCommand(
    command: string,
    opts: { allowMatched: boolean }
  ): Promise<ShellSafetyVerdict> {
    const approvals = this.sessionApprovals;
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
      // EXT-66 — the user-owned budget for ONE rating call, `undefined` when unset so
      // rateShellCommand applies RATER_DEFAULT_TIMEOUT_MS. 30s is a hosted-model number and a
      // local rater is knowably slower; without this a local `full-auto` session drifts toward
      // escalating everything, which is the failure the rung exists to prevent.
      timeoutMs: approvals.raterTimeoutMs,
    });
    // EXT-66 — a timeout is the gate giving up, not a judgement, and the two were previously
    // indistinguishable in the action column. Say it once per occurrence: the only symptom
    // otherwise is the gate becoming mysteriously more talkative, which reads as the rater
    // working rather than as the rater never being heard from.
    if (isRaterTimeout(verdict)) {
      this.raterTimeouts += 1;
      this.statusUpdate(
        StatusLevel.WARNING,
        `The command safety rater did not answer in time (${
          approvals.raterTimeoutMs ?? RATER_DEFAULT_TIMEOUT_MS
        }ms), so this command ` +
          // §3.2 — on an allow match the rating is a tripwire, so a timeout does not escalate: the
          // human's standing grant still stands and the call runs. Saying "escalated" there would
          // be simply false, and a notice that misreports the action it accompanies is worse than
          // none.
          (opts.allowMatched
            ? 'ran on its approvals.allow match alone, without the rating that entry asked for'
            : 'was escalated without being rated') +
          (this.raterTimeouts > 1 ? ` — ${this.raterTimeouts} times this session` : '') +
          '. Raise approvals.raterTimeoutMs if the rater is a local model.'
      );
    }
    return verdict;
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
   * §3/§3.3 — the three rule lists this session decides by: the DECLARED entries from config
   * (read-only input) concatenated with the runtime grants the escalation menu made. One set of
   * lists, handed to the one comparison engine; the concatenation cannot change any outcome
   * because `resolveApprovalRules` consults every deny entry before any escalate entry and every
   * escalate entry before any allow entry.
   *
   * The persisted store is loaded here rather than at {@link init} — lazily, once per instance, and
   * NEVER at `bypass`, where the allow list is moot and a session that has switched the gate off
   * should not be reading or rewriting the project's grant file.
   */
  private approvalRuleLists(): ApprovalRuleLists {
    const approvals = this.sessionApprovals;
    const persisted = approvals.rung === 'bypass' ? null : this.getPersistedGrants();
    return {
      deny: [...approvals.deny, ...this.denyGrants.entries()],
      escalate: approvals.escalate,
      allow: [...approvals.allow, ...this.sessionGrants.entries(), ...(persisted?.entries() ?? [])],
    };
  }

  /**
   * Lazily load (once per instance) the persisted `always` grant store.
   *
   * CFG-27 removed the `persistAllowlist` switch: §3 makes persistence a per-decision choice in
   * the escalation menu (`approve` forgets, `always approve` persists), and a global "never
   * persist" setting would only duplicate a keystroke. Returns null when the store cannot be
   * loaded at all, in which case `always` grants degrade to `session` (in-memory only).
   *
   * The v1→v2 migration notice is routed to `statusUpdate` from here, which is the only place that
   * knows how to reach the user.
   */
  private getPersistedGrants(): PersistedApprovalGrants | null {
    if (this.persistedGrantsLoaded) return this.persistedGrants;
    this.persistedGrantsLoaded = true;
    try {
      const filePath = getGslothConfigWritePath(SHELL_ALLOWLIST_FILE);
      this.persistedGrants = new PersistedApprovalGrants(filePath, {
        onNotice: (notice) => this.statusUpdate(notice.level, notice.message),
      });
    } catch (e) {
      // Path/IO failure → behave as no persisted store (still safe: just prompts more).
      debugLogError('Loading persisted shell approvals', e);
      this.persistedGrants = null;
    }
    return this.persistedGrants;
  }

  /**
   * §3.1/§6 — record a human-granted approval at the given scope. `once` remembers nothing.
   * `session` adds the entry to the in-memory store; `always` additionally persists it (falling
   * back to session-only when the file cannot be written).
   *
   * **What is recorded is the command itself, as an `exact` entry** — never a prefix, never a
   * pattern. Breadth is always something a human typed into a config file.
   *
   * A command that does not statically resolve (composition, substitution, redirection) is not
   * recorded at all. It could not be stored harmfully — no allow entry of any matcher matches an
   * unresolvable command, so the entry would be inert — but an inert entry sitting in a list §3
   * requires to be inspectable would tell the user something is in force when nothing is.
   */
  private recordApproval(command: string, scope: ToolApprovalScope): void {
    if (scope === 'once') return;
    if (classifyCommand(command, normalizeCommand) === null) return;
    const grantScope: ApprovalGrantScope = scope;
    const grant = {
      entry: shellGrantEntry(command),
      grantedAt: new Date().toISOString(),
      scope: grantScope,
    };
    this.sessionGrants.add(grant);
    if (scope === 'always') {
      this.getPersistedGrants()?.add(grant);
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
