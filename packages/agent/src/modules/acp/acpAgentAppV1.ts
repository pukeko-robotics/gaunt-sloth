/**
 * @packageDocumentation
 * Gaunt Sloth's ACP (Agent Client Protocol) **v1** agent, built on the official SDK's stable root
 * export. (`acpAgentApp.ts` is the v2 half; `acpRouter.ts` picks between them.)
 *
 * ## Why v1 is served at all
 *
 * v1 is ACP's stable protocol; v2 is a draft. Every shipping editor that speaks ACP today speaks
 * v1 — measured against Zed 1.15.0 stable, whose `initialize` carries `protocolVersion: 1` as a
 * literal with no setting to change it, and whose build does not compile the draft-v2 API at all.
 * An agent that serves only v2 cannot open a session with any of them.
 *
 * ## The shape is the same; the semantics are not
 *
 * The SDK's v1 entry point offers the same fluent app builder as v2 — `acp.agent()` returns an
 * `AgentApp`, handlers are registered by ACP method name, and `connect()` serves either a transport
 * or, in tests, a `ClientApp` directly. That similarity is a trap if it is mistaken for sameness.
 * Four differences decide what this file does, and none of them can be reached by renaming a v2
 * handler:
 *
 * 1. **`session/prompt` answers with the stop reason.** The turn runs INSIDE the request and the
 *    response is what tells the client it is over. v2 acknowledges immediately and reports the stop
 *    reason later on an idle `state_update`, which does not exist here.
 * 2. **A cancelled turn is a `cancelled` stop reason, never an error.** The v1 spec is explicit
 *    that agents MUST catch the abort their libraries throw and answer with the stop reason,
 *    because clients show unrecognized errors to the user and a cancellation is not one.
 * 3. **A FAILED turn is a JSON-RPC error**, because v1's `StopReason` union is closed —
 *    `end_turn | max_tokens | max_turn_requests | refusal | cancelled` — and none of them means
 *    "crashed". (This is exactly why v2 needed a custom `_error` reason: there, the response was
 *    already sent and the notification stream was the only channel left. Here the request is still
 *    open, so the error belongs in its response, and answering `end_turn` would be a lie.)
 * 4. **No `session/load`, and no `loadSession` capability.** In v1 that capability means sessions
 *    survive restarts and can be picked up by another client instance; these sessions live in one
 *    process and die with it. Clients MUST NOT call `session/load` unless it is advertised, so
 *    declining to advertise it is the conforming way to say so — and the same goes for
 *    `sessionCapabilities.resume`. Claiming either would be a promise this agent cannot keep.
 *
 * ## What carries over unchanged, because it must
 *
 * `session/request_permission` is wired to the approval gate, so [[EXT-54]]'s hole does not reopen
 * on a second surface; and the process serves ONE workspace, refusing a `session/new` that names a
 * different directory rather than silently re-rooting a live session's file tools. Both are
 * properties of this agent rather than of a protocol version, so both hold here exactly as they do
 * on v2.
 */

import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { createResolvers } from '#src/resolvers.js';
import { resolveAgentFactory } from '#src/core/resolveAgentFactory.js';
import { AcpV1UpdateMapper } from '#src/modules/acp/acpUpdatesV1.js';
import { decisionForOutcome, rememberedAnswerNote } from '#src/modules/acp/acpPermissions.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';
import { permissionRequestForV1 } from '#src/modules/acp/acpPermissionsV1.js';
import {
  ACP_AGENT_NAME,
  ACP_AGENT_TITLE,
  CLOSE_TURN_DRAIN_MS,
  acpStatusCallback,
  agentVersion,
  drainWithDeadline,
  isSameWorkspace,
  loadConfigForCwd,
  promptText,
  resolveAcpSessionCommand,
} from '#src/modules/acp/acpCommon.js';
import type { AcpAgentAppOptions } from '#src/modules/acp/acpCommon.js';

/** One live v1 session: its workspace, its runner, and the turn currently running in it. */
interface AcpV1Session {
  sessionId: string;
  cwd: string;
  runner: GthAgentRunner;
  /**
   * Connection-scoped handle for calling client methods. Captured when the session is created and
   * used for the whole session, because the `session/update` notifications a turn sends are not
   * tied to the request that is handling it.
   */
  client: acp.AgentContext;
  /** Aborts the running turn; `null` between turns. */
  abort: AbortController | null;
  /**
   * The running turn, so `session/close` can wait for it to finish unwinding. Never rejects, so
   * awaiting it is always safe. `null` between turns.
   */
  turn: Promise<void> | null;
  /**
   * Set when `session/cancel` arrives, so the turn answers `cancelled` rather than `end_turn`.
   * `closeSession` sets it too: on v1 this single flag is what stops a turn outliving its teardown,
   * because `runTurn` is entered synchronously from the `session/prompt` handler and there is no
   * gap between acknowledging a prompt and starting the turn for a separate closed flag to cover.
   */
  cancelled: boolean;
}

/**
 * Resolves with the `cancelled` permission outcome once `signal` aborts, and never otherwise.
 *
 * Used to race a permission request that the client may never answer. Resolving rather than
 * rejecting is deliberate: the caller turns this into a gate DECISION, and a rejection there would
 * be recorded as the gate failing rather than as the user's turn being stopped.
 */
function cancelledWhenAborted(signal: AbortSignal): Promise<acp.RequestPermissionOutcome> {
  const cancelled: acp.RequestPermissionOutcome = { outcome: 'cancelled' };
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise((resolveCancelled) => {
    signal.addEventListener('abort', () => resolveCancelled(cancelled), { once: true });
  });
}

/**
 * How a turn ended.
 *
 * A failure is carried out of the turn rather than thrown from it, so the handler can finish its
 * own bookkeeping before deciding what the client is told — and so `session.turn`, which a close
 * awaits, is a promise that cannot reject.
 */
type TurnOutcome =
  | { readonly ok: true; readonly stopReason: acp.StopReason }
  | { readonly ok: false; readonly message: string };

/**
 * Builds the ACP v1 agent app. Register-and-return only: nothing is connected and no config is
 * read until a client connects and creates a session.
 */
export function createAcpV1AgentApp(options: AcpAgentAppOptions = {}): acp.AgentApp {
  const loadConfig = options.loadConfig ?? loadConfigForCwd;
  const agentFactoryFor = options.agentFactory ?? ((config) => resolveAgentFactory(config, 'lean'));

  const sessions = new Map<string, AcpV1Session>();
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

  const releaseWorkspaceIfIdle = (): void => {
    if (sessions.size === 0 && pendingSessions === 0) workspaceRoot = undefined;
  };

  const sessionOrThrow = (sessionId: string): AcpV1Session => {
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
  const sendUpdate = async (session: AcpV1Session, update: acp.SessionUpdate): Promise<void> => {
    await session.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: session.sessionId,
      update,
    });
  };

  /**
   * Runs one prompt turn to completion and reports how it ended.
   *
   * Never rejects: the caller needs to answer the still-open `session/prompt` request, and it has
   * to be able to tell a cancellation from a crash to do that. Progress goes out as
   * `session/update` notifications; the outcome comes back here.
   */
  const runTurn = async (
    session: AcpV1Session,
    prompt: readonly acp.ContentBlock[]
  ): Promise<TurnOutcome> => {
    const mapper = new AcpV1UpdateMapper();
    const abort = new AbortController();
    session.abort = abort;
    session.cancelled = false;

    try {
      // Inside the try, so a throw here is reported as a failed turn rather than leaving
      // `session.abort` set by the prologue above and every later prompt refused as concurrent.
      const text = promptText(prompt);
      // No `user_message` echo. v1 replays a conversation only on `session/load`; during a turn the
      // client already has the message it just sent, and echoing it would draw it twice.
      //
      // [[EXT-154]] — the calls answered with one of the two REMEMBERING options, waiting to hear
      // what that answer landed as. Per turn, and keyed by the interrupt object rather than by
      // arrival, for the reason {@link ApprovalOutcome} gives: the runner drains gated calls as a
      // batch, so several can be open at once and a positional pairing would describe the wrong one.
      const rememberAsked = new Set<PendingToolInterrupt>();

      // The gate's last hop. Registered per turn so it closes over THIS turn's mapper, which is
      // what knows the id of the tool call a permission request is about.
      session.runner.setToolApprovalCallback(async (pending) => {
        const asked = session.client.request(
          acp.CLIENT_METHODS.session_request_permission,
          permissionRequestForV1({
            sessionId: session.sessionId,
            pending,
            toolCallId: mapper.claimToolCallId(pending.name, pending.args),
          }),
          // The spec's cancellation cascade: when the turn is cancelled, outstanding permission
          // requests are cancelled too, so the client can take its prompt off the screen instead of
          // asking about work that has already stopped.
          { cancellationSignal: abort.signal }
        );
        // **The abort has to be able to end this wait on its own.** `cancellationSignal` sends the
        // peer a `$/cancel_request` and then keeps waiting for its answer — cooperative by design.
        // The spec says a client MUST answer an outstanding permission request with the `cancelled`
        // outcome, but on v1 a client that does not would wedge the whole connection rather than
        // just this turn: the `session/prompt` request is still open, so it would never be answered
        // and the client would hold a pending request forever. (On v2 the prompt was acknowledged
        // long before, which is why bounding the CLOSE was enough there and is not here.)
        //
        // Racing the signal ends the wait locally. `cancelled` is what the spec says the answer
        // would have been, and {@link decisionForOutcome} turns it into a rejection — the same
        // fail-closed polarity every other unrecognised answer gets.
        const outcome = await Promise.race([
          asked.then((response) => response.outcome),
          cancelledWhenAborted(abort.signal),
        ]);
        const decision = decisionForOutcome(outcome);
        // [[EXT-154]] — noted from the DECISION, so the set holds exactly the answers that asked the
        // runner to store something. The cancellation this race synthesises, and an option id this
        // build does not know, both fail closed into a plain rejection and are therefore not noted —
        // the direction that cannot invent a promise.
        if (decision.scope === 'always') rememberAsked.add(pending);
        return decision;
      });

      // [[EXT-154]] — **and the answer comes back.** The runner records a remembering answer only
      // after the callback that gave it has returned, so *Allow and remember* / *Reject and remember*
      // were an offer nothing had ever checked was kept. This says what it was.
      //
      // v1 has no whole-message update, so the note is a chunk carrying **its own `messageId`** — a
      // change of id is what starts a new message in this dialect, and reusing the assistant's would
      // splice the line into whatever the model was saying. NOT a `tool_call_update`: on v1 that
      // update's `content` REPLACES rather than appends, so the tool's own output would erase the
      // note, or the note the output.
      //
      // Not awaited: this callback returns `void` and runs inside the runner's own continuation.
      // A send that fails is dropped, exactly as the turn's other notifications are.
      session.runner.setApprovalOutcomeCallback((outcome) => {
        if (!rememberAsked.delete(outcome.pending)) return;
        void sendUpdate(session, {
          sessionUpdate: 'agent_message_chunk',
          messageId: randomUUID(),
          content: { type: 'text', text: rememberedAnswerNote(outcome.decision, outcome.lifetime) },
        } as acp.SessionUpdate).catch(() => undefined);
      });

      for await (const event of session.runner.processMessagesWithEvents(
        [new HumanMessage(text)],
        abort.signal
      )) {
        for (const update of mapper.map(event)) await sendUpdate(session, update);
      }
      if (session.cancelled || abort.signal.aborted) return { ok: true, stopReason: 'cancelled' };
      return { ok: true, stopReason: 'end_turn' };
    } catch (error) {
      // A cancelled run surfaces as a thrown abort from whatever library noticed the signal first.
      // The spec is explicit that this MUST NOT reach the client as an error: clients render
      // unrecognized errors, and a user who pressed stop would be shown a failure for it.
      if (session.cancelled || abort.signal.aborted) return { ok: true, stopReason: 'cancelled' };
      const message = error instanceof Error ? error.message : String(error);
      displayWarning(`ACP session ${session.sessionId}: turn failed — ${message}`);
      return { ok: false, message };
    } finally {
      session.runner.setToolApprovalCallback(null);
      // [[EXT-154]] — cleared with its partner. Both close over this turn's state, and a stale one
      // left wired would report a later turn's answer into a set that can no longer contain it.
      session.runner.setApprovalOutcomeCallback(null);
      session.abort = null;
    }
  };

  const closeSession = async (session: AcpV1Session): Promise<void> => {
    session.cancelled = true;
    session.abort?.abort();
    sessions.delete(session.sessionId);
    // Wait for the aborted turn to finish unwinding before anything else. `cleanup()` does not do
    // this — it drops the agent and returns — so releasing the workspace below without the wait
    // would let a `session/new` for another directory reassign INIT_CWD out from under a turn still
    // running its last tool call.
    //
    // BOUNDED, for the reason CLOSE_TURN_DRAIN_MS gives: a turn parked on a permission request is
    // waiting on the client, and no abort of ours can force that to settle.
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
      // The version the CLIENT asked for, which the router has already checked this app can serve.
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: ACP_AGENT_NAME, title: ACP_AGENT_TITLE, version: agentVersion() },
      agentCapabilities: {
        // `loadSession` and `sessionCapabilities.resume` are deliberately absent: both promise a
        // session that outlives the process, and these do not. `promptCapabilities` is absent for
        // the same reason — omitted means the v1 baseline of text and resource links, which is
        // exactly what this agent reads; claiming `image`, `audio` or `embeddedContext` would
        // invite content it can only describe back.
        sessionCapabilities: { list: {}, close: {} },
      },
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
      // different directories would both see an unset root, both suspend on the config load, and
      // both assign. Testing and assigning either side of an await is not a check.
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
        //
        // **The checkpoint saver is not optional here, even though `init` accepts none.** A gated
        // tool call suspends the graph on a LangGraph interrupt, and an interrupt with nowhere to
        // checkpoint throws `MISSING_CHECKPOINTER` instead of asking the client for permission — so
        // without one every shell command in an editor session fails while the ungated built-ins
        // keep working. `MemorySaver` is the right lifetime as well as the right shape: these
        // sessions live in one process and die with it, which is also why `loadSession` is not
        // advertised.
        //
        // **Per session, not per process.** Each session owns its runner, its workspace and the
        // graphs suspended in it, and `sessions` holds several at once; one shared saver would pool
        // every session's checkpoint threads, so a `session/close` could clear state another
        // session is still parked on.
        await runner.init(resolveAcpSessionCommand(config), config, new MemorySaver());

        const sessionId = randomUUID();
        sessions.set(sessionId, {
          sessionId,
          cwd,
          runner,
          client,
          abort: null,
          turn: null,
          cancelled: false,
        });
        return { sessionId };
      } finally {
        pendingSessions -= 1;
        // A `session/new` that never produced a session must not leave the process bound to its
        // directory — one bad config would otherwise refuse every later session for the life of the
        // agent.
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
    .onRequest(acp.AGENT_METHODS.session_close, async ({ params }) => {
      // Closing MUST cancel whatever is running, exactly as session/cancel would, before the
      // session's resources go away.
      await closeSession(sessionOrThrow(params.sessionId));
      return {};
    })
    .onRequest(acp.AGENT_METHODS.session_prompt, async ({ params }) => {
      const session = sessionOrThrow(params.sessionId);
      if (session.abort) {
        throw acp.RequestError.invalidRequest(
          { sessionId: params.sessionId },
          'A prompt is already running in this session. Wait for it to answer.'
        );
      }
      // Started synchronously and recorded before anything can suspend: `runTurn` assigns
      // `session.abort` before its first await, and `session.turn` is what a concurrent
      // `session/close` waits on. A gap here is a close that skips the drain.
      const turn = runTurn(session, params.prompt);
      session.turn = turn.then(() => undefined);
      const outcome = await turn;
      if (!outcome.ok) {
        throw acp.RequestError.internalError(
          { sessionId: session.sessionId },
          `The agent could not complete this turn: ${outcome.message}`
        );
      }
      return { stopReason: outcome.stopReason };
    })
    .onNotification(acp.AGENT_METHODS.session_cancel, ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) return;
      // Recorded as well as aborted: the abort makes the run stop, and the flag is what makes the
      // turn answer `cancelled` instead of reading its own truncated stream as a normal finish.
      session.cancelled = true;
      session.abort?.abort();
    });
}
