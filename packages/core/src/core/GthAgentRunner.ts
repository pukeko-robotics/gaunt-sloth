import {
  GthConfig,
  getEffectiveDevToolsConfig,
  isShellAllowlistEnabled,
  isShellAllowlistPersisted,
} from '#src/config.js';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  AgentResolvers,
  AgentStreamEvent,
  GthAgentFactory,
  GthAgentInterface,
  GthCommand,
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
   * EXT-9 Tier-2 session allow-list — approved command prefixes that auto-approve for the
   * life of THIS runner instance. Instance-scoped (not module-global) so concurrent
   * sessions (ACP / AG-UI multi-session) cannot stomp each other's approvals.
   */
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
        const result = await this.agent.invoke(messages, this.runConfig);
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
   * `streamResume` absent), so the lean agent and non-HITL configs are unaffected.
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
   * Decide a single pending tool call (EXT-9 Tier-2). For the opt-in `run_shell_command`,
   * consult the scoped allow-list FIRST: if the command's classified prefix is already
   * approved (session or persisted `always`) and survives the safe-bin anti-widening
   * re-validation, auto-approve SILENTLY (no human prompt). Otherwise fall through to the
   * human callback; when the human grants `session`/`always` scope, record the command's
   * classified prefix into the matching store so future flag-variants stop re-prompting.
   *
   * When no human callback is wired (non-TTY exec run) and nothing is allow-listed, reject —
   * never auto-approve. Non-shell tools (or any tool when the allow-list is disabled) skip the
   * allow-list and go straight to the human callback / default-reject, preserving prior behaviour.
   *
   * Hardline catastrophic commands remain refused at exec time regardless of any approval here
   * (defense in depth in `GthDevToolkit.executeCommand`), so an allow-listed `rm -rf /` still
   * cannot run.
   */
  private async decideToolApproval(tool: PendingToolInterrupt): Promise<ToolApprovalDecision> {
    const command = typeof tool.args?.command === 'string' ? (tool.args.command as string) : null;
    const allowlistApplies =
      tool.name === 'run_shell_command' && command !== null && this.isShellAllowlistOn();

    // Auto-approve from the allow-list without prompting.
    if (allowlistApplies && this.isApprovedByAllowlist(command)) {
      return { type: 'approve', scope: 'session' };
    }

    if (!this.toolApprovalCallback) {
      // No interactive handler (e.g. non-TTY exec run): reject rather than auto-approve.
      return {
        type: 'reject',
        message: 'Tool call rejected: no interactive approval handler available.',
      };
    }

    const decision = await this.toolApprovalCallback(tool);

    // Persist the human's scoped grant so future variants of the same operation skip the prompt.
    if (decision.type === 'approve' && allowlistApplies && command) {
      this.recordApproval(command, decision.scope ?? 'once');
    }
    return decision;
  }

  /** Whether the EXT-9 Tier-2 allow-list is enabled for the active command's devTools config. */
  private isShellAllowlistOn(): boolean {
    const devTools = getEffectiveDevToolsConfig(this.config ?? undefined, this.command);
    return isShellAllowlistEnabled(devTools);
  }

  /**
   * Lazily load (once per instance) the persisted `always` allow-list, unless persistence is
   * disabled by config. Returns null when persistence is off so `always` grants behave as
   * `session` (in-memory only).
   */
  private getPersistedAllowlist(): PersistedAllowlist | null {
    if (this.persistedAllowlistLoaded) return this.persistedAllowlist;
    this.persistedAllowlistLoaded = true;
    const devTools = getEffectiveDevToolsConfig(this.config ?? undefined, this.command);
    if (!isShellAllowlistPersisted(devTools)) {
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
   */
  async *processMessagesWithEvents(
    messages: Message[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    debugLog('Processing messages (event stream)...');
    debugLogObject('Input Messages', messages);
    yield* this.agent.streamWithEvents(messages, this.runConfig, signal);
  }

  // noinspection JSUnusedGlobalSymbols
  public getAgent(): GthAgentInterface | null {
    return this.agent;
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
    if (this.agent && 'cleanup' in this.agent && typeof this.agent.cleanup === 'function') {
      await this.agent.cleanup();
    }
    this.agent = null;
    this.config = null;
    debugLog('GthAgentRunner cleanup complete');
  }
}
