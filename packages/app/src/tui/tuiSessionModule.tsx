import React from 'react';
import { render } from 'ink';
import { type CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import {
  mergeToolOutputIntoEvents,
  setToolOutputSuppressed,
} from '@gaunt-sloth/core/core/toolOutputChannel.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import type { PendingToolInterrupt, ToolApprovalDecision } from '@gaunt-sloth/core/core/types.js';
import {
  beginWarningCapture,
  endWarningCapture,
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { appendToFile, getCommandOutputFilePath } from '@gaunt-sloth/core/utils/fileUtils.js';
import { env, getProjectDir, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import { openHistoryStore, resolveHistoryDbPath } from '@gaunt-sloth/core/history/historyStore.js';
import {
  formatConversationList,
  formatInsightsSummary,
  formatSearchResults,
} from '@gaunt-sloth/core/history/historyFormat.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { GthRunStats } from '@gaunt-sloth/core/core/types.js';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createResolvers } from '@gaunt-sloth/agent/resolvers.js';
import { resolveAgentFactory } from '@gaunt-sloth/agent/core/resolveAgentFactory.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import type { BaseMessage } from '@langchain/core/messages';
import { writeDebugDump } from '@gaunt-sloth/core/utils/debugDump.js';
import { App } from '#src/tui/components/App.js';
import {
  formatConfigSummary,
  type DebugDumpInput,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import type { PendingApproval, TuiAgent, TuiDebugCapture } from '#src/tui/types.js';
import {
  collectMcpOverview,
  renderHistory,
  renderMcpDetails,
  renderSystemDetails,
  renderToolDetails,
  renderResponse,
} from '#src/tui/debugRender.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { viewportBumpSequence } from '#src/tui/terminal.js';
import type { DebugRequestExtras } from '@gaunt-sloth/agent/core/debugCapture.js';

/** The `/history` `/insights` `/search` props, or `{}` when no store is available. */
interface HistorySlashProps {
  historySummary?: string[];
  insightsSummary?: string[];
  historySearch?: (query: string) => string[];
}

/**
 * GS2-7 (B20) — build the read-only history slash-command props from the local store, fail-soft.
 * If no DB is available (history never enabled / file missing / unopenable) it returns `{}`, so
 * `/history` `/insights` `/search` render their "history unavailable" notices. Never throws — a
 * store problem must not affect starting a session.
 */
function buildHistorySlashProps(config: GthConfig): HistorySlashProps {
  try {
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return {};
    try {
      const historySummary = formatConversationList(store.listConversations(20));
      const insightsSummary = formatInsightsSummary(store.insights());
      // Search runs later (at dispatch), so it re-opens read-only per call rather than holding a
      // connection open for the session; still fully fail-soft.
      const historySearch = (query: string): string[] => {
        try {
          const s = openHistoryStore(dbPath, { create: false });
          if (!s) return formatSearchResults([]);
          try {
            return formatSearchResults(s.search(query, 20));
          } finally {
            s.close();
          }
        } catch {
          return formatSearchResults([]);
        }
      };
      return { historySummary, insightsSummary, historySearch };
    } finally {
      store.close();
    }
  } catch {
    return {};
  }
}

/**
 * GS2-46 — the real `/debug-dump` writer, injected into `<App>` the same way `historySearch` is:
 * forwards the App-assembled input straight to the core writer, which does the actual fs I/O
 * (mkdir + writeFileSync per file under the GLOBAL `~/.gsloth/debug-dumps/<timestamp>/`) plus
 * gathers env/version info, the in-memory debugLog ring buffer, and best-effort git repo state
 * itself. GS2-47 — the writer applies the shared secret-redaction pass (ON by default) unless the
 * caller-resolved `redact` flag opts out; the flag is forwarded verbatim.
 */
function dumpDebugSession(input: DebugDumpInput): { archiveDir: string } {
  return writeDebugDump({
    transcript: input.transcript,
    config: input.config,
    modelDisplayName: input.modelDisplayName,
    // GS2-47 — the slash command resolved redact-on-by-default (config + `--unsafe-no-redact`);
    // forward it so the writer applies (or skips) the shared secret-redaction pass.
    redact: input.redact,
  });
}

type StatusListener = (level: string, message: string) => void;

/** Fan-out so the runner's status callback can reach the mounted React app. */
function createStatusBridge() {
  const listeners = new Set<StatusListener>();
  return {
    emit: (level: StatusLevel, message: string) => {
      const name = StatusLevel[level] ?? String(level);
      for (const l of listeners) l(name, message);
    },
    subscribe: (cb: StatusListener) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

type DebugListener = (capture: TuiDebugCapture) => void;

/**
 * Fan-out so the deep agent's wrapModelCall debug sink can reach the mounted React app.
 *
 * TUI-C20: `config` + `resolvers` are threaded in so each request capture can also carry the MCP
 * tab's overview. The per-server discovery instructions come from EXT-32's
 * {@link AgentResolvers.getMcpServerInstructions} accessor (captured once, reused here — never
 * re-queried), collected via `collectMcpOverview`; the per-server tools are regrouped from the same
 * `extras.tools` catalogue the Tools tab renders.
 */
function createDebugBridge(config: GthConfig, resolvers: AgentResolvers) {
  const listeners = new Set<DebugListener>();
  const emit = (capture: TuiDebugCapture) => {
    for (const l of listeners) l(capture);
  };
  return {
    subscribe: (cb: DebugListener) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    capture: {
      onRequest: (messages: BaseMessage[], extras?: DebugRequestExtras) => {
        const { servers, instructions, failures } = collectMcpOverview(config, resolvers);
        emit({
          kind: 'request',
          text: renderHistory(messages),
          system: renderSystemDetails(extras),
          tools: renderToolDetails(extras),
          mcp: renderMcpDetails(extras, servers, instructions, failures),
        });
      },
      onResponse: (response: unknown) => emit({ kind: 'response', text: renderResponse(response) }),
    },
  };
}

/**
 * Fan-out so the runner's tool-approval callback can reach the mounted React app. Modeled on
 * {@link createStatusBridge}, but promise-based: when the runner suspends on a
 * `run_shell_command` interrupt and calls the approval callback, the bridge creates a pending
 * record (the {@link PendingToolInterrupt} plus a `resolve`), emits it to the subscribed
 * `<App>`, and hands the callback a Promise it awaits until the app resolves a decision.
 *
 * Fail-closed: if the session ends / the app unmounts while an approval is still pending, every
 * outstanding record is resolved as a reject (`abortPending`), so a suspended run can never hang
 * — matching the readline path's "anything not o/s/a → reject" default.
 */
function createApprovalBridge() {
  const listeners = new Set<(record: PendingApproval) => void>();
  // Records that have been emitted but not yet resolved (used by abortPending on teardown).
  const outstanding = new Set<PendingApproval>();
  return {
    /** Wired to `runner.setToolApprovalCallback`: returns a Promise the runner awaits. */
    request: (pending: PendingToolInterrupt): Promise<ToolApprovalDecision> =>
      new Promise<ToolApprovalDecision>((resolve) => {
        let settled = false;
        const record: PendingApproval = {
          pending,
          resolve: (decision) => {
            if (settled) return;
            settled = true;
            outstanding.delete(record);
            resolve(decision);
          },
        };
        outstanding.add(record);
        for (const l of listeners) l(record);
      }),
    subscribe: (cb: (record: PendingApproval) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    /** Resolve every still-pending approval as a reject (fail-closed) on teardown. */
    abortPending: () => {
      for (const record of [...outstanding]) {
        record.resolve({ type: 'reject', message: 'Session ended before approval.' });
      }
    },
  };
}

/**
 * Ink TUI counterpart to `createInteractiveSession` (the readline path). Same lifecycle —
 * init config, session logging, a `GthAgentRunner` driving the deep agent — but it renders
 * over the typed {@link import('@gaunt-sloth/core/core/types.js').AgentStreamEvent} stream
 * (`processMessagesWithEvents`) instead of `consoleUtils`. The status callback is bridged
 * into the React app rather than written to stdout, which would corrupt Ink's frame.
 *
 * Session logging note: the readline path streams the assistant delta to file as it
 * arrives; here we append the full turn (user + assistant text) on completion. Same
 * content, slightly different write timing.
 */
export async function createTuiSession(
  sessionConfig: SessionConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  message?: string
): Promise<void> {
  // Hermetic e2e seam: when GTH_TUI_E2E_FIXTURE is set, drive the real <App> (Ink renderer +
  // foldEvents) from a deterministic, key-free replay of recorded events instead of a model.
  // Production never takes this branch (the env var is set only by the PTY e2e harness).
  const fixturePath = env.GTH_TUI_E2E_FIXTURE;
  if (fixturePath) {
    const { createFixtureTuiAgent } = await import('#src/tui/fixtureAgent.js');
    // Holder so `onResetFrame` can reach the not-yet-created render instance (App writes the
    // /clear scroll/clear escapes itself, then asks Ink to forget its last frame — TUI-C12).
    let resetFrame: (() => void) | undefined;
    const instance = render(
      <App
        agent={createFixtureTuiAgent(fixturePath)}
        mode={sessionConfig.mode}
        readyMessage={sessionConfig.readyMessage}
        exitMessage={sessionConfig.exitMessage}
        initialMessage={message}
        // QA-6: wire the real /debug-dump writer into the fixture branch too (same function
        // reference the non-fixture render uses below) so the e2e PTY suite can exercise the
        // actual archive-write path instead of only ever hitting the "unavailable" fallback.
        // resolvedConfig is deliberately left unset here — DebugDumpInput.config is
        // optional/opaque and the command already handles it being undefined.
        dumpDebugSession={dumpDebugSession}
        onResetFrame={() => resetFrame?.()}
      />
    );
    resetFrame = () => instance.clear();
    await instance.waitUntilExit();
    return;
  }

  // TUI-C19: capture the transient load-time advisories (config validation warnings — unknown
  // keys, deprecated names — emitted via `displayWarning` inside `initConfig`) so they can be
  // threaded into the TUI's persistent notice surface instead of scrolling out of sight the moment
  // Ink takes over the screen. try/finally so a config throw can't leak the capture window.
  let startupAdvisories: string[] = [];
  let config: GthConfig;
  beginWarningCapture();
  try {
    config = { ...(await initConfig(commandLineConfigOverrides)) };
  } finally {
    startupAdvisories = endWarningCapture();
  }
  const checkpointSaver = new MemorySaver();
  // GS2-19: one conversation per TUI session; each completed turn (logTurn) is stamped with its id
  // so the whole chat groups under one conversation. Opt-in / fail-soft (undefined unless history
  // is enabled and the store opened); turns fall back to per-turn conversations otherwise.
  const conversationId =
    openConversationSafe(config, {
      command: sessionConfig.mode,
      project: getProjectDir(),
      model: config.modelDisplayName,
    }) ?? undefined;
  const logFileName = getCommandOutputFilePath(config, sessionConfig.mode);
  if (logFileName) {
    initSessionLogging(logFileName, config.streamSessionInferenceLog);
  }

  const bridge = createStatusBridge();
  // TUI-C20: the resolvers are hoisted so the debug bridge can read the SAME MCP instructions the
  // agent captured (via getMcpServerInstructions) for the /debug MCP tab — not a second capture.
  const resolvers = createResolvers();
  const debugBridge = createDebugBridge(config, resolvers);
  const approvalBridge = createApprovalBridge();
  // B5: TUI code/chat default to the LEAN backend; an explicit config.agent.backend overrides it
  // (deep is now opt-in / experimental). Mirrors the readline path in createInteractiveSession,
  // askCommand, and execCommand — the TUI is the default interactive surface, so it must match.
  // createResolvers() is unchanged, so a lean session keeps the full toolset.
  const runner = new GthAgentRunner(bridge.emit, resolvers, resolveAgentFactory(config, 'lean'));

  // GS2-63: the interactive TUI ALWAYS shows the technical run-header preamble (Workdir/Model/
  // Tools/Middleware). The `output.header: false` opt-out applies to non-TUI text modes only, so
  // the config handed to the agent forces it on regardless of the user's setting — the header
  // lines route through the status bridge into the notice surface here, not raw stdout. A fresh
  // object (not an in-place mutation) so nothing else that already captured `config` is affected.
  const agentConfig: GthConfig = { ...config, output: { ...config.output, header: true } };

  try {
    await runner.init(sessionConfig.mode, agentConfig, checkpointSaver);

    // Any MCP server that failed to connect during init (resolveTools ran inside runner.init).
    // Captured here so the persistent NoticeBar can name it — otherwise the only signal is a
    // displayWarning that Ink has already painted over, which is the bug this surfaces.
    const mcpFailures = resolvers?.getMcpConnectionFailures?.() ?? [];

    // Tool-approval (human-in-the-loop) prompt for gated tools — the readline counterpart in
    // interactiveSessionModule. The runner consults the allow-list BEFORE calling this, so
    // trusted commands never reach the TUI prompt; otherwise the bridge surfaces the pending
    // command in the mounted <App> and awaits the human's scoped decision (o/s/a → approve,
    // anything else → reject, fail-closed).
    runner.setToolApprovalCallback((pending) => approvalBridge.request(pending));

    // Attach the debug sink to the live agent (opt-in; each backend's wrapModelCall middleware
    // reads it lazily, so this only enables capture for the TUI's /debug panel — the AG-UI
    // contract is untouched). Both the lean (default) and deep backends extend GthAbstractAgent
    // and install the capture middleware, so the panel populates on either.
    const agent = runner.getAgent();
    if (agent instanceof GthAbstractAgent) {
      agent.debugCapture = debugBridge.capture;
    }

    // GS2-56: session-scoped `/debug-dump` writer that ALSO threads the agent's always-on
    // last-model-request snapshot (system prompt + tool defs + params + as-sent messages) into the
    // archive. Reads `agent.lastModelRequest` at CALL time (the field is overwritten each model
    // call), so the dump carries the full model input even when `/debug` was never opened — the
    // module-level `dumpDebugSession` (used by the fixture branch, which has no real agent) does not.
    const dumpDebugSessionWithModelRequest = (input: DebugDumpInput): { archiveDir: string } =>
      writeDebugDump({
        transcript: input.transcript,
        config: input.config,
        modelDisplayName: input.modelDisplayName,
        redact: input.redact,
        modelRequest: agent instanceof GthAbstractAgent ? agent.lastModelRequest : undefined,
      });

    // GS2-16: wall-clock start of the in-flight turn, stamped when runTurn begins and read by
    // logTurn on completion (turns are sequential in the TUI). 0 until the first turn runs.
    let turnStartedAt = 0;

    const logTurn = (userInput: string, assistantText: string) => {
      // GS2-16: live token usage + invoked tool names + duration for this turn, fail-soft. The
      // runner may lack stats support (e.g. under test) → guard; empty tally when unavailable.
      let runStats: GthRunStats = { tools: [] };
      try {
        const s = runner.getRunStats?.();
        if (s) runStats = s;
      } catch {
        /* fail-soft: analytics must never affect the session */
      }
      const durationMs = turnStartedAt > 0 ? Date.now() - turnStartedAt : undefined;

      // GS2-7 (B20): opt-in, fail-soft history — records each completed turn as a session when
      // `history.enabled`. Independent of the per-run md log (so it works even with
      // writeOutputToFile off) and fully guarded, so it never affects the session.
      // GS2-16 threads token/tool/duration analytics; costUsd is left unset (no reliable price).
      recordSessionSafe(config, {
        conversationId, // GS2-19: group every turn under this session's conversation
        command: sessionConfig.mode,
        project: getProjectDir(),
        model: config.modelDisplayName,
        prompt: userInput,
        response: assistantText,
        tokensInput: runStats.tokensInput,
        tokensOutput: runStats.tokensOutput,
        tools: runStats.tools.length > 0 ? runStats.tools : undefined,
        durationMs,
      });
      if (!logFileName) return;
      appendToFile(logFileName, `## User\n\n${userInput}\n\n## Assistant\n\n${assistantText}\n\n`);
      flushSessionLog();
    };

    const tuiAgent: TuiAgent = {
      async *runTurn(userInput, signal) {
        turnStartedAt = Date.now(); // GS2-16: mark turn start for durationMs in logTurn
        // TUI-C17: subscribe to the tool-output channel for the turn and merge each live
        // custom/dev-tool stdout/stderr chunk (and its "Executing" notice) into the event
        // stream as `tool_output` events — so tool output lands in `foldEvents`/the managed
        // frame instead of leaking to raw stdout above Ink's render tree. Unsubscribes when
        // the turn ends, restoring the default (headless) stdout sink between turns.
        yield* mergeToolOutputIntoEvents(
          runner.processMessagesWithEvents([new HumanMessage(userInput)], signal)
        );
      },
      // `/clear` rotates the runner's thread_id so the model context truly matches the
      // cleared transcript (the checkpointer otherwise replays the whole prior conversation).
      resetThread() {
        runner.resetThread();
      },
      // `/auto-approve` applies the runner's session-scoped shell auto-approval flag (EXT-12):
      // 'on'/'off' set it explicitly, 'toggle' flips it. Returns the landed state for the notice.
      setAutoApprove(action) {
        if (action === 'toggle') return runner.toggleSessionYolo();
        return runner.setSessionYolo(action === 'on');
      },
    };

    // "Bump up" the screen on launch the clear/Ctrl+L way (TUI-C13): scroll whatever was on
    // screen before `gth`/`gsloth` ran up and out of the visible viewport (it stays in
    // scrollback — we never emit ESC[3J) so the session opens at a clean top. We write this
    // BEFORE render() so Ink paints its first frame at the top with no frame accounting to
    // reset. Guarded on isTTY so piped/redirected/non-TTY runs (and tests) are not polluted.
    if (stdout.isTTY) {
      stdout.write(viewportBumpSequence(stdout.rows));
    }

    // Holder so `onResetFrame` can reach the not-yet-created render instance: on /clear the App
    // writes the scroll/viewport-clear escapes, then calls this to make Ink forget its last
    // frame so the re-render lands cleanly at the top (TUI-C12).
    let resetFrame: (() => void) | undefined;

    // TUI-C31 (d): from here on Ink owns the terminal frame. Mark the tool-output channel
    // suppressed so a straggler child that outlived a turn's kill grace and emits BETWEEN turns
    // (when no per-turn subscriber is attached) is dropped rather than written raw over the
    // managed frame. Per-turn output is unaffected — the active subscriber always takes
    // precedence — and the `finally` below clears it on every exit path, restoring the headless
    // stdout sink once the TUI is gone.
    setToolOutputSuppressed(true);
    const instance = render(
      <App
        agent={tuiAgent}
        mode={sessionConfig.mode}
        modelDisplayName={config.modelDisplayName}
        initialAutoApprove={runner.isSessionYolo()}
        configSummary={formatConfigSummary(config)}
        resolvedConfig={config}
        dumpDebugSession={dumpDebugSessionWithModelRequest}
        advisories={startupAdvisories}
        mcpFailures={mcpFailures}
        {...buildHistorySlashProps(config)}
        readyMessage={sessionConfig.readyMessage}
        exitMessage={sessionConfig.exitMessage}
        initialMessage={message}
        subscribeStatus={bridge.subscribe}
        subscribeDebug={debugBridge.subscribe}
        subscribeApproval={approvalBridge.subscribe}
        onTurnComplete={logTurn}
        onResetFrame={() => resetFrame?.()}
        onExit={async () => {
          // Fail-closed: resolve any approval still awaiting a decision before tearing down,
          // so a suspended run can never hang on an unanswered prompt.
          approvalBridge.abortPending();
          await runner.cleanup();
          stopSessionLogging();
        }}
      />
    );
    resetFrame = () => instance.clear();

    await instance.waitUntilExit();
  } catch (err) {
    approvalBridge.abortPending();
    await runner.cleanup();
    stopSessionLogging();
    throw err;
  } finally {
    // TUI-C31 (d): the TUI has unmounted (normal exit or throw) — restore the headless stdout
    // sink so any later tool output is no longer suppressed once Ink no longer owns the frame.
    setToolOutputSuppressed(false);
  }
}
