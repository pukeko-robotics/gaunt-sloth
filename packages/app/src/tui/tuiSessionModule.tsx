import React from 'react';
import { render } from 'ink';
import { type CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import { resolveUseColour } from '@gaunt-sloth/core/config/colour.js';
import { resolveUseMouse } from '@gaunt-sloth/core/config/mouse.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import {
  mergeToolOutputIntoEvents,
  setToolOutputSuppressed,
} from '@gaunt-sloth/core/core/toolOutputChannel.js';
import { clearExitOutput, drainExitOutput } from '@gaunt-sloth/core/core/exitOutputChannel.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import {
  beginWarningCapture,
  displayNotice,
  endWarningCapture,
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { appendToFile, getCommandOutputFilePath } from '@gaunt-sloth/core/utils/fileUtils.js';
import { env, exit, getProjectDir, stdin, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
import { buildHistorySlashProps } from '@gaunt-sloth/core/history/historySlashProps.js';
import { saveConversationGrantsSafe } from '@gaunt-sloth/core/core/approvals/conversationGrants.js';
import {
  applyResumeTarget,
  listResumeCandidates,
  resolveResumeTarget,
  resumeRefusalNotice,
  type ResumeTarget,
} from '@gaunt-sloth/agent/modules/sessionResume.js';
import type { InteractiveSessionOptions } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { GthRunStats } from '@gaunt-sloth/core/core/types.js';
import { HumanMessage } from '@langchain/core/messages';
import { createResolvers } from '@gaunt-sloth/agent/resolvers.js';
import { resolveAgentFactory } from '@gaunt-sloth/agent/core/resolveAgentFactory.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import type { BaseMessage } from '@langchain/core/messages';
import { readTermination, writeDebugDump } from '@gaunt-sloth/core/utils/debugDump.js';
import { App } from '#src/tui/components/App.js';
import { applyTuiColour } from '#src/tui/colour.js';
import {
  formatConfigSummary,
  type DebugDumpInput,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import type { TuiAgent, TuiDebugCapture } from '#src/tui/types.js';
import { createApprovalBridge, createAttackHaltBridge } from '#src/tui/approvalBridges.js';
import type { LiveNegotiationRound } from '@gaunt-sloth/core/core/shell/negotiation.js';
import {
  collectMcpOverview,
  renderHistory,
  renderMcpDetails,
  renderSystemDetails,
  renderToolDetails,
  renderResponse,
} from '#src/tui/debugRender.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import {
  installAlternateScrollSuppression,
  installMouseReporting,
  type MouseReportingHandle,
} from '#src/tui/mouseReporting.js';
import { createMouseStdin } from '#src/tui/mouseStdin.js';
import type { MouseEvent } from '#src/tui/mouseParser.js';
import type { MouseSubscribe } from '#src/tui/useMouse.js';
import type { DebugRequestExtras } from '@gaunt-sloth/agent/core/debugCapture.js';

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

/**
 * TUI-C56 — write everything the session deferred to the exit-output channel, now that the
 * terminal belongs to the user again.
 *
 * The write half of the channel lives here rather than in the channel itself, because both of the
 * judgements it makes are the SURFACE's:
 *
 *  - **When.** Only this module knows the terminal is back: Ink restores the primary buffer inside
 *    `finishUnmount` and settles the exit promise behind a write barrier afterwards, so a write
 *    made once `waitUntilExit()` has settled — resolved on a normal exit, rejected on a failure
 *    Ink unmounts for — lands on the restored screen. Anything written earlier is teardown output
 *    on the alternate screen, which Ink discards by design. `createTuiSession` is where the call
 *    sits, so both cases reach it; see the note there.
 *  - **Whether.** `isTTY` here is PIPE PROTECTION, not alternate-screen detection. A caller
 *    reading this session's stdout through a pipe gets a stream it may be parsing, and an extra
 *    trailing line it never asked for is exactly the kind of pollution that breaks one. It is not
 *    a test for whether the alternate screen was in play — Ink also declines the alternate screen
 *    when a CI variable is set even on a real TTY, and in that case this prints a second copy of
 *    a path Ink's non-interactive branch already flushed. A duplicated path on a developer's
 *    screen is cheap; re-deriving Ink's private CI heuristic here would drift out of step with it.
 *
 * Each block gets its own trailing newline: they are separate statements landing under whatever
 * the user's scrollback already held, not a paragraph. The drain happens BEFORE the gate, so the
 * declining path discards what was deferred rather than leaving it queued for someone else.
 *
 * The write goes through `systemUtils`' stdout rather than a `consoleUtils` display helper on
 * purpose, and it is the one place in this module where that needs saying: every one of those
 * helpers is gated on the console level, while the in-frame notice this text is the twin of is a
 * TUI notice and is not. Routing it through the level gate would mean a user who had turned the
 * console quiet keeps the notice they can no longer act on and loses the line that survives —
 * which is the same silent loss this seam exists to end, reintroduced one rung up. AGENTS.md
 * records this as the one exception to its Output rule.
 */
function writeDeferredExitOutput(): void {
  const blocks = drainExitOutput();
  if (!stdout.isTTY) return;
  for (const block of blocks) {
    stdout.write(`${block}\n`);
  }
}

/**
 * TUI-C37 — the session's mouse plumbing.
 *
 * Built for every TUI session, whatever the starting state, because the stdin filter has to be in
 * place before Ink is rendered and Ink can never be handed a different stdin afterwards. Only
 * {@link MouseSession.setEnabled} — and therefore only the terminal's reporting mode — changes when
 * the user toggles `/mouse`.
 *
 * Three things have to be torn down together and in order, which is why they are created together:
 * the terminal's reporting mode, the stdin filter sitting in front of Ink, and the event fan-out.
 * `dispose` is idempotent and safe to call from more than one exit path, because more than one exit
 * path will call it.
 */
interface MouseSession {
  subscribe: MouseSubscribe;
  stdin: NodeJS.ReadStream;
  /** Turn reporting on/off mid-session for `/mouse`, without rebuilding the stdin filter. */
  setEnabled: (enabled: boolean) => void;
  dispose: () => void;
}

function createMouseSession(enabled: boolean): MouseSession {
  const listeners = new Set<(event: MouseEvent) => void>();
  // The filter is installed for the whole session regardless of the starting state. Ink is handed
  // its stdin exactly once, at render, and cannot be given a different one later — so a session
  // that started with mouse off could never turn it on if the filter were conditional. With
  // tracking disabled the terminal sends no reports, so the filter costs an untaken branch.
  const mouseStdin = createMouseStdin(stdin, (event) => {
    for (const listener of listeners) listener(event);
  });
  // Reporting, unlike the filter, IS conditional: it decides whether any escape bytes reach the
  // terminal, so a session starting with mouse off writes none.
  let reporting: MouseReportingHandle | undefined = enabled ? installMouseReporting() : undefined;
  // TUI-C48 — the exact complement of `reporting`. In the alternate screen a terminal with no
  // mouse mode set turns wheel notches into bare Up/Down arrows, which the slash-command menu
  // claims; with tracking on the wheel arrives as an SGR report instead and alternate-scroll never
  // applies. So exactly one of these two is installed at any moment, and `/mouse` swaps them.
  let altScroll: MouseReportingHandle | undefined = enabled
    ? undefined
    : installAlternateScrollSuppression();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stdin: mouseStdin.stdin,
    setEnabled: (enabled) => {
      if (enabled && !reporting) {
        altScroll?.dispose();
        altScroll = undefined;
        reporting = installMouseReporting();
      } else if (!enabled && reporting) {
        reporting.dispose();
        reporting = undefined;
        altScroll = installAlternateScrollSuppression();
      }
    },
    dispose: () => {
      reporting?.dispose();
      reporting = undefined;
      altScroll?.dispose();
      altScroll = undefined;
      mouseStdin.dispose();
      listeners.clear();
    },
  };
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
 * Fan-out so the agent's wrapModelCall debug sink can reach the mounted React app.
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
 * [[TUI-C69]] §5.4 — the same fan-out for the **negotiation's rounds**, so the gate can draw the
 * argument between the agent and the auto-rater while it happens.
 *
 * A plain listener rather than a promise bridge, and that is the whole difference from the two in
 * `#src/tui/approvalBridges.ts`: nothing here is being answered, so nothing waits. A round is an
 * event the run reports on its way past, and a surface that is slow to draw one must never be able
 * to hold up the decision.
 */
function createNegotiationBridge() {
  const listeners = new Set<(event: LiveNegotiationRound | null) => void>();
  const emit = (event: LiveNegotiationRound | null) => {
    for (const l of listeners) l(event);
  };
  return {
    /** Wired to `runner.setNegotiationDisplay`. */
    round: (event: LiveNegotiationRound) => emit(event),
    /**
     * §5.4 — the exchange ended, so the panel drops it. `null` rather than a second channel: the
     * App folds one stream of events into one piece of state, and a separate subscription would be
     * a second ordering for two facts that are strictly sequential.
     */
    end: () => emit(null),
    subscribe: (cb: (event: LiveNegotiationRound | null) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * Ink TUI counterpart to `createInteractiveSession` (the readline path).
 *
 * This wrapper is nothing but the exit-output channel's lifetime: the session's whole body runs
 * inside it, so the channel is emptied on the way in and drained on the way out however the body
 * returns or throws. `runTuiSession` is the session itself.
 *
 * TUI-C56 — start the channel empty. Nothing in a normal process defers before a session begins,
 * so this is not a fix for an observed leak; it is what makes the guarantee simple enough to rely
 * on — what this session prints on the way out is what THIS session deferred, never a block left
 * behind by something earlier in the same process.
 *
 * TUI-C104 — and drain it in a `finally`, which is the whole point of the wrapper. A drain sitting
 * on each render branch's own exit instead covers every way a user DELIBERATELY leaves — `/exit`,
 * `/quit`, the bare `exit` keyword and Ctrl+C alike, since [[TUI-C79]] routes Ctrl+C through
 * <App>'s `quit()` and Ink's own `exit()` rather than through a signal — and nothing else. It does
 * not cover a throw raised once the render phase has begun: that leaves through the session's
 * `catch`, `startSession` warns "TUI unavailable" and starts a readline session in the same
 * process, and a block the user was told to go and open would be discarded in silence — with the
 * crash as the only symptom they can see and the missing line as the one they cannot. A crash is
 * exactly when they cannot afford to lose it, so the drain sits where both paths reach it.
 *
 * One drain, here, rather than one per render branch: every return and every throw from the body
 * unwinds through this `finally`, so a branch added later is covered without anyone remembering —
 * the property a per-branch call cannot have.
 *
 * Two things make this safe to state without hedging:
 *
 *  - **It lands on the restored screen, on the throw path too.** The only producer is
 *    `/debug-dump`, and a slash command needs a mounted <App> — so a non-empty queue means the
 *    failure arrived through `waitUntilExit()`, and Ink leaves the alternate screen inside
 *    `finishUnmount` BEFORE it rejects that promise. A failure early enough to miss Ink's unmount
 *    (the mouse plumbing, `render` itself) is also early enough that nothing has been deferred, so
 *    the drain there is a no-op by construction rather than by luck.
 *  - **It cannot double-print.** `drainExitOutput` empties the queue as it reads it, and this
 *    `finally` completes before `startSession`'s `catch` runs, so the readline session started
 *    after a render throw finds nothing to print. It would not print it anyway — that surface
 *    never drains, because its output already survives its own exit — and neither half is a flag
 *    anyone can get wrong.
 *
 * Still not covered, and deliberately: the two ways a process ends without unwinding. An external
 * SIGINT/SIGTERM is one — Ink resolves its exit promise synchronously during shutdown (async
 * callbacks no longer fire), so the body never returns and this `finally` is not reached. A
 * `process.exit` is the other, and the body makes one: the `--resume` refusal's `exit(1)`, which
 * runs while the screen is still the terminal's, where nothing can have been deferred — a no-op by
 * construction, like the early render failure above. Nothing is added to chase either, because a
 * second teardown path is exactly what [[TUI-C48]] measured its way out of.
 */
export async function createTuiSession(
  sessionConfig: SessionConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  message?: string,
  onRenderStart?: () => void,
  options: InteractiveSessionOptions = {}
): Promise<void> {
  clearExitOutput();
  try {
    await runTuiSession(sessionConfig, commandLineConfigOverrides, message, onRenderStart, options);
  } finally {
    // The drain must never BECOME the error. A throw out of this `finally` replaces whatever is
    // unwinding, and it does so on both paths: a render failure would reach `startSession` as
    // "TUI unavailable (write EPIPE)" with the real cause gone — on exactly the path the drain was
    // put here to serve — and a session that ended NORMALLY would be turned into a rejection, so
    // `startSession` would announce a broken TUI and open a readline session after a run that
    // worked. Reporting beats rethrowing on both.
    //
    // Reported, though, never swallowed: a block the user was told to go and open has just been
    // lost, which is the silent loss this whole seam exists to end. So it goes through the notice
    // helper — stderr, which is not the stream that just failed — and `gate: 'always'`, because
    // there is no re-run that brings the lost line back. The write above bypasses `consoleUtils`
    // (see its call site); this is commentary about a failure rather than the surviving output
    // itself, so it takes the ordinary path.
    try {
      writeDeferredExitOutput();
    } catch (drainFailure) {
      displayNotice(
        'Exit output could not be printed',
        [
          'Text this session deferred to print after the screen came back has been lost.',
          drainFailure instanceof Error ? drainFailure.message : String(drainFailure),
        ],
        { tone: 'warn', gate: 'always' }
      );
    }
  }
}

/**
 * The session proper. Same lifecycle as the readline path — init config, session logging, a
 * `GthAgentRunner` driving the agent — but it renders over the typed
 * {@link import('@gaunt-sloth/core/core/types.js').AgentStreamEvent} stream
 * (`processMessagesWithEvents`) instead of `consoleUtils`. The status callback is bridged
 * into the React app rather than written to stdout, which would corrupt Ink's frame.
 *
 * Session logging note: the readline path streams the assistant delta to file as it
 * arrives; here we append the full turn (user + assistant text) on completion. Same
 * content, slightly different write timing.
 *
 * CFG-47 — `onRenderStart` is the seam that lets `startSession` fall back to readline for a TUI
 * problem and ONLY for a TUI problem. It is called at the point where this function stops doing
 * work the readline path also does and starts taking the terminal over (mouse plumbing, then Ink's
 * mount). Before that call, a failure is one readline would hit too — a bad config, a runner that
 * would not initialise — and falling back would print a false "TUI unavailable" and then fail again
 * for the real reason; after it, the failure is the TUI's own and readline is the right answer.
 *
 * The polarity is what makes this durable: `startSession` propagates unless it has been told the
 * render phase was reached, so a new way for the setup above to fail needs nobody to remember
 * anything. Anything moved to before the call joins the propagating side by construction — so if
 * you add TUI-only, terminal-touching setup, put it after the call.
 */
async function runTuiSession(
  sessionConfig: SessionConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  message: string | undefined,
  onRenderStart: (() => void) | undefined,
  options: InteractiveSessionOptions
): Promise<void> {
  // Hermetic e2e seam: when GTH_TUI_E2E_FIXTURE is set, drive the real <App> (Ink renderer +
  // foldEvents) from a deterministic, key-free replay of recorded events instead of a model.
  // Production never takes this branch (the env var is set only by the PTY e2e harness).
  const fixturePath = env.GTH_TUI_E2E_FIXTURE;
  if (fixturePath) {
    // CFG-47 — this whole branch is render: it deliberately loads no config, so there is nothing
    // here the readline path shares. Signal immediately so the PTY harness keeps the fallback it
    // has always had rather than silently propagating a fixture problem.
    onRenderStart?.();
    // TUI-C35 — this branch deliberately never loads config, so there is no resolved answer to
    // consume; ask the CFG-30 ladder directly with the same inputs the loader would have given
    // it. Consuming the shared helper, not a second policy. Without this the PTY suite would run
    // on chalk's unclamped detection and so would never exercise the hook at all.
    applyTuiColour(
      resolveUseColour({
        forceColor: env.FORCE_COLOR,
        noColor: env.NO_COLOR,
        stdoutIsTTY: !!stdout.isTTY,
      })
    );
    const { createFixtureTuiAgent } = await import('#src/tui/fixtureAgent.js');
    // TUI-C37 — same treatment for mouse, and for the same reason the banner gets it: with no
    // config on this branch, ask the ladder directly with the inputs the loader would have given
    // it. Without this the PTY suite could never prove that a real mouse report stays out of the
    // prompt, which is the one mouse regression a user would notice immediately.
    const fixtureUseMouse = resolveUseMouse({
      noMouse: env.GTH_NO_MOUSE,
      term: env.TERM,
      stdoutIsTTY: !!stdout.isTTY,
      stdinIsTTY: !!stdin.isTTY,
    });
    const fixtureMouse = createMouseSession(fixtureUseMouse);
    const instance = render(
      <App
        agent={createFixtureTuiAgent(fixturePath)}
        mode={sessionConfig.mode}
        mouseEnabled={fixtureUseMouse}
        subscribeMouse={fixtureMouse.subscribe}
        onSetMouse={(enabled) => fixtureMouse.setEnabled(enabled)}
        // TUI-C33: the banner is chrome, not model output, so the hermetic e2e branch shows it too
        // — that is what lets the PTY suite prove the art actually paints. No config here, so it
        // renders without the model/provider line.
        showLaunchBanner={!!stdout.isTTY}
        readyMessage={sessionConfig.readyMessage}
        exitMessage={sessionConfig.exitMessage}
        initialMessage={message}
        // QA-6: wire the real /debug-dump writer into the fixture branch too (same function
        // reference the non-fixture render uses below) so the e2e PTY suite can exercise the
        // actual archive-write path instead of only ever hitting the "unavailable" fallback.
        // resolvedConfig is deliberately left unset here — DebugDumpInput.config is
        // optional/opaque and the command already handles it being undefined.
        dumpDebugSession={dumpDebugSession}
      />,
      {
        stdin: fixtureMouse.stdin,
        alternateScreen: true,
        // TUI-C79 — the hermetic branch owns Ctrl+C exactly as the real session below does, so the
        // pty suite exercises the ladder itself rather than a fixture-only shortcut to Ink's exit.
        exitOnCtrlC: false,
      }
    );
    try {
      await instance.waitUntilExit();
    } finally {
      fixtureMouse?.dispose();
    }
    // TUI-C56 — this branch's exit is drained too, and it must be: it renders the real <App> with
    // the real `/debug-dump` writer wired in, so it is the branch the PTY suite proves the restored
    // screen on. The drain itself is `createTuiSession`'s, so this `return` reaches it exactly as
    // the production path's exit does — and so does a throw from this branch.
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
  // TUI-C35 — the TUI's one colour decision, taken here because it must precede every render.
  // `config.useColour` is what `resolveUseColour` already produced inside `initConfig`, so the
  // TUI honours NO_COLOR / FORCE_COLOR / `useColour` exactly as the plain surface does instead of
  // leaving chalk (which implements none of them but FORCE_COLOR) to decide on its own.
  applyTuiColour(config.useColour);
  // GS2-20: the session's checkpointer — durable (SQLite, beside the history store) when history is
  // on and the DB opens, so this session's LangGraph state outlives the process and the conversation
  // can be resumed with its tools and pending work intact. The fallback is a MemorySaver, never the
  // absence of one: with the tool-approval interrupt this surface installs, no saver at all throws
  // MISSING_CHECKPOINTER on the first gated call.
  //
  // Its notice goes into `startupAdvisories` rather than to the console, because everything from
  // here on is inside Ink's alternate screen — a `displayWarning` would be painted over, or swapped
  // away with the screen, and the user would never learn their session is not resumable.
  //
  // GS2-20: the checkpointer notifies at TWO different times, and `startupAdvisories` only works for
  // one of them. An open failure happens synchronously inside the call below, before Ink exists, so
  // it lands in the advisories the App is rendered with. A WRITE failure happens mid-session, long
  // after that array was read — pushing to it then would put the notice nowhere. So the notice is
  // routed through a reassignable hook: advisories until the status bridge exists, the bridge
  // afterwards, which reaches the mounted App's transcript as a WARNING system message.
  let emitNotice = (message: string): void => {
    startupAdvisories.push(message);
  };
  const checkpointer = openSessionCheckpointerSafe(config, {
    notify: (message) => emitNotice(message),
  });

  // GS2-20 — `--resume <id>`: decided here, before a row is opened or a log started, through the
  // same seam `/resume` uses once the App is up. This is still before the render phase, so a
  // refusal is printed to the plain console — Ink does not own the screen yet — and the process
  // leaves with status 1 and nothing changed. Not thrown: `startSession` would (correctly) treat a
  // pre-render throw as a config-class failure, and this is a person's typo, not a broken install.
  let bootResume: ResumeTarget | undefined;
  if (options.resumeConversationId !== undefined) {
    const resolution = await resolveResumeTarget(
      { config, checkpointer, workspace: getProjectDir() },
      options.resumeConversationId
    );
    if (!resolution.ok) {
      const notice = resumeRefusalNotice(resolution.refusal);
      displayNotice(notice.title, notice.lines, { tone: notice.tone ?? 'info' });
      checkpointer.close();
      exit(1);
      return;
    }
    bootResume = resolution.target;
  }

  // GS2-19: one conversation per TUI session; each completed turn (logTurn) is stamped with its id
  // so the whole chat groups under one conversation. Fail-soft (undefined when history is off or the
  // store did not open); turns fall back to per-turn conversations otherwise.
  //
  // GS2-20: it carries the thread id too — the link from the conversation `gth history list` prints
  // to the checkpoint holding this session's state. Written before the runner exists, because
  // `runner.init` can throw partway and a conversation with no thread recorded can never be resumed.
  //
  // GS2-20: a resumed session opens NO new row — its turns keep recording under the conversation it
  // re-entered. `let`, because `/resume` moves it and `logTurn` reads it live.
  let conversationId: number | undefined = bootResume
    ? bootResume.conversationId
    : (openConversationSafe(config, {
        command: sessionConfig.mode,
        // The conversation's PROJECT ROOT, not the directory this session is in: `getProjectDir()`
        // is the discovered config root whenever one was found above us. It is what the resume
        // workspace check compares, so nothing may render it as where the user was.
        project: getProjectDir(),
        model: config.modelDisplayName,
        threadId: checkpointer.threadId,
      }) ?? undefined);

  // GS2-20: tell the checkpointer which row to mark unresumable if a checkpoint write fails later.
  // Optional call — a spec that stubs the checkpointer with a plain object has nothing to bind.
  checkpointer.bindConversation?.(conversationId);

  const logFileName = getCommandOutputFilePath(config, sessionConfig.mode);
  if (logFileName) {
    initSessionLogging(logFileName, config.streamSessionInferenceLog);
  }

  const bridge = createStatusBridge();
  // GS2-20: from here on a checkpointer notice goes to the mounted App instead of the startup
  // advisories. An emit between this line and the render below reaches no listener and is dropped —
  // harmless only because nothing writes a checkpoint before `runner.init` returns, which is after
  // the App is mounted. Move either and this needs rethinking.
  emitNotice = (message: string): void => bridge.emit(StatusLevel.WARNING, message);
  // TUI-C20: the resolvers are hoisted so the debug bridge can read the SAME MCP instructions the
  // agent captured (via getMcpServerInstructions) for the /debug MCP tab — not a second capture.
  const resolvers = createResolvers();
  const debugBridge = createDebugBridge(config, resolvers);
  const approvalBridge = createApprovalBridge();
  const attackHaltBridge = createAttackHaltBridge();
  const negotiationBridge = createNegotiationBridge();
  /**
   * [[EXT-194]] — **the one place a still-open prompt is answered**, so no teardown path can answer
   * one bridge and forget the other. That is not hypothetical: the `catch` below answered the
   * approval prompt and not the attack banner, so a session that threw with a banner on screen left
   * that prompt unanswered entirely — no reply, no record, nothing — while the sentence "every
   * still-open prompt is answered on teardown" stayed true of the exit path a reader would check
   * first. A second line in the `catch` would have fixed that instance and left a third bridge to be
   * forgotten the same way; one closure that answers all of them cannot be half-called.
   *
   * [[EXT-110]] is what they are answered WITH: a teardown, which refuses the call exactly as a
   * reject did while leaving the archive able to say that nobody was at the keyboard.
   *
   * `negotiationBridge` is deliberately absent. Nothing there is being answered — a round is an
   * event the run reports on its way past — so there is nothing outstanding to release.
   *
   * ## Every way this session can end, and what each one answers
   *
   * **Read the reason before the list.** The first four have nothing to answer, and not one of them
   * is safe because somebody checked it. They are safe because **a prompt cannot be open until
   * `setToolApprovalCallback` and `setAttackHaltCallback` have run**, and that wiring sits below
   * every one of them — the first three leave before the bridges are even constructed, a few lines
   * above. Move the wiring up and those ends become live, silently and with nothing to say so. That
   * invariant, not the list, is what makes the next asymmetry cheap to find.
   *
   *  1. the hermetic fixture branch's `return` — nothing wired
   *  2. the `--resume` refusal's `exit(1)` — nothing wired
   *  3. a throw before the `try` (config load, checkpointer open, resume resolution, runner
   *     construction) — nothing wired
   *  4. a throw inside the `try` but before the wiring (`runner.init`) — reaches 6 and answers both
   *     bridges, which by then exist with nothing outstanding on either
   *  5. `onExit` — every deliberate exit, Ctrl+C included, via [[TUI-C79]]'s ladder: answers both
   *  6. the `catch` — a render-phase throw, the one exit that can carry a live prompt: answers both
   *  7. the session's `finally` — runs after 5 and 6 have answered; not an answering seam
   *  8. `createTuiSession`'s outer `finally` — the exit-output drain; the bridges are out of scope
   *
   * The answer deliberately does NOT live in 7, where no future branch could miss it. A `finally`
   * runs after `runner.cleanup()`, and a suspended run has to be released BEFORE cleanup rather than
   * after — so unforgettable placement would buy its reliability by changing fail-closed ordering.
   * It would also make 5 and 6 redundant, and the test that pins each of them would stop biting.
   */
  const answerOpenPrompts = (): void => {
    approvalBridge.abortPending();
    attackHaltBridge.abortPending();
  };
  // B5: TUI code/chat ask for the LEAN backend, which is the only one Gaunt Sloth ships — the
  // `config.agent.backend` seam is still read but can name nothing else. Mirrors the readline path
  // in createInteractiveSession, askCommand, and execCommand — the TUI is the default interactive
  // surface, so it must match. createResolvers() is unchanged, so the session keeps the full toolset.
  const runner = new GthAgentRunner(bridge.emit, resolvers, resolveAgentFactory(config, 'lean'));

  // GS2-93: the interactive TUI ALWAYS shows the technical run-header preamble (Workdir/Model/
  // Tools/Middleware). The `output.header` rungs grade non-TUI text modes only, so the config
  // handed to the agent forces the full rung regardless of the user's setting — the header lines
  // route through the status bridge into the notice surface here, not raw stdout. A fresh object
  // (not an in-place mutation) so nothing else that already captured `config` is affected.
  const agentConfig: GthConfig = { ...config, output: { ...config.output, header: 'debug' } };

  // TUI-C37 — declared out here so the catch path can tear the terminal back down too. A throw
  // between render and unmount is exactly when a terminal gets left in mouse-reporting mode.
  let mouseSession: MouseSession | undefined;

  try {
    await runner.init(sessionConfig.mode, agentConfig, checkpointer.saver, {
      threadId: checkpointer.threadId,
    });

    // GS2-20 — Ruling 3: every grant made at the approval dialog is written against the
    // conversation as it lands, so it outlives the process and a resume installs it again. Reads
    // the LIVE `conversationId`, because `/resume` moves it. Optional call, like `bindConversation`:
    // a spec that stubs the runner with a plain object has nothing to listen with.
    runner.setSessionGrantsListener?.(() => {
      saveConversationGrantsSafe(config, conversationId, runner.getSessionScopedGrants());
    });

    // GS2-20 — the boot half of `--resume`: the SAME apply call the `/resume` agent method makes
    // below, after `runner.init` built the graph on a thread of its own. One seam for both
    // spellings; breaking it breaks both.
    if (bootResume) await applyResumeTarget({ runner, checkpointer }, bootResume);

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

    // [[EXT-150]] — the return leg of the same conversation: what the answer LANDED as, which the
    // runner knows only after the callback above has returned and the write has been attempted.
    // Without it the dialog's confirmation can only describe the key that was pressed, and on a
    // checkout the deny file cannot be written that confirmation contradicts core's own ERROR.
    runner.setApprovalOutcomeCallback(approvalBridge.report);

    // [[TUI-C68]] §6.1 — the attack banner. An `attack` verdict ends the run, and wiring this is
    // what opts this session into being asked first; a surface that never wires it keeps the halt,
    // so forgetting fails safe. The readline counterpart is in createInteractiveSession.
    runner.setAttackHaltCallback((halt) => attackHaltBridge.request(halt));

    // [[TUI-C69]] §5.4/§5.5 — **this surface has a live display**, so the §5 negotiation is drawn
    // round by round as it happens and a negotiated approval is held visible before it takes
    // effect. Wiring it is the opt-in for both: a surface that wires nothing (an `exec` run, CI)
    // neither draws nor sleeps, which is what keeps the 800 ms off every headless run.
    runner.setNegotiationDisplay(negotiationBridge);

    // Attach the debug sink to the live agent (opt-in; the agent's wrapModelCall middleware
    // reads it lazily, so this only enables capture for the TUI's /debug panel — the AG-UI
    // contract is untouched). The lean agent extends GthAbstractAgent and installs the capture
    // middleware, so the panel populates.
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
        // [[TUI-C27]] — the approvals gate's record of every gated decision, read from the live
        // runner at CALL time for the same reason the model request is.
        approvals: runner.getApprovalCaptures(),
        // [[EXT-159]] — why the last turn ended, and the provider's own stop tokens for it. Read at
        // CALL time like everything above, and threaded whenever it can be read at all: a `null`
        // REASON is the archive's record that no site classified the ending, which is the reading a
        // maintainer most needs. A failed READ is a third thing and omits the section instead, so
        // "nobody classified this turn" and "this session could not report it" stay distinguishable
        // — and a diagnostics field can never be what stops the diagnostics being written.
        termination: readTermination(runner),
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

      // GS2-7 (B20): local, fail-soft history — records each completed turn as a session unless
      // `history.enabled` is false. Independent of the per-run md log (so it works even with
      // writeOutputToFile off) and fully guarded, so it never affects the session.
      // GS2-16 threads token/tool/duration analytics; costUsd is left unset (no reliable price).
      recordSessionSafe(config, {
        conversationId, // GS2-19: group every turn under this session's conversation
        command: sessionConfig.mode,
        // The turn's PROJECT ROOT, not the directory this session is in — see the same field on
        // the conversation row above.
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
      // [[EXT-159]] — why the turn that just ended ended. The App reads this after the event
      // stream is done and commits it to the transcript, which is how a stop reaches the person
      // watching instead of only a dump they will never make.
      getTerminationReason() {
        return runner.getTerminationReason();
      },
      // [[EXT-158]] — and whether that turn left checklist work outstanding, read at the same
      // moment and for the same reason: after the stream is done, as a value rather than an event.
      getOutstandingWork() {
        return runner.getOutstandingWork();
      },
      // [[EXT-178]] — and, for the surfaces that ask, a recap of the turn. The runner owns the
      // call because the runner owns the config; the App is never given a live model, and this is
      // the seam that keeps it that way.
      requestRunRecap(reason) {
        return runner.requestRunRecap(reason);
      },
      // `/clear` rotates the runner's thread_id so the model context truly matches the
      // cleared transcript (the checkpointer otherwise replays the whole prior conversation), and
      // ([[EXT-109]]) drops the approvals capture log the Auto-mode tab and `/debug-dump` read.
      // The runner's `resetThread` is deliberately NOT what this calls: that one is the per-turn
      // rotation the conversational surfaces make, and the log must survive it there.
      clearConversation() {
        runner.clearConversation();
      },
      // CFG-27 — `/approvals <rung>` switches the runner's session rung. Returns the posture the
      // runner LANDED on, so the notice and the status badge describe the real state rather than
      // the requested one.
      setApprovalRung(rung) {
        runner.setSessionApprovalRung(rung);
        return runner.getSessionApprovals();
      },
      // CFG-27 — the read-only `/approvals` display. Kept separate from the setter so showing
      // status can never mutate session state.
      getApprovals() {
        return {
          approvals: runner.getSessionApprovals(),
          allowlist: runner.getAllowlistCounts(),
          refusals: runner.getRefusals(),
          grants: runner.getGrants(),
          trust: runner.getMcpAnnotationTrust(),
        };
      },
      // [[EXT-107]] — `/approvals undeny <n>`: lift one refusal by its number in the list
      // `getApprovals` just returned. Returns the landed outcome so the notice describes what was
      // actually lifted rather than what was asked for.
      liftRefusal(index) {
        return runner.liftRefusal(index);
      },
      // EXT-70 §4.7.1 — `/approvals trust|untrust <server> <hint…>`. Returns the landed change so
      // the notice describes the trust actually in force, and so it can state §4.7.4's consequence
      // at the moment trust is withdrawn.
      setMcpAnnotationTrust(server, hints, believe) {
        return runner.setMcpAnnotationTrust(server, hints, believe);
      },
      // GS2-23 — `/compact [focus]`: the runner folds the older conversation in the live graph
      // and reports what landed; the App commits the notice from that.
      compactConversation(input) {
        return runner.compactConversation(input);
      },
      // EXT-161 — `/autocompact` and the `/status` threshold line. Both go through the runner,
      // which reads the SAME controller the context guard consults before every model call, so
      // the number on screen is the number being enforced.
      getAutocompactStatus() {
        return runner.getAutocompactStatus();
      },
      setAutocompactThreshold(budget) {
        return runner.setAutocompactThreshold(budget);
      },
      // GS2-20 — `/resume <id>`: resolve and apply through the seam `--resume` used above, then
      // move THIS module's recorder id so `logTurn` records the next turn under the resumed
      // conversation. The App gets back exactly what was decided.
      async resumeConversation(id) {
        const resolution = await resolveResumeTarget(
          { config, checkpointer, workspace: getProjectDir(), current: conversationId },
          id
        );
        if (!resolution.ok) return resolution;
        await applyResumeTarget({ runner, checkpointer }, resolution.target);
        conversationId = resolution.target.conversationId;
        return resolution;
      },
    };

    // TUI-C31 (d): from here on Ink owns the terminal frame. Mark the tool-output channel
    // suppressed so a straggler child that outlived a turn's kill grace and emits BETWEEN turns
    // (when no per-turn subscriber is attached) is dropped rather than written raw over the
    // managed frame. Per-turn output is unaffected — the active subscriber always takes
    // precedence — and the `finally` below clears it on every exit path, restoring the headless
    // stdout sink once the TUI is gone.
    setToolOutputSuppressed(true);
    // CFG-47 — the render phase starts here. Everything above is work the readline path also does
    // (config load, conversation, session logging, runner construction and `runner.init`); from
    // this line on it is the TUI's own terminal takeover, so a failure past here is one falling
    // back to readline can actually fix. See the note on this function.
    onRenderStart?.();
    // TUI-C37 — mouse plumbing, built only when the resolved ladder says so. When it is off,
    // nothing is installed and Ink receives the real stdin, so the session is byte-identical to one
    // built before mouse existed — which is what keeps the non-TTY and piped cases honest.
    // Always built, started in the config's state: `/mouse on` has to work in a session that began
    // with mouse off, and Ink can only ever be handed one stdin.
    mouseSession = createMouseSession(config.useMouse);
    const instance = render(
      <App
        agent={tuiAgent}
        mouseEnabled={config.useMouse}
        subscribeMouse={mouseSession?.subscribe}
        onSetMouse={(enabled) => mouseSession?.setEnabled(enabled)}
        mode={sessionConfig.mode}
        modelDisplayName={config.modelDisplayName}
        // The launch banner and the status bar both name the provider beside the model, and both
        // read it from here.
        modelProviderType={config.modelProviderType}
        // TUI-C33: same stdout.isTTY gate as the viewport bump above — piped/non-TTY runs get no
        // banner. The App additionally scopes it to the intro (pre-first-exchange) frame.
        showLaunchBanner={!!stdout.isTTY}
        initialApprovals={runner.getSessionApprovals()}
        configSummary={formatConfigSummary(config, sessionConfig.mode)}
        resolvedConfig={config}
        dumpDebugSession={dumpDebugSessionWithModelRequest}
        advisories={startupAdvisories}
        mcpFailures={mcpFailures}
        // GS2-7 (B20) / GS2-88 — `/history` `/insights` `/search`, from the builder core owns and
        // every interactive surface shares, so this one cannot serve a different set from the
        // plain readline session's. It carries `historyAvailability` as well as the summaries, so
        // a command with nothing to show names the reason it actually established.
        {...buildHistorySlashProps(config)}
        // GS2-20 — the conversation `/status` names, what a bare `/resume` offers (read live, so
        // the session is never offered the conversation it has moved to), and the resumed
        // conversation whose banner and turns seed the transcript on a `--resume` start.
        conversationId={conversationId}
        listResumeCandidates={() => listResumeCandidates(config, conversationId)}
        resumed={bootResume}
        readyMessage={sessionConfig.readyMessage}
        exitMessage={sessionConfig.exitMessage}
        initialMessage={message}
        subscribeStatus={bridge.subscribe}
        subscribeDebug={debugBridge.subscribe}
        subscribeApproval={approvalBridge.subscribe}
        subscribeAttackHalt={attackHaltBridge.subscribe}
        subscribeNegotiation={negotiationBridge.subscribe}
        // [[TUI-C27]] — the Auto-mode debug tab reads the gate's decisions from the live runner,
        // at RENDER time, for the same reason `/debug-dump` reads them at call time: the log is
        // mutated in place as each decision is made, so anything snapshotted earlier is a
        // decision-in-progress frozen halfway.
        readApprovalCaptures={() => runner.getApprovalCaptures()}
        onTurnComplete={logTurn}
        onExit={async () => {
          // Fail-closed: answer every prompt still awaiting a decision before tearing down, so a
          // suspended run can never hang on an unanswered one. Ctrl+C at either of those prompts
          // reaches this, because [[TUI-C79]] routes it through <App>'s `quit()` rather than
          // through an Ink unmount that would have torn the session down without running any of
          // this. Before `runner.cleanup()`, which is the ordering: the suspended run is released
          // first, then cleaned up.
          answerOpenPrompts();
          await runner.cleanup();
          stopSessionLogging();
        }}
      />,
      {
        // TUI-C37 — Ink reads the FILTERED stdin so mouse reports never reach its keyboard path
        // and get typed into the prompt.
        stdin: mouseSession.stdin,
        // TUI-C48 — the whole session lives in the alternate screen, so the conversation is a
        // viewport we own rather than the terminal's scrollback, and the user's screen comes back
        // untouched on exit. The restore is ENTIRELY Ink's and covers unmount, a thrown error,
        // `process.exit`, an uncaught exception, and SIGINT/SIGTERM/SIGHUP — measured, which is
        // why there is no second teardown path here to drift out of step with it. Ink correctly
        // no-ops the whole thing on a non-interactive or non-TTY stream.
        //
        // One consequence to design around rather than discover: Ink treats alternate-screen
        // teardown output as disposable, so nothing written during unmount survives onto the
        // restored screen. Anything the user must keep has to be written AFTER unmount.
        alternateScreen: true,
        // TUI-C79 — Ctrl+C belongs to <App>, which answers it as a ladder (scrap the draft, else
        // stop the turn, else leave). Ink's default unmounts on the byte before any subscriber sees
        // it, which loses a composed message to the reflex for scrapping a line and ends the session
        // to the reflex for stopping a runaway turn. Handing the key over is what makes both
        // reachable — and it routes every exit through `onExit` below, which Ink's own unmount skips.
        // <SelectList> already does the same for its own nested render.
        exitOnCtrlC: false,
      }
    );

    await instance.waitUntilExit();
    // TUI-C37 — restore the terminal the moment Ink is done with it. The process-level hooks
    // installed alongside remain as the backstop for the paths that never get here.
    mouseSession?.dispose();
  } catch (err) {
    mouseSession?.dispose();
    // [[EXT-194]] — the render-phase throw is the one exit that can carry a prompt nobody answered:
    // <App> never reached its own quit, so `onExit` above never ran and this is the only teardown
    // there is. The same closure as that path, in the same position before `runner.cleanup()`.
    answerOpenPrompts();
    await runner.cleanup();
    stopSessionLogging();
    throw err;
  } finally {
    // TUI-C31 (d): the TUI has unmounted (normal exit or throw) — restore the headless stdout
    // sink so any later tool output is no longer suppressed once Ink no longer owns the frame.
    setToolOutputSuppressed(false);
    // GS2-20: release the checkpoint DB connection here, where both the normal exit and the throw
    // path pass through. On win32 an unclosed handle blocks the file from being replaced or
    // reopened until the process exits.
    checkpointer.close();
  }
}
