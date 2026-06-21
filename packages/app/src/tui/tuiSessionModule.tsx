import React from 'react';
import { render } from 'ink';
import { type CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import {
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { appendToFile, getCommandOutputFilePath } from '@gaunt-sloth/core/utils/fileUtils.js';
import { env, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createResolvers } from '@gaunt-sloth/agent/resolvers.js';
import { gthDeepAgentFactory } from '@gaunt-sloth/agent/core/gthDeepAgentFactory.js';
import { GthDeepAgent } from '@gaunt-sloth/agent/core/GthDeepAgent.js';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import type { BaseMessage } from '@langchain/core/messages';
import { App } from '#src/tui/components/App.js';
import type { TuiAgent, TuiDebugCapture } from '#src/tui/types.js';
import { renderHistory, renderRequestDetails, renderResponse } from '#src/tui/debugRender.js';
import { viewportBumpSequence } from '#src/tui/terminal.js';
import type { DebugRequestExtras } from '@gaunt-sloth/agent/core/debugCapture.js';

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

/** Fan-out so the deep agent's wrapModelCall debug sink can reach the mounted React app. */
function createDebugBridge() {
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
      onRequest: (messages: BaseMessage[], extras?: DebugRequestExtras) =>
        emit({
          kind: 'request',
          text: renderHistory(messages),
          details: renderRequestDetails(extras),
        }),
      onResponse: (response: unknown) => emit({ kind: 'response', text: renderResponse(response) }),
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
        onResetFrame={() => resetFrame?.()}
      />
    );
    resetFrame = () => instance.clear();
    await instance.waitUntilExit();
    return;
  }

  const config = { ...(await initConfig(commandLineConfigOverrides)) };
  const checkpointSaver = new MemorySaver();
  const logFileName = getCommandOutputFilePath(config, sessionConfig.mode);
  if (logFileName) {
    initSessionLogging(logFileName, config.streamSessionInferenceLog);
  }

  const bridge = createStatusBridge();
  const debugBridge = createDebugBridge();
  const runner = new GthAgentRunner(bridge.emit, createResolvers(), gthDeepAgentFactory);

  try {
    await runner.init(sessionConfig.mode, config, checkpointSaver);

    // Attach the debug sink to the live deep agent (opt-in; the wrapModelCall middleware reads
    // it lazily, so this only enables capture for the TUI's /debug panel — the lean/AG-UI
    // contracts are untouched). Guarded by an instanceof so a non-deep agent simply has no
    // debug capture rather than failing.
    const agent = runner.getAgent();
    if (agent instanceof GthDeepAgent) {
      agent.debugCapture = debugBridge.capture;
    }

    const logTurn = (userInput: string, assistantText: string) => {
      if (!logFileName) return;
      appendToFile(logFileName, `## User\n\n${userInput}\n\n## Assistant\n\n${assistantText}\n\n`);
      flushSessionLog();
    };

    const tuiAgent: TuiAgent = {
      async *runTurn(userInput, signal) {
        yield* runner.processMessagesWithEvents([new HumanMessage(userInput)], signal);
      },
      // `/clear` rotates the runner's thread_id so the model context truly matches the
      // cleared transcript (the checkpointer otherwise replays the whole prior conversation).
      resetThread() {
        runner.resetThread();
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
    const instance = render(
      <App
        agent={tuiAgent}
        mode={sessionConfig.mode}
        modelDisplayName={config.modelDisplayName}
        readyMessage={sessionConfig.readyMessage}
        exitMessage={sessionConfig.exitMessage}
        initialMessage={message}
        subscribeStatus={bridge.subscribe}
        subscribeDebug={debugBridge.subscribe}
        onTurnComplete={logTurn}
        onResetFrame={() => resetFrame?.()}
        onExit={async () => {
          await runner.cleanup();
          stopSessionLogging();
        }}
      />
    );
    resetFrame = () => instance.clear();

    await instance.waitUntilExit();
  } catch (err) {
    await runner.cleanup();
    stopSessionLogging();
    throw err;
  }
}
