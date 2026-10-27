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
 * v2's agent side is a fluent app builder: `acp.agent()` returns an `AgentApp` on which
 * typed handlers are registered by ACP method name, and `connect()` serves a client — either over
 * a transport stream or, for tests, directly against a `ClientApp`. The SDK's v1 entry point offers
 * the same builder, which is why the two dialects read alike even though their handlers differ.
 *
 * ## The prompt lifecycle is the part that looks wrong until you read the spec
 *
 * This is also the sharpest difference from v1, which answers the prompt request with the stop
 * reason itself. In v2 `session/prompt` returns **as soon as the prompt is accepted** — not when the
 * turn finishes — and its only content is the `messageId` of the user message it inserted, which
 * the turn's `user_message` update carries too.
 * Progress, tool calls and the final stop reason all arrive as `session/update` notifications, and
 * the turn is over when an idle `state_update` carrying a stop reason lands. That is what makes
 * cancellation expressible at all: a cancelled turn reports `cancelled` on a `state_update`, while
 * the prompt request it belongs to was answered long before. A client that waited on the prompt
 * response for the result would hang through every tool call.
 *
 * ## Why a runner and not an agent
 *
 * Each session drives a {@link @gaunt-sloth/core!core/GthAgentRunner.GthAgentRunner | GthAgentRunner}, not a bare agent. The runner is where the
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

// The stable-feature set of the v2 draft, not `experimental/v2/unstable`: nothing this app
// advertises, handles or sends is unstable in the schema the SDK ships. Adopting a feature that is
// (session fork, system prompts, usage on the idle update, MCP over ACP, subagents) moves every
// import of `experimental/v2` under modules/acp/ — grep for it, specs included — to the unstable
// entrypoint together, because the stable parser strips unstable fields.
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { createResolvers } from '#src/resolvers.js';
import { resolveAgentFactory } from '#src/core/resolveAgentFactory.js';
import { AcpUpdateMapper } from '#src/modules/acp/acpUpdates.js';
import {
  decisionForOutcome,
  permissionRequestFor,
  rememberedAnswerNote,
} from '#src/modules/acp/acpPermissions.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';
import type { GthTerminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import {
  shouldAnnounceTermination,
  terminationNotice,
} from '@gaunt-sloth/core/core/terminationNotice.js';
import {
  outstandingWorkNotice,
  shouldAnnounceOutstandingWork,
  type GthOutstandingWork,
} from '@gaunt-sloth/core/core/outstandingWork.js';
import {
  ACP_ERROR_STOP_REASON,
  acpStopReasonFor,
  acpTerminationMeta,
} from '#src/modules/acp/acpStopReason.js';
import {
  acpAvailableCommandsV2,
  parseAcpSessionCommand,
  runAcpSessionCommand,
  type AcpCommandInvocation,
} from '#src/modules/acp/acpCommands.js';
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

/**
 * A v2 stop reason, as the idle `state_update` carries it.
 *
 * Derived from the SDK's own idle-state type rather than widened to `string`, so the build still
 * checks what this module puts on the wire. The draft names the five closed reasons, `error`, and
 * underscore-prefixed custom reasons; the SDK no longer exports a standalone alias for that union.
 */
type AcpV2StopReason = NonNullable<acp.IdleStateUpdate['stopReason']>;

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
  /**
   * Aborts the current turn; `null` between turns. Set when `session/prompt` ACCEPTS a prompt, not
   * when the turn starts a tick later, so it is also what marks the session busy.
   */
  abort: AbortController | null;
  /**
   * The current turn, from acceptance on, so `session/close` can wait for it to finish unwinding —
   * including a turn accepted but not yet started. Never rejects, so awaiting it is always safe.
   * `null` before the first prompt.
   */
  turn: Promise<void> | null;
  /**
   * Set by `session/close` before anything else, so a prompt accepted moments earlier — whose turn
   * is deferred to the next tick — is ended as cancelled rather than run against a session that is
   * going away.
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
  /**
   * Sessions whose `session/close` is still unwinding. Already gone from `sessions`, so nothing new
   * starts in them, but a prompt reaching one is told it was cancelled by the close (`-32800`) rather
   * than that the session never existed.
   */
  const closingSessions = new Set<string>();
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
   * [[EXT-142]] — tell the client which commands this session offers, so the escape hatch for a
   * saved refusal is something the editor draws rather than something the user has to know.
   *
   * **Scheduled rather than awaited**, for the reason the prompt handler gives below: the
   * `session/new` response has to reach the client before any `session/update` naming the session
   * it creates, and a `setImmediate` runs after the microtask that writes that response. Sent once
   * per session — the set is static, so there is nothing to re-send.
   *
   * A send that fails is dropped: the connection going away must not take a session creation down
   * with it, and nothing about the session depends on the client having received this.
   */
  const announceCommands = (session: AcpSession): void => {
    setImmediate(() => {
      void sendUpdate(session, {
        sessionUpdate: 'available_commands_update',
        availableCommands: acpAvailableCommandsV2(),
      } as acp.SessionUpdate).catch(() => undefined);
    });
  };

  /**
   * Runs one prompt turn to completion and reports it entirely through notifications.
   *
   * Never rejects: this is started detached from the `session/prompt` request (which has already
   * been answered), so a throw here would be an unhandled rejection rather than an error anyone
   * sees. Every exit — success, cancellation, failure — ends on an idle `state_update` with a stop
   * reason, because that notification is the ONLY thing that tells a client the turn is over.
   */
  /**
   * [[EXT-159]] — why the turn that just ended ended, or `null` when no site classified it.
   *
   * Fail-soft and read at the point of use rather than captured up front: the runner holds this
   * turn's reason until the next turn resets it, so both the stop-reason decision and the report to
   * the client see the same value, and a runner that does not implement it (a test double, an
   * embedder's own) degrades to "unclassified" instead of taking the session down.
   */
  const terminationOf = (session: AcpSession): GthTerminationReason | null => {
    try {
      return session.runner.getTerminationReason?.() ?? null;
    } catch {
      return null;
    }
  };

  /**
   * [[EXT-158]] — the checklist work this turn left outstanding, or `null`.
   *
   * Fail-soft and read at the point of use, for exactly the reasons {@link terminationOf} is.
   */
  const outstandingOf = (session: AcpSession): GthOutstandingWork | null => {
    try {
      return session.runner.getOutstandingWork?.() ?? null;
    } catch {
      return null;
    }
  };

  const runTurn = async (
    session: AcpSession,
    prompt: acp.ContentBlock[],
    userMessageId: string,
    abort: AbortController
  ): Promise<void> => {
    const mapper = new AcpUpdateMapper();

    const text = promptText(prompt);
    /** Assistant text accumulated per message id, so the replay log can carry whole messages. */
    const assistantText = new Map<string, string>();
    let stopReason: AcpV2StopReason = 'end_turn';

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

      // [[EXT-154]] — the calls answered with one of the two REMEMBERING options, waiting to hear
      // what that answer landed as. Per turn, like the callbacks either side of it, and keyed by the
      // interrupt object because that is the correlation {@link ApprovalOutcome} defines: this
      // surface can have several gated calls open at once (the runner drains a batch), so pairing an
      // outcome with "the oldest unanswered request" would confirm one command's persistence in a
      // sentence about another's.
      const rememberAsked = new Set<PendingToolInterrupt>();

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
          const reply = decisionForOutcome(response.outcome);
          // [[EXT-154]] — noted from the REPLY rather than from the option id, so the set holds
          // exactly the answers that asked the runner to store something. A cancelled request and an
          // option this build does not recognise leave as arms that carry no scope at all
          // ([[EXT-193]]) and are therefore not noted, which is the direction that cannot invent a
          // promise — the narrowing below is what makes that unexpressible rather than merely false.
          if ((reply.type === 'approve' || reply.type === 'reject') && reply.scope === 'always') {
            rememberAsked.add(pending);
          }
          return reply;
        } finally {
          // Never allowed to become the callback's result. A notification that fails — the usual
          // reason being the connection going away mid-prompt — must not turn a decision the human
          // actually made into an error the runner records as a failed gate.
          await sendState(session, { state: 'running' }).catch(() => undefined);
        }
      });

      // [[EXT-154]] — **and the answer comes back.** The runner records a remembering answer only
      // after the callback that gave it has returned, so the option labels — *Allow and remember*,
      // *Reject and remember* — are an offer that nothing had ever checked was kept. This says what
      // it was.
      //
      // It goes as an `agent_message` of its own, which is this dialect's way for the agent to put a
      // line in the conversation about the session rather than about the model's answer (the same
      // channel a failed turn reports through). NOT as `tool_call_update` content: that field is
      // REPLACED by each later update, so the tool's own output would erase the note — or the note
      // the output.
      //
      // Not awaited, because nothing about the run may wait on a notification: the runner is inside
      // its own continuation here and this callback returns `void`. A send that fails is dropped for
      // the same reason the state updates around it are — the connection going away must not turn a
      // decision a human actually made into a failed gate.
      session.runner.setApprovalOutcomeCallback((outcome) => {
        if (!rememberAsked.delete(outcome.pending)) return;
        void sendUpdate(session, {
          sessionUpdate: 'agent_message',
          messageId: randomUUID(),
          content: [
            { type: 'text', text: rememberedAnswerNote(outcome.decision, outcome.lifetime) },
          ],
        }).catch(() => undefined);
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
      else {
        // [[EXT-159]] — the turn returned, and the typed reason is what says which ending it was.
        // A truncated answer and an ordinary finish both used to arrive as `end_turn`; the map is
        // what tells them apart, and `_error` is v2's sanctioned way to say "stopped, and none of
        // the defined reasons is what happened".
        //
        // An UNCLASSIFIED ending keeps `end_turn` rather than becoming `_error`. Absence means a
        // site we missed — a fact for us, recorded in the log and the dump — and reporting our own
        // blind spot to the client as a failed turn would state something false about their run.
        const ended = terminationOf(session);
        if (ended) stopReason = acpStopReasonFor(ended) ?? ACP_ERROR_STOP_REASON;
      }
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
      // [[EXT-154]] — cleared with its partner. Both close over this turn's state, and a stale one
      // left wired would report a later turn's answer into a set that can no longer contain it.
      session.runner.setApprovalOutcomeCallback(null);
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
      // [[EXT-159]] — and the editor is told WHY, not just that it stopped.
      //
      // A stop reason alone cannot carry this: ACP's vocabulary is five words wide and a dozen
      // unrelated causes land on the same one, which is the flattening this node exists to undo. So
      // the classification goes to the client twice — as a line in the conversation, which is where
      // the person is looking, and as structured `_meta` on the state update, which is what a
      // client can act on without parsing prose. Nothing is announced for an ordinary end.
      const reason = terminationOf(session);
      if (reason && shouldAnnounceTermination(reason)) {
        const notice = terminationNotice(reason);
        await sendUpdate(session, {
          sessionUpdate: 'agent_message',
          messageId: randomUUID(),
          content: [{ type: 'text', text: [notice.title, ...notice.lines].join('\n') }],
        }).catch(() => {
          /* the connection is already gone; the idle state below is still attempted */
        });
      }
      // [[EXT-158]] — the ending ACP cannot express at all: `end_turn`, which is what an editor is
      // told both when the agent finished and when it stopped halfway through its own checklist.
      // Sent into the same `agent_message` channel as the termination notice above, and its text
      // says in words that it is the runtime speaking — this channel is where the agent talks about
      // the session, and nothing here may read as the user's own words.
      const outstanding = outstandingOf(session);
      if (outstanding && shouldAnnounceOutstandingWork(outstanding, reason)) {
        const notice = outstandingWorkNotice(outstanding);
        await sendUpdate(session, {
          sessionUpdate: 'agent_message',
          messageId: randomUUID(),
          content: [{ type: 'text', text: [notice.title, ...notice.lines].join('\n') }],
        }).catch(() => {
          /* the connection is already gone; the idle state below is still attempted */
        });
      }
      // The turn is over only once this lands, whatever happened above.
      await sendState(session, {
        state: 'idle',
        stopReason,
        ...(acpTerminationMeta(reason) ? { _meta: acpTerminationMeta(reason) } : {}),
      } as acp.StateUpdate).catch(() => {
        /* connection closed mid-turn; nothing left to report to */
      });
    }
  };

  /**
   * [[EXT-142]] — run one advertised command as a turn of its own.
   *
   * A command is not a prompt: nothing reaches the model, no tool is called, and the runner is
   * asked one question and answers it synchronously. It is still a TURN on the wire, because that
   * is the only thing v2 gives a client to hang an answer on — the user message it echoes, the
   * agent message carrying the answer, and the idle state that says the turn is over. A client that
   * never saw the idle update would leave the session looking busy forever.
   *
   * Never rejects, exactly as {@link runTurn} does not: this runs detached from a `session/prompt`
   * that has already been answered, so a throw would be an unhandled rejection rather than an error
   * anyone sees.
   */
  const runCommandTurn = async (
    session: AcpSession,
    prompt: acp.ContentBlock[],
    invocation: AcpCommandInvocation,
    userMessageId: string
  ): Promise<void> => {
    let stopReason: AcpV2StopReason = 'end_turn';
    // The session is already marked busy: `session/prompt` set `session.abort` when it accepted
    // this command, so a prompt arriving mid-command is refused exactly as it is mid-turn. Released
    // below, as `runTurn` releases it.
    try {
      const userMessage: acp.SessionUpdate = {
        sessionUpdate: 'user_message',
        messageId: userMessageId,
        content: prompt,
      };
      session.replayLog.push(userMessage);
      await sendUpdate(session, userMessage);
      await sendState(session, { state: 'running' });

      const answer: acp.SessionUpdate = {
        sessionUpdate: 'agent_message',
        messageId: randomUUID(),
        content: [{ type: 'text', text: runAcpSessionCommand(session.runner, invocation) }],
      };
      session.replayLog.push(answer);
      await sendUpdate(session, answer);
    } catch (error) {
      stopReason = '_error';
      const message = error instanceof Error ? error.message : String(error);
      displayWarning(
        `ACP session ${session.sessionId}: /${invocation.command.name} failed — ${message}`
      );
      await sendUpdate(session, {
        sessionUpdate: 'agent_message',
        messageId: randomUUID(),
        content: [
          { type: 'text', text: `The ${invocation.command.name} command failed: ${message}` },
        ],
      }).catch(() => undefined);
    } finally {
      session.abort = null;
      await sendState(session, { state: 'idle', stopReason } as acp.StateUpdate).catch(
        () => undefined
      );
    }
  };

  /**
   * Ends a turn whose prompt was accepted — its user message inserted and its `messageId` already
   * answered — but which was cancelled or closed before it started. Nothing reaches the runner.
   *
   * The draft owes the client three things here, and this sends exactly them:
   * - the user message, under the answered id: "Agents must echo the message during the live
   *   session" (`PromptResponse.messageId`), and a retained message keeps that id on replay;
   * - `running`, because the agent "MUST report `running` when foreground work starts … and `idle`
   *   when it ends" (`StateUpdate`), and an accepted prompt is foreground work;
   * - `idle` with `cancelled`: "When closing cancels active foreground work, the Agent MUST send the
   *   final updates for that work and the idle `state_update` with `stopReason: "cancelled"`
   *   before responding successfully to `session/close`" (`CloseSessionRequest`). `session/close`
   *   awaits this function through `session.turn`, which is what puts these before its response.
   *
   * Never rejects, for the reason {@link runTurn} gives.
   */
  const endUnstartedTurn = async (
    session: AcpSession,
    prompt: acp.ContentBlock[],
    userMessageId: string
  ): Promise<void> => {
    try {
      const userMessage: acp.SessionUpdate = {
        sessionUpdate: 'user_message',
        messageId: userMessageId,
        content: prompt,
      };
      session.replayLog.push(userMessage);
      await sendUpdate(session, userMessage);
      await sendState(session, { state: 'running' });
    } catch {
      /* the connection is already gone; the idle state below is still attempted */
    } finally {
      session.abort = null;
      await sendState(session, { state: 'idle', stopReason: 'cancelled' } as acp.StateUpdate).catch(
        () => undefined
      );
    }
  };

  const closeSession = async (session: AcpSession): Promise<void> => {
    session.closed = true;
    session.cancelled = true;
    session.abort?.abort();
    sessions.delete(session.sessionId);
    closingSessions.add(session.sessionId);
    try {
      await finishClose(session);
    } finally {
      closingSessions.delete(session.sessionId);
    }
  };

  const finishClose = async (session: AcpSession): Promise<void> => {
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
        //
        // **The checkpoint saver is not optional here, even though `init` accepts none.** A gated
        // tool call suspends the graph on a LangGraph interrupt, and an interrupt with nowhere to
        // checkpoint throws `MISSING_CHECKPOINTER` instead of asking the client for permission — so
        // without one every shell command in an editor session fails while the ungated built-ins
        // keep working. `MemorySaver` is the right lifetime as well as the right shape: these
        // sessions live in one process and die with it.
        //
        // **Per session, not per process.** Each session owns its runner, its workspace and the
        // graphs suspended in it, and `sessions` holds several at once; one shared saver would pool
        // every session's checkpoint threads, so a `session/close` could clear state another
        // session is still parked on.
        //
        // GS2-20 — considered for the durable saver and deliberately left in memory for now. An ACP
        // session is a conversation a user would want to resume, so this surface WILL take it; the
        // work is the ACP client's own session/load handshake rather than a swap of this argument,
        // and it is [[EXT-134]]'s, not GS2-20's.
        await runner.init(resolveAcpSessionCommand(config), config, new MemorySaver());

        const sessionId = randomUUID();
        const session: AcpSession = {
          sessionId,
          cwd,
          runner,
          client,
          abort: null,
          turn: null,
          closed: false,
          cancelled: false,
          replayLog: [],
        };
        sessions.set(sessionId, session);
        // [[EXT-142]] — after the session exists, so the update names a session the client is about
        // to be told about; see {@link announceCommands} for why it is scheduled rather than sent.
        announceCommands(session);
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
      // The other half of the `session/close` rule: "If closing prevents a prompt's user message
      // from being inserted, the Agent MUST answer that request with `-32800` (Request
      // Cancelled)." A prompt reaching a session whose close is still unwinding is exactly that.
      // Once the close has finished the session simply does not exist, which is `sessionOrThrow`'s
      // answer, as it is for any unknown id.
      if (closingSessions.has(params.sessionId)) {
        throw acp.RequestError.requestCancelled(
          { sessionId: params.sessionId },
          'This session is closing; the prompt was not added to it.'
        );
      }
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
      // [[EXT-142]] — an advertised command is recognised BEFORE the turn starts, because it is not
      // a prompt: the client rendered it from `available_commands_update` and sends it as prompt
      // text only because neither dialect has an invoke method for it. Everything else — which is
      // very nearly everything — is untouched and goes to the model.
      const invocation = parseAcpSessionCommand(params.prompt);
      // The id of the USER message this prompt inserts into the conversation. The v2 draft makes
      // it required on this response and requires the turn's `user_message` update to carry the
      // same value, in either order on the wire; a replayed copy keeps it too. So it is minted
      // here, where the response is built, and handed to whichever turn runs — a model turn and a
      // command turn alike, since both echo the prompt as a user message. Minting it inside the
      // turn would leave the response with nothing to name, because the turn starts after the
      // response is sent. It is not the id of any agent message: each message type has its own id
      // space, and those are minted where each message starts.
      const userMessageId = randomUUID();
      // **Insertion happens HERE, synchronously, and so does everything that depends on it.** This
      // response says the user message was inserted ("Response acknowledging that a user prompt
      // was inserted into the ACP conversation"), and once it is, the draft allows no error and no
      // silence: "If the message has already been inserted, the Agent MUST respond successfully
      // with its `messageId`", the message must be echoed during the live session, and a close
      // that cancels the work must send its final updates and an idle `cancelled` first. So the
      // turn is owned from this moment, not from the tick it starts on:
      // - the session is marked busy now, so a second prompt in the same tick is refused (not
      //   inserted, so an error is the draft's answer) instead of being accepted beside this one;
      // - the abort exists now, so a `session/cancel` or `session/close` landing before the turn
      //   starts aborts THIS turn rather than nothing;
      // - `session.turn` exists now, so `session/close` waits for it, and a turn aborted before it
      //   starts is ended by `endUnstartedTurn` with the echo and the idle `cancelled`.
      // Rejected: inserting the user message on the wire before answering. The draft allows either
      // order, but answering first is what the rest of this surface and its clients rely on.
      // Rejected: answering a closed-in-the-gap prompt `-32800` — it has already been answered.
      const abort = new AbortController();
      session.abort = abort;
      session.cancelled = false;
      session.turn = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        if (session.closed || abort.signal.aborted) {
          return endUnstartedTurn(session, params.prompt, userMessageId);
        }
        return invocation
          ? runCommandTurn(session, params.prompt, invocation, userMessageId)
          : runTurn(session, params.prompt, userMessageId, abort);
      });
      return { messageId: userMessageId };
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
