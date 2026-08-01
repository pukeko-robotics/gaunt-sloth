import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { HumanMessage } from '@langchain/core/messages';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import type {
  AgentStreamEvent,
  GthAgentInterface,
  GthConfig,
  Message,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '@gaunt-sloth/core/core/types.js';
import type { PendingApproval, TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

/**
 * EXT-11 TUI e2e — the approval gate must be REACHABLE on the Ink TUI (event-stream) path.
 *
 * This is the coverage gap the live smoke (2026-06-23) flagged: the only prior TUI e2e seam
 * (`GTH_TUI_E2E_FIXTURE` → `createFixtureTuiAgent`) renders `<App>` WITHOUT `subscribeApproval`,
 * so 963 unit tests stayed green while a gated `run_shell_command` silently produced no prompt
 * and no execution in the real-runner path.
 *
 * Here we wire the FULL real path end to end: a real {@link GthAgentRunner} driving a fake
 * {@link GthAgentInterface} that suspends on a `humanInTheLoopMiddleware`-style interrupt, the
 * production approval bridge (`setToolApprovalCallback` ⇄ `subscribeApproval`), and the real
 * `<App>` with its approval queue + `useInput` resolution. We assert: interrupt → `ApprovalPrompt`
 * renders → approve → `streamWithEventsResume` → command output renders; reject → graceful continue
 * (no execution); allow-list auto-approve → no prompt; AI-rater escalation → verdict line in the TUI.
 *
 * On the OLD code (`processMessagesWithEvents` = bare `yield*`) these all fail: the runner never
 * detects the interrupt, so no approval is ever bridged to the App and no resume stream runs.
 */

const baseProps = {
  mode: 'code',
  readyMessage: '\nGaunt Sloth is ready.',
  exitMessage: "Type 'exit' or Ctrl+C to exit · /help for commands\n",
};

function eventStream(...events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/**
 * The production approval bridge from `tuiSessionModule.createApprovalBridge`, replicated here so
 * the test owns the exact wiring it asserts (the module-private fn is not exported). Promise-based:
 * the runner's callback awaits until the App resolves a decision.
 */
function createApprovalBridge() {
  const listeners = new Set<(record: PendingApproval) => void>();
  return {
    request: (pending: PendingToolInterrupt): Promise<ToolApprovalDecision> =>
      new Promise<ToolApprovalDecision>((resolve) => {
        let settled = false;
        const record: PendingApproval = {
          pending,
          resolve: (decision) => {
            if (settled) return;
            settled = true;
            resolve(decision);
          },
        };
        for (const l of listeners) l(record);
      }),
    subscribe: (cb: (record: PendingApproval) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * A fake {@link GthAgentInterface} that streams an initial assistant line, then suspends on one
 * pending tool call (like deepagents `humanInTheLoopMiddleware`), and on resume streams the
 * executed command's `tool_result` + the model's answer — IF the resume decision was approve.
 * A reject resume streams a brief "stopped" line and no tool_result, mirroring graceful continue.
 */
function fakeInterruptingAgent(opts: {
  command: string;
  toolResult: string;
  approvedAnswer: string;
  rejectedAnswer: string;
}): GthAgentInterface {
  let suspended = false;
  return {
    async init() {},
    async invoke() {
      return '';
    },
    async stream() {
      throw new Error('not used');
    },
    async *streamWithEvents(): AsyncGenerator<AgentStreamEvent> {
      suspended = true;
      yield { type: 'text', delta: 'Running the command…' };
      // Graph "suspends" here on the pending tool call; the generator ends cleanly.
    },
    async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
      if (!suspended) return [];
      suspended = false; // one pending call, cleared once decided + resumed
      return [{ name: 'run_shell_command', args: { command: opts.command } }];
    },
    async *streamWithEventsResume(resumeValue: unknown): AsyncGenerator<AgentStreamEvent> {
      const decisions = (resumeValue as { decisions?: ToolApprovalDecision[] })?.decisions ?? [];
      const approved = decisions[0]?.type === 'approve';
      if (approved) {
        yield { type: 'tool_result', id: 't1', content: opts.toolResult };
        yield { type: 'text', delta: opts.approvedAnswer };
      } else {
        yield { type: 'text', delta: opts.rejectedAnswer };
      }
    },
    async cleanup() {},
  };
}

/**
 * Wire a real GthAgentRunner + approval bridge into <App>, exactly like `createTuiSession` does
 * (sans the live config/agent). Returns the props the test renders with.
 */
function wireRunner(agent: GthAgentInterface, config: Partial<GthConfig>, command = 'code') {
  const bridge = createApprovalBridge();
  const runner = new GthAgentRunner(
    vi.fn(),
    undefined,
    () => agent // factory returns our fake agent
  );
  const tuiAgent: TuiAgent = {
    async *runTurn(userInput, signal) {
      yield* runner.processMessagesWithEvents([new HumanMessage(userInput) as Message], signal);
    },
    setApprovalMode(mode) {
      runner.setSessionApprovalMode(mode);
      return runner.getSessionApprovals();
    },
    getApprovals() {
      return { approvals: runner.getSessionApprovals(), allowlist: runner.getAllowlistCounts() };
    },
  };
  return { bridge, runner, tuiAgent, command, config };
}

const FULL_CONFIG = {
  streamOutput: true as const,
  llm: { _llmType: () => 'test', verbose: false } as unknown as GthConfig['llm'],
};

describe('EXT-11 TUI approval e2e (event-stream path)', () => {
  // EXT-71 — clamp the anchor the persisted grant store resolves from, through the production hook
  // (`setProjectDir`), or a gated call here reads and — on a v1 file — REWRITES the real
  // `.gsloth/.gsloth-settings/shell-allowlist.json` of whoever runs the suite. Measured, not assumed.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-approval-e2e-spec-'));
  let priorProjectDir: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
  });

  afterEach(() => {
    setProjectDir(priorProjectDir);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('interrupt → ApprovalPrompt renders → approve → streamWithEventsResume → command executes and output renders', async () => {
    const agent = fakeInterruptingAgent({
      command: 'ls -la',
      toolResult: '4 entries',
      approvedAnswer: 'The directory has 4 entries.',
      rejectedAnswer: 'Okay, I will not run it.',
    });
    // Shell gate enabled, allow-list + rater OFF → the command escalates straight to the human.
    const { runner, bridge, tuiAgent, command } = wireRunner(agent, {
      ...FULL_CONFIG,
      approvals: { mode: 'ask', allowlist: false },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as Partial<GthConfig>);
    await runner.init(command as never, { ...FULL_CONFIG } as GthConfig);
    runner.setToolApprovalCallback((pending) => bridge.request(pending));

    const { stdin, lastFrame, frames, unmount } = render(
      <App
        {...baseProps}
        agent={tuiAgent}
        subscribeApproval={bridge.subscribe}
        initialMessage="list the files"
      />
    );

    // The approval prompt must render (the bug: it never did on the TUI path).
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('ls -la'); // the pending command is shown
      expect(f.toLowerCase()).toContain('approve'); // the o/s/a/N chooser
    });

    // Approve once.
    stdin.write('o');

    // The resumed stream executes and its output renders into the transcript.
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('4 entries'); // executed command output
      expect(all).toContain('The directory has 4 entries.'); // model's answer after execution
    });

    unmount();
  });

  it('interrupt → reject → graceful continue (no execution, no tool_result)', async () => {
    const agent = fakeInterruptingAgent({
      command: 'rm -rf build',
      toolResult: 'SHOULD-NOT-APPEAR',
      approvedAnswer: 'ran it',
      rejectedAnswer: 'Understood — I did not run the command.',
    });
    const { runner, bridge, tuiAgent, command } = wireRunner(agent, {
      ...FULL_CONFIG,
      commands: { code: { builtInTools: { run_shell_command: { enabled: true, allowlist: false } } } },
    } as Partial<GthConfig>);
    await runner.init(command as never, { ...FULL_CONFIG } as GthConfig);
    runner.setToolApprovalCallback((pending) => bridge.request(pending));

    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={tuiAgent} subscribeApproval={bridge.subscribe} initialMessage="rm" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('rm -rf build'));

    // Reject (anything that is not o/s/a → reject, fail-closed). Use 'n'.
    stdin.write('n');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Understood — I did not run the command.'); // graceful continue
    });
    // The command output never appears: it was not executed.
    expect(frames.join('\n')).not.toContain('SHOULD-NOT-APPEAR');

    unmount();
  });

  /**
   * EXT-58 §7 (+ §4.4) — the message the MODEL is handed on a TUI rejection must name its moves,
   * and must carry the rater's granted alternative plus the clause saying that alternative needs no
   * approval. The on-screen "Command rejected" notice is unchanged; this asserts the other half of
   * the rejection, which no test saw before.
   */
  it('rejection hands the model its moves and the granted alternative (§7)', async () => {
    const decisions: ToolApprovalDecision[] = [];
    let suspended = false;
    const agent: GthAgentInterface = {
      async init() {},
      async invoke() {
        return '';
      },
      async stream() {
        throw new Error('not used');
      },
      async *streamWithEvents(): AsyncGenerator<AgentStreamEvent> {
        suspended = true;
        yield { type: 'text', delta: 'Rewriting the file…' };
      },
      async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
        if (!suspended) return [];
        suspended = false;
        return [{ name: 'run_shell_command', args: { command: "sed -i 's/a/b/' src/a.ts" } }];
      },
      // EXT-58 §4.4 — what the runner intersects with core's summaries table to tell the rater
      // which built-ins are already granted.
      getRegisteredToolNames: () => ['read_file', 'edit_file', 'run_shell_command'],
      async *streamWithEventsResume(resumeValue: unknown): AsyncGenerator<AgentStreamEvent> {
        decisions.push(
          ...((resumeValue as { decisions?: ToolApprovalDecision[] })?.decisions ?? [])
        );
        yield { type: 'text', delta: 'Understood.' };
      },
      async cleanup() {},
    };

    // A scripted rater that escalates and names an already-granted built-in.
    const ratedConfig = {
      ...FULL_CONFIG,
      llm: {
        withStructuredOutput: () => ({
          invoke: async () => ({
            outcome: 'destructive',
            reason: 'rewrites a file in place; edit_file does this without a shell',
            suggestedTool: 'edit_file',
          }),
        }),
      } as unknown as GthConfig['llm'],
      approvals: { mode: 'auto-safe' },
      commands: {
        code: { builtInTools: { run_shell_command: { enabled: true, allowlist: false } } },
      },
    };

    const { runner, bridge, tuiAgent, command } = wireRunner(
      agent,
      ratedConfig as Partial<GthConfig>
    );
    await runner.init(command as never, ratedConfig as unknown as GthConfig);
    runner.setToolApprovalCallback((pending) => bridge.request(pending));

    const { stdin, lastFrame, frames, unmount } = render(
      <App
        {...baseProps}
        agent={tuiAgent}
        subscribeApproval={bridge.subscribe}
        initialMessage="rewrite it"
      />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('sed'));
    stdin.write('n');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Understood.'));

    const decision = decisions[0];
    expect(decision?.type).toBe('reject');
    const message = (decision as { message?: string }).message ?? '';
    expect(message).toContain('The user rejected your call to run_shell_command.');
    expect(message).toContain('call the same command with a justification');
    expect(message).toContain('ask the user if there is no way around it');
    expect(message).toContain(
      '`edit_file` does this and is already approved at this level, so it will not interrupt the user.'
    );

    unmount();
  });

  it('allow-list auto-approve: a granted command runs again with NO prompt', async () => {
    // Persist off; pre-seed nothing — instead grant 'session' on the first command, then THE SAME
    // command auto-approves without a second prompt. We model this with TWO suspends in one turn.
    // EXT-71 §3.1: a grant is exactly the command the human saw, so the second suspend has to be
    // that command — a variant would re-prompt, and asserting it did not would assert nothing.
    let phase = 0;
    const agent: GthAgentInterface = {
      async init() {},
      async invoke() {
        return '';
      },
      async stream() {
        throw new Error('not used');
      },
      async *streamWithEvents(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'working' };
      },
      async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
        phase += 1;
        if (phase === 1) return [{ name: 'run_shell_command', args: { command: 'git status' } }];
        if (phase === 2) return [{ name: 'run_shell_command', args: { command: 'git status' } }];
        return [];
      },
      async *streamWithEventsResume(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'tool_result', id: 't', content: 'clean' };
      },
      async cleanup() {},
    };
    const { runner, bridge, tuiAgent } = wireRunner(agent, {}, 'code');
    await runner.init('code' as never, {
      ...FULL_CONFIG,
      // CFG-26 — persistAllowlist moved to `approvals`; on the retired per-tool entry it is a
      // silent no-op, which would let this test write the real allow-list file.
      approvals: { mode: 'ask', persistAllowlist: false },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as GthConfig);

    let promptCount = 0;
    bridge.subscribe(() => {
      promptCount += 1;
    });
    // Human grants session scope whenever actually prompted.
    runner.setToolApprovalCallback((pending) => bridge.request(pending));

    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={tuiAgent} subscribeApproval={bridge.subscribe} initialMessage="go" />
    );

    // First command prompts; approve at session scope so the variant is allow-listed.
    await vi.waitFor(() => expect(lastFrame()).toContain('git status'));
    stdin.write('s');

    // The second call of the granted command must auto-approve with NO prompt.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    expect(promptCount).toBe(1); // only the first command ever reached the human prompt

    unmount();
  });

  /**
   * CFG-27 — the property the CFG-26 `[y]` test really pinned was "the rater was actually CALLED,
   * not waved through". That survives the ladder; the key that triggered it does not (§6's
   * escalation menu has no rung-switching choice, so the affordance was removed). Here the
   * session starts at `auto-safe`, the rater rates everything `safe`, and the run proceeds with
   * NO human prompt at all — a check in the loop rather than none.
   */
  it('at auto-safe the rater is CALLED and a safe verdict runs the command with no prompt', async () => {
    let phase = 0;
    const agent: GthAgentInterface = {
      async init() {},
      async invoke() {
        return '';
      },
      async stream() {
        throw new Error('not used');
      },
      async *streamWithEvents(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'working' };
      },
      async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
        phase += 1;
        if (phase === 1) return [{ name: 'run_shell_command', args: { command: 'npm run build' } }];
        if (phase === 2) return [{ name: 'run_shell_command', args: { command: 'npm test' } }];
        return [];
      },
      async *streamWithEventsResume(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'tool_result', id: 't', content: 'ok' };
      },
      async cleanup() {},
    };
    // A rater that rates everything `safe`, so the behaviour is deterministic.
    const rate = vi.fn().mockResolvedValue({ outcome: 'safe', reason: 'routine dev command' });
    const raterLlm = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: rate }),
    } as unknown as GthConfig['llm'];
    const { runner, bridge, tuiAgent } = wireRunner(agent, {}, 'code');
    await runner.init('code' as never, {
      ...FULL_CONFIG,
      llm: raterLlm,
      approvals: 'auto-safe',
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as GthConfig);

    let promptCount = 0;
    bridge.subscribe(() => {
      promptCount += 1;
    });
    runner.setToolApprovalCallback((pending) => bridge.request(pending));

    const { lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={tuiAgent}
        subscribeApproval={bridge.subscribe}
        initialApprovals={runner.getSessionApprovals()}
        initialMessage="go"
      />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));

    // NEITHER command reached the human — and both were RATED rather than waved through. That
    // negative-plus-positive pair is what separates "rated" from "approved blindly".
    expect(promptCount).toBe(0);
    expect(rate).toHaveBeenCalledTimes(2);
    // §10 rule 4 — the badge carries the display spelling.
    expect(lastFrame()).toContain('approvals: Auto safe');

    unmount();
  });

  it('auto-rater escalation surfaces the verdict line in the ApprovalPrompt', async () => {
    const agent = fakeInterruptingAgent({
      command: 'cat /etc/passwd',
      toolResult: 'root:x:0:0',
      approvedAnswer: 'read it',
      rejectedAnswer: 'skipped',
    });
    // A `destructive` verdict at `auto-safe` → escalate to the human with the verdict attached.
    const invoke = vi.fn().mockResolvedValue({
      outcome: 'destructive',
      reason: 'accesses a system-wide sensitive file outside the project directory',
    });
    const raterLlm = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke }),
    } as unknown as GthConfig['llm'];
    const { runner, bridge, tuiAgent } = wireRunner(agent, {}, 'code');
    await runner.init('code' as never, {
      ...FULL_CONFIG,
      llm: raterLlm,
      approvals: 'auto-safe',
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as GthConfig);
    runner.setToolApprovalCallback((pending) => bridge.request(pending));

    const { lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={tuiAgent}
        subscribeApproval={bridge.subscribe}
        initialMessage="read passwd"
      />
    );

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('cat /etc/passwd'); // escalated command shown
      // The rater's verdict reason is surfaced in the prompt (the AI-rater line).
      expect(f).toContain('system-wide sensitive file');
      expect(f).toContain('Auto-rater (destructive)');
    });
    expect(invoke).toHaveBeenCalled(); // the rater actually ran

    unmount();
  });
});
