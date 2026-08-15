/**
 * @packageDocumentation
 * Gaunt Sloth's ACP (Agent Client Protocol) **v2** agent, built on the official SDK's
 * `experimental/v2` surface.
 *
 * ## One of two dialects
 *
 * v1 is ACP's stable protocol and v2 is a draft, and the agent serves **both**: `acpRouter.ts`
 * reads the `protocolVersion` on the first `initialize` and hands the connection to the matching
 * app, so a host gets the dialect it asked for. This file is the v2 half; `acpAgentAppV1.ts` is
 * the v1 half. Serving only v2 would cut the surface off from every shipping editor that speaks
 * ACP today — measured against Zed 1.15.0 stable, which sends `protocolVersion: 1` as a literal
 * with no setting to change it.
 *
 * ## Shape
 *
 * v2's agent side is a fluent app builder: `acp.agent()` returns an {@link AgentApp} on which
 * typed handlers are registered by ACP method name, and `connect()` serves a client — either over
 * a transport stream or, for tests, directly against a `ClientApp`. The SDK's v1 entry point offers
 * the same builder, which is why the two dialects read alike even though their handlers differ.
 *
 * ## The prompt lifecycle is the part that looks wrong until you read the spec
 *
 * This is also the sharpest difference from v1, which answers the prompt request with the stop
 * reason itself. In v2 `session/prompt` returns `{}` **as soon as the prompt is accepted** — not
 * when the turn finishes.
 * Progress, tool calls and the final stop reason all arrive as `session/update` notifications, and
 * the turn is over when an idle `state_update` carrying a stop reason lands. That is what makes
 * cancellation expressible at all: a cancelled turn reports `cancelled` on a `state_update`, while
 * the prompt request it belongs to was answered long before. A client that waited on the prompt
 * response for the result would hang through every tool call.
 *
 * ## Why a runner and not an agent
 *
 * Each session drives a {@link GthAgentRunner}, not a bare agent. The runner is where the
 * tool-approval gate lives, so this is also the surface where `session/request_permission` is
 * wired — see `acpPermissions.ts` for why that is not optional.
 *
 * ## One workspace per process
 *
 * Config discovery, the filesystem tools' allowed root, grep and the shell tool ALL resolve
 * through `getCurrentWorkDir()`, a process-global. So the workspace is bound by the first
 * `session/new` and a later `session/new` naming a different `cwd` is refused rather than served
 * from the wrong root. An editor spawns one agent process per project, which is exactly the shape
 * this serves; the alternative — letting the second session silently re-root the first session's
 * tools — is the kind of quiet wrongness that is worse than an error a host can report.
 */

import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { createResolvers } from '#src/resolvers.js';
import { resolveAgentFactory } from '#src/core/resolveAgentFactory.js';
import { AcpUpdateMapper } from '#src/modules/acp/acpUpdates.js';
import { decisionForOutcome, permissionRequestFor } from '#src/modules/acp/acpPermissions.js';
import {
  ACP_AGENT_NAME,
  ACP_AGENT_TITLE,
  CLOSE_TURN_DRAIN_MS,
  acpStatusCallback,
  agentVersion,
  announceAcpStart,
  drainWithDeadline,
  isSameWorkspace,
  loadConfigForCwd,
  promptText,
  resolveAcpSessionCommand,
} from '#src/modules/acp/acpCommon.js';
import type { AcpAgentAppOptions } from '#src/modules/acp/acpCommon.js';

export { ACP_AGENT_NAME, ACP_AGENT_TITLE, announceAcpStart, isSameWorkspace };
export type { AcpAgentAppOptions };

/** One live ACP session: its workspace, its runner, and the turn currently running in it. */
interface AcpSession {
  sessionId: string;
  cwd: string;
  runner: GthAgentRunner;
  /**
   * Connection-scoped handle for calling client methods. Captured when the session is created and
   * used for the whole session, because almost everything this agent sends the client happens
   * AFTER the request that caused it has been answered — every `session/update` of a turn, and the
   * permission requests inside it, are sent while no inbound request is in flight.
   */
  client: acp.AgentContext;
  /** Aborts the running turn; `null` between turns. */
  abort: AbortController | null;
  /**
   * The running turn, so `session/close` can wait for it to finish unwinding. `runTurn` never
   * rejects, so awaiting it is always safe. `null` between turns.
   */
  turn: Promise<void> | null;
  /**
   * Set by `session/close` before anything else, so a prompt accepted moments earlier — whose turn
   * is deferred to the next tick — does not start against a session that is going away.
   */
  closed: boolean;
  /** Set when `session/cancel` arrives, so the turn reports `cancelled` rather than `end_turn`. */
  cancelled: boolean;
  /** Message-level history, replayed on `session/resume` with `replayFrom`. */
  replayLog: acp.SessionUpdate[];
}

/**
 * Builds the ACP v2 agent app. Register-and-return only: nothing is connected and no config is
 * read until a client connects and creates a session.
 */
export function createAcpAgentApp(options: AcpAgentAppOptions = {}): acp.AgentApp {
  const loadConfig = options.loadConfig ?? loadConfigForCwd;
  const agentFactoryFor = options.agentFactory ?? ((config) => resolveAgentFactory(config, 'lean'));

  const sessions = new Map<string, AcpSession>();
  /** The workspace this process is serving, bound by the first `session/new`. */
  let workspaceRoot: string | undefined;
  /**
   * `session/new` requests that have claimed the workspace and are still building their session.
   *
   * Counted so a release can tell "nothing depends on this binding" from "the session that depends
   * on it does not exist yet". Without it, one `session/new` failing while a concurrent one is still
   * loading would clear the root out from under the survivor, and a third request could then bind a
   * different directory — the same race the claim closes, reopened by the cleanup.
   */
  let pendingSessions = 0;

  /**
   * Release the workspace binding when nothing — live or in flight — still depends on it.
   *
   * The binding exists to stop a second workspace re-rooting a LIVE session's tools; with no session
   * and nothing building one there is nothing to re-root, and holding it would refuse a workspace
   * for no reason left.
   */
  const releaseWorkspaceIfIdle = (): void => {
    if (sessions.size === 0 && pendingSessions === 0) workspaceRoot = undefined;
  };

  const sessionOrThrow = (sessionId: string): AcpSession => {
    const session = sessions.get(sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(
        { sessionId },
        `No such session: ${sessionId}. Create one with session/new.`
      );
    }
    return session;
  };

  /** Send one `session/update`. Notifications, so nothing here waits on the client. */
  const sendUpdate = async (session: AcpSession, update: acp.SessionUpdate): Promise<void> => {
    await session.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: session.sessionId,
      update,
    });
  };

  const sendState = async (session: AcpSession, state: acp.StateUpdate): Promise<void> => {
    await sendUpdate(session, { sessionUpdate: 'state_update', ...state } as acp.SessionUpdate);
  };

  /**
   * Runs one prompt turn to completion and reports it entirely through notifications.
   *
   * Never rejects: this is started detached from the `session/prompt` request (which has already
   * been answered), so a throw here would be an unhandled rejection rather than an error anyone
   * sees. Every exit — success, cancellation, failure — ends on an idle `state_update` with a stop
   * reason, because that notification is the ONLY thing that tells a client the turn is over.
   */
  const runTurn = async (session: AcpSession, prompt: acp.ContentBlock[]): Promise<void> => {
    const mapper = new AcpUpdateMapper();
    const abort = new AbortController();
    session.abort = abort;
    session.cancelled = false;

    const text = promptText(prompt);
    const userMessageId = randomUUID();
    /** Assistant text accumulated per message id, so the replay log can carry whole messages. */
    const assistantText = new Map<string, string>();
    let stopReason: acp.StopReason = 'end_turn';

    try {
      // The spec's step 2: after accepting the prompt, report where the user message landed.
      const userMessage: acp.SessionUpdate = {
        sessionUpdate: 'user_message',
        messageId: userMessageId,
        content: prompt,
      };
      session.replayLog.push(userMessage);
      await sendUpdate(session, userMessage);
      await sendState(session, { state: 'running' });

      // The gate's last hop. Registered per turn so it closes over THIS turn's mapper, which is
      // what knows the id of the tool call a permission request is about.
      session.runner.setToolApprovalCallback(async (pending) => {
        await sendState(session, { state: 'requires_action' }).catch(() => undefined);
        try {
          const response = await session.client.request(
            acp.CLIENT_METHODS.session_request_permission,
            permissionRequestFor({
              sessionId: session.sessionId,
              pending,
              toolCallId: mapper.claimToolCallId(pending.name, pending.args),
              cwd: session.cwd,
            }),
            // The spec's cancellation cascade: when the turn is cancelled, outstanding permission
            // requests are cancelled too, so the client can take its prompt off the screen instead
            // of asking about work that has already stopped. Cooperative by design — the promise
            // still settles on the peer's eventual answer — which is why `session/close` bounds its
            // wait rather than trusting this to end it.
            { cancellationSignal: abort.signal }
          );
          return decisionForOutcome(response.outcome);
        } finally {
          // Never allowed to become the callback's result. A notification that fails — the usual
          // reason being the connection going away mid-prompt — must not turn a decision the human
          // actually made into an error the runner records as a failed gate.
          await sendState(session, { state: 'running' }).catch(() => undefined);
        }
      });

      for await (const event of session.runner.processMessagesWithEvents(
        [new HumanMessage(text)],
        abort.signal
      )) {
        for (const update of mapper.map(event)) {
          if (update.sessionUpdate === 'agent_message_chunk') {
            const chunk = update as { messageId: string; content: { text?: string } };
            assistantText.set(
              chunk.messageId,
              (assistantText.get(chunk.messageId) ?? '') + (chunk.content.text ?? '')
            );
          }
          if (update.sessionUpdate === 'tool_call_update') {
            session.replayLog.push(update);
          }
          await sendUpdate(session, update);
        }
      }
      if (session.cancelled || abort.signal.aborted) stopReason = 'cancelled';
    } catch (error) {
      // A cancelled run surfaces as a thrown abort from whatever library noticed the signal first.
      // The spec is explicit that this must NOT reach the client as a generic failure, or a client
      // shows an error for something the user asked for.
      if (session.cancelled || abort.signal.aborted) {
        stopReason = 'cancelled';
      } else {
        // NOT `refusal`, which the spec defines as the agent declining to continue — a crash is
        // not a refusal, and a client would render it as one. v2 reserves custom stop reasons to
        // names beginning with an underscore, so this is the sanctioned way to say "stopped, and
        // none of the defined reasons is what happened".
        stopReason = '_error';
        const message = error instanceof Error ? error.message : String(error);
        displayWarning(`ACP session ${session.sessionId}: turn failed — ${message}`);
        await sendUpdate(session, {
          sessionUpdate: 'agent_message',
          messageId: randomUUID(),
          content: [{ type: 'text', text: `The agent could not complete this turn: ${message}` }],
        }).catch(() => {
          /* the connection is already gone; the idle state below is still attempted */
        });
      }
    } finally {
      session.runner.setToolApprovalCallback(null);
      session.abort = null;
      // `turn` is deliberately NOT cleared here: this runs inside the promise it holds, so clearing
      // it would let a `session/close` that reads the field in that instant skip the wait entirely.
      // A settled promise is harmless to await and the next prompt replaces it.
      for (const [messageId, content] of assistantText) {
        if (content.length > 0) {
          session.replayLog.push({
            sessionUpdate: 'agent_message',
            messageId,
            content: [{ type: 'text', text: content }],
          });
        }
      }
      // The turn is over only once this lands, whatever happened above.
      await sendState(session, { state: 'idle', stopReason }).catch(() => {
        /* connection closed mid-turn; nothing left to report to */
      });
    }
  };

  const closeSession = async (session: AcpSession): Promise<void> => {
    session.closed = true;
    session.cancelled = true;
    session.abort?.abort();
    sessions.delete(session.sessionId);
    // Wait for the aborted turn to finish unwinding before anything else. `cleanup()` does not do
    // this — it drops the agent and returns — so releasing the workspace below without the wait
    // would let a `session/new` for another directory reassign INIT_CWD out from under a turn still
    // running its last tool call. That is precisely the "re-rooting a live session's tools" hazard
    // the binding exists to prevent, so the release must not be the thing that opens it.
    //
    // BOUNDED, for the reason {@link CLOSE_TURN_DRAIN_MS} gives: a turn parked on a permission
    // request is waiting on the client, and no abort of ours can force that to settle.
    await drainWithDeadline(session.turn, CLOSE_TURN_DRAIN_MS);
    try {
      await session.runner.cleanup();
    } catch (error) {
      displayWarning(
        `ACP session ${session.sessionId}: cleanup failed — ${error instanceof Error ? error.message : String(error)}`
      );
    }
    releaseWorkspaceIfIdle();
  };

  return acp
    .agent({ name: ACP_AGENT_NAME })
    .onRequest(acp.AGENT_METHODS.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      info: { name: ACP_AGENT_NAME, title: ACP_AGENT_TITLE, version: agentVersion() },
      // `session: {}` claims the baseline session surface and nothing more. Per the v2
      // initialization spec the baseline is `session/new`, `session/list`, `session/resume`,
      // `session/close`, `session/prompt`, `session/cancel` and `session/update` — which is
      // exactly the set of handlers registered below. (The SDK's own type doc for this field
      // enumerates a shorter baseline; the protocol doc is the authority, and the handlers here
      // match it.)
      //
      // Nothing beyond it is advertised, because every capability is a promise a client will hold
      // us to: image and audio prompt content, MCP server transports, `session/delete`,
      // `session/fork` and `additionalDirectories` are the things this agent does not serve, so it
      // does not claim them.
      capabilities: { session: {} },
    }))
    .onRequest(acp.AGENT_METHODS.session_new, async ({ params, client }) => {
      const cwd = resolvePath(params.cwd);
      if (workspaceRoot !== undefined && !isSameWorkspace(workspaceRoot, cwd)) {
        throw acp.RequestError.invalidParams(
          { cwd: params.cwd, workspaceRoot },
          `This agent process is serving ${workspaceRoot}. Start a separate agent process for ${cwd}.`
        );
      }
      // **Claim the workspace BEFORE the first await, or the check above decides nothing.** Nothing
      // serialises inbound requests on a stdio connection, so two `session/new` calls naming
      // different directories both saw an unset root, both suspended on the config load, and both
      // assigned — leaving two live sessions in different workspaces, which is the exact state the
      // refusal exists to prevent. Testing and assigning either side of an await is not a check.
      workspaceRoot = cwd;
      pendingSessions += 1;
      try {
        const config = await loadConfig(cwd);

        const runner = new GthAgentRunner(
          acpStatusCallback,
          options.resolvers ?? createResolvers(),
          agentFactoryFor(config)
        );
        // The command a run is resolved under decides its toolset, its mode prompt and its
        // approvals posture. For an editor session that is `acp.mode`, defaulting to `code`.
        await runner.init(resolveAcpSessionCommand(config), config);

        const sessionId = randomUUID();
        sessions.set(sessionId, {
          sessionId,
          cwd,
          runner,
          client,
          abort: null,
          turn: null,
          closed: false,
          cancelled: false,
          replayLog: [],
        });
        return { sessionId };
      } finally {
        pendingSessions -= 1;
        // A `session/new` that never produced a session must not leave the process bound to its
        // directory — one bad config would otherwise refuse every later session for the life of the
        // agent. Released on the same condition `closeSession` uses, and counting the in-flight
        // requests as well as the live ones: a concurrent `session/new` that has claimed the root
        // and is still loading is exactly as much a reason to hold it as a session already running.
        releaseWorkspaceIfIdle();
      }
    })
    .onRequest(acp.AGENT_METHODS.session_list, ({ params }) => {
      const filter = params.cwd === undefined || params.cwd === null ? undefined : params.cwd;
      return {
        sessions: [...sessions.values()]
          .filter((session) => filter === undefined || session.cwd === resolvePath(filter))
          .map((session) => ({ sessionId: session.sessionId, cwd: session.cwd })),
      };
    })
    .onRequest(acp.AGENT_METHODS.session_resume, async ({ params }) => {
      const session = sessionOrThrow(params.sessionId);
      // Same comparison as the workspace binding, for the same reason: on win32 a client re-sending
      // its own cwd with different casing names the same directory.
      if (!isSameWorkspace(resolvePath(params.cwd), session.cwd)) {
        throw acp.RequestError.invalidParams(
          { cwd: params.cwd, sessionCwd: session.cwd },
          `Session ${session.sessionId} belongs to ${session.cwd}.`
        );
      }
      // `replayFrom` is an INCLUSIVE cursor and the only cursor type in v2 is `start`, so a request
      // that carries one asks for the whole conversation and anything else asks for none of it.
      // Replayed as message-level updates rather than as the original chunk stream: a client
      // rebuilding a transcript wants the messages, and re-emitting thousands of one-token chunks
      // to say the same thing would be a worse answer to the same question.
      if (params.replayFrom?.type === 'start') {
        for (const update of session.replayLog) await sendUpdate(session, update);
      }
      return {};
    })
    .onRequest(acp.AGENT_METHODS.session_close, async ({ params }) => {
      // Closing MUST cancel whatever is running, exactly as session/cancel would, before the
      // session's resources go away.
      await closeSession(sessionOrThrow(params.sessionId));
      return {};
    })
    .onRequest(acp.AGENT_METHODS.session_prompt, ({ params }) => {
      const session = sessionOrThrow(params.sessionId);
      if (session.abort) {
        throw acp.RequestError.invalidRequest(
          { sessionId: params.sessionId },
          'A prompt is already running in this session. Wait for the idle state update.'
        );
      }
      // Detached ON PURPOSE, and after this handler's response: the response only acknowledges
      // acceptance, and the turn reports itself through notifications. `setImmediate` (rather than
      // starting it inline) is what keeps the acknowledgement first on the wire — a client that
      // saw a `session/update` for a prompt it had not yet been told was accepted would be right
      // to treat it as a protocol error.
      setImmediate(() => {
        // A close that landed in the gap between accepting the prompt and this tick wins: starting
        // the turn now would run it against a session already torn down, and nothing would be
        // waiting for it.
        if (session.closed) return;
        session.turn = runTurn(session, params.prompt);
      });
      return {};
    })
    .onNotification(acp.AGENT_METHODS.session_cancel, ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) return;
      // Recorded as well as aborted: the abort makes the run stop, and the flag is what makes the
      // turn report `cancelled` instead of reading its own truncated stream as a normal finish.
      session.cancelled = true;
      session.abort?.abort();
    });
}
