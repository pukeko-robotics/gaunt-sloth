import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
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

/**
 * Rendered frames as comparable text: ANSI removed and whitespace collapsed. Ink wraps a long line
 * mid-sentence AND re-opens the style run at the break, so a raw `frames.join()` does not contain
 * any phrase that happened to straddle the wrap. `strip-ansi` (already used this way by
 * `LiveTurn.spec.tsx`) covers every escape Ink can emit, not only the SGR colour runs.
 */
const plain = (frames: string[]): string => stripAnsi(frames.join('\n')).replace(/\s+/g, ' ');

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
      <ApprovalPrompt
        pending={{
          name: 'run_shell_command',
          args: { command: 'ls -la /tmp' },
          grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls -la /tmp" }',
          grantSummary: 'ls -la /tmp',
        }}
      />
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

  /**
   * [[EXT-29]] §6 — **the human rules on the argument, not on the last command.** The TUI is the
   * DEFAULT interactive surface (`shouldUseTui` is opt-out), so a §5 negotiation that reaches a
   * person reaches it here: showing only the final attempt would hide the one fact §5.6 calls the
   * most important thing on the screen — that the agent proposed the same command three times
   * unchanged, against rejections that each told it what to fix.
   *
   * Asserted on the ROUNDS, not on a heading: every command, every justification and the rater's
   * answer to each. A renderer that showed the count and the last attempt would satisfy a
   * heading-only assertion and fail this one.
   */
  it('shows every round of a §5 negotiation, not only the final attempt', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt
        pending={{
          name: 'run_shell_command',
          args: { command: 'git reset --hard origin/main' },
          safetyVerdict: { outcome: 'destructive', reason: 'discards every unpushed commit' },
          negotiationRounds: [
            {
              command: 'git reset --hard origin/main',
              outcome: 'destructive',
              reason: 'name the range, or use --soft',
            },
            {
              command: 'git reset --hard origin/main',
              justification: 'the user asked to wipe today’s commits',
              outcome: 'destructive',
              reason: 'that restates the request without narrowing it',
            },
          ],
        }}
      />
    );
    const f = plain([lastFrame() ?? '']);
    expect(f).toContain('argued with the auto-rater 2 times');
    expect(f).toContain('Round 1: git reset --hard origin/main');
    expect(f).toContain('Round 2: git reset --hard origin/main');
    expect(f).toContain('agent justified: the user asked to wipe today’s commits');
    expect(f).toContain('rater answered: destructive — name the range, or use --soft');
    expect(f).toContain(
      'rater answered: destructive — that restates the request without narrowing it'
    );
    unmount();
  });

  /**
   * The counterpart, and what keeps the block off every ordinary prompt: an escalation with no
   * negotiation behind it (`catastrophic`, a declared escalate entry, an unrated rung) draws no
   * heading over an argument that never happened.
   */
  it('renders no negotiation block when there was no negotiation', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt
        pending={{
          name: 'run_shell_command',
          args: { command: 'terraform destroy' },
          safetyVerdict: { outcome: 'catastrophic', reason: 'destroys the environment' },
        }}
      />
    );
    const f = plain([lastFrame() ?? '']);
    expect(f).not.toContain('argued with the auto-rater');
    expect(f).not.toContain('Round 1');
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

  /**
   * EXT-71 §3.2 — an escalate match asks the human whatever the rung would have done, so the prompt
   * MUST show the entry that fired. Without it the user is asked about a command their rung would
   * have approved with nothing tying the question to the line they wrote.
   */
  it('shows the approvals.escalate entry that brought the call here', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt
        pending={{
          name: 'run_shell_command',
          args: { command: 'terraform apply' },
          escalatedBy: 'terraform apply',
        }}
      />
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('approvals.escalate');
    expect(f).toContain('terraform apply');
    unmount();
  });

  it('says nothing about approvals.escalate when no such entry fired', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt pending={{ name: 'run_shell_command', args: { command: 'ls -la' } }} />
    );
    expect(lastFrame() ?? '').not.toContain('approvals.escalate');
    unmount();
  });

  /**
   * EXT-71 §6 — **the menu must display what it is about to store**, at the moment of the choice,
   * on every surface. Under §3.1 that is the command itself as a fully-explicit exact entry, so
   * what the user is shown is the thing they are agreeing to rather than a generalization of it.
   */
  it('shows what a sticky choice will store', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt
        pending={{
          name: 'run_shell_command',
          args: { command: 'npm test' },
          grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "npm test" }',
          grantSummary: 'npm test',
        }}
      />
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('will remember npm test');
    expect(f).toContain('"matcher": "exact"');
    unmount();
  });

  it('shows no such line when no sticky grant is on offer', () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt pending={{ name: 'run_shell_command', args: { command: 'ls -la' } }} />
    );
    const f = lastFrame() ?? '';
    expect(f).not.toContain('will remember');
    // Control: the prompt still renders, so the assertion above is about the grant row and not
    // about the component having failed to draw anything.
    expect(f).toContain('[o]nce');
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
      // EXT-70 §6 — the runner sends a preview whenever a sticky grant is on offer, which for a
      // resolvable command at a gated rung is always. Without it this fixture describes a call
      // nothing would remember, and the scope the notice names would be `once` whatever was pressed.
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "echo hi" }',
      grantSummary: 'echo hi',
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

  /**
   * CFG-28 (§4.2, §6) — a `catastrophic` approval is NEVER sticky: `GthAgentRunner` clamps the
   * allow-list write, so `[s]`/`[a]` here grant exactly this one invocation. The notice used to
   * name the pressed scope and promise the persistence anyway, which §6 calls the wrong failure
   * mode — *"a control that is offered and then refused reads as a bug rather than as a policy"* —
   * and this is its louder half: not merely offering the key, but confirming an outcome that did
   * not happen. The keypress still SENDS its scope (core owns the clamp); only the notice changes.
   */
  it.each([
    ['s', 'session'],
    ['a', 'always'],
  ] as const)(
    'a catastrophic verdict: pressing %s confirms one invocation, never a persistence',
    async (keyChar, scope) => {
      const harness = makeApprovalHarness();
      const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
      const { stdin, lastFrame, frames, unmount } = render(
        <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
      );

      await vi.waitFor(() => expect(lastFrame()).toContain('>'));
      const decisionP = harness.request({
        name: 'run_shell_command',
        args: { command: 'terraform destroy -auto-approve' },
        safetyVerdict: {
          outcome: 'catastrophic',
          reason: 'destroys every managed resource; cannot be undone from inside the session',
        },
      });
      await vi.waitFor(() => expect(lastFrame()).toContain('terraform destroy'));

      stdin.write(keyChar);
      expect(await decisionP).toEqual({ type: 'approve', scope });

      // Frames wrap mid-sentence and re-open the style run at the break, so compare on text with
      // ANSI stripped and whitespace collapsed.
      const flat = () => plain(frames);
      await vi.waitFor(() => expect(flat()).toContain('Command approved (once)'));
      expect(flat()).toContain('never remembered');
      expect(flat()).toContain('will ask again');
      expect(flat()).not.toContain(`Command approved (${scope})`);
      expect(flat()).not.toContain('will not ask again this session');
      expect(flat()).not.toContain('saved to the project allow-list');
      unmount();
    }
  );

  /**
   * The control. The clamp is scoped to `catastrophic` ALONE — `destructive` grants are still
   * sticky — so the same keypress must still say so. Without this, a "fix" that deleted the
   * stickiness promise outright would pass the test above.
   */
  it('the control: a destructive verdict still confirms the session grant sticks', async () => {
    const harness = makeApprovalHarness();
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={agent} subscribeApproval={harness.subscribeApproval} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    const decisionP = harness.request({
      name: 'run_shell_command',
      args: { command: 'rm -rf build' },
      safetyVerdict: { outcome: 'destructive', reason: 'deletes the build output' },
      // A `destructive` verdict does NOT withdraw the grant, so the runner still sends a preview —
      // which is exactly what tells this control apart from the catastrophic case above, where the
      // runner discards it.
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "rm -rf build" }',
      grantSummary: 'rm -rf build',
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('rm -rf build'));

    stdin.write('s');
    expect(await decisionP).toEqual({ type: 'approve', scope: 'session' });

    const flat = () => plain(frames);
    await vi.waitFor(() => expect(flat()).toContain('Command approved (session)'));
    expect(flat()).toContain('will not ask again this session');
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

/**
 * EXT-70 §6 / §4.7.1 — the menu names what a sticky choice will store, offers the sticky controls
 * only where one is on offer, and the TUI's own trust affordance.
 */
describe('tui <ApprovalPrompt> — §6 names the grant, and offers it only when there is one', () => {
  const toolGrant = {
    name: 'gth_web_fetch',
    args: { input: 'https://docs.internal.example/guide' },
    grantPreview:
      '{ "type": "tool", "matcher": "exact", "pattern": "gth_web_fetch", "host": "docs.internal.example" }',
    grantSummary: 'tool gth_web_fetch (host docs.internal.example)',
  };

  /**
   * §6: *always approve `gth_web_fetch` for `docs.internal`*. What the control names is the tool and
   * its host bound — never the arguments, which is the whole of what makes a tool grant broader
   * than a shell one and therefore the display that carries most weight.
   */
  it('names the tool and its host, and not the arguments', () => {
    const { lastFrame, unmount } = render(<ApprovalPrompt pending={toolGrant} />);
    const f = plain([lastFrame() ?? '']);
    expect(f).toContain('will remember tool gth_web_fetch (host docs.internal.example)');
    expect(f).toContain('stored as');
    unmount();
  });

  /**
   * The pair §2(a) turns on. A menu that never rendered the sticky controls at all would pass the
   * absence assertion alone, so the same prompt WITH a grant is asserted in the same test.
   */
  it('offers [s]/[a] with a grant and NOT WITHOUT one — the control is absent, never disabled', () => {
    const withGrant = render(<ApprovalPrompt pending={toolGrant} />);
    const wf = plain([withGrant.lastFrame() ?? '']);
    expect(wf).toContain('[s]ession');
    expect(wf).toContain('[a]lways');
    withGrant.unmount();

    const without = render(
      <ApprovalPrompt pending={{ name: 'gth_web_fetch', args: { input: 'x' } }} />
    );
    const nf = plain([without.lastFrame() ?? '']);
    expect(nf).not.toContain('[s]ession');
    expect(nf).not.toContain('[a]lways');
    // Still a prompt: the one-shot choices remain, so the absence above is about the sticky pair.
    expect(nf).toContain('[o]nce');
    expect(nf).toContain('[N]o');
    without.unmount();
  });
});

describe('tui approvals — the confirmation names what was actually stored (§6)', () => {
  const baseAgent = () => scriptedAgent([{ type: 'text', delta: 'hi' }]);

  /**
   * The general form of the CFG-28 clamp. `grantPreview` is absent exactly where the runner stores
   * nothing, and `catastrophic` is one of its cases — so a call that simply cannot be remembered
   * (a compound command, an unattributable tool call) must not be confirmed as remembered either.
   */
  it('a call with no grant on offer confirms one invocation, whatever key was pressed', async () => {
    const harness = makeApprovalHarness();
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={baseAgent()} subscribeApproval={harness.subscribeApproval} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    const decisionP = harness.request({
      name: 'run_shell_command',
      args: { command: 'ls && rm -rf build' },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('rm -rf build'));

    stdin.write('s');
    expect(await decisionP).toEqual({ type: 'approve', scope: 'session' });
    const flat = () => plain(frames);
    await vi.waitFor(() => expect(flat()).toContain('Command approved (once)'));
    expect(flat()).toContain('nothing about this call that can be remembered');
    expect(flat()).not.toContain('will not ask again this session');
    unmount();
  });

  it('CONTROL: the same key on a call that DOES carry a grant confirms the session grant', async () => {
    const harness = makeApprovalHarness();
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={baseAgent()} subscribeApproval={harness.subscribeApproval} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    const decisionP = harness.request({
      name: 'run_shell_command',
      args: { command: 'ls -la' },
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "ls -la" }',
      grantSummary: 'ls -la',
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('ls -la'));

    stdin.write('s');
    expect(await decisionP).toEqual({ type: 'approve', scope: 'session' });
    const flat = () => plain(frames);
    await vi.waitFor(() => expect(flat()).toContain('Command approved (session)'));
    expect(flat()).toContain('will not ask again this session');
    unmount();
  });
});

/**
 * EXT-70 §4.7.1 — `/approvals trust|untrust` through the real `<App>` dispatch: the request the
 * command produced reaches the agent unchanged, and the notice the surface commits is built from
 * what the agent RETURNED.
 */
describe('tui /approvals trust (EXT-70 §4.7.1)', () => {
  const trustingAgent = (change: Record<string, unknown>) => {
    const calls: unknown[][] = [];
    const agent: TuiAgent = {
      ...scriptedAgent([{ type: 'text', delta: 'hi' }]),
      setMcpAnnotationTrust(server, hints, believe) {
        calls.push([server, hints, believe]);
        return {
          server,
          configured: true,
          trusted: [],
          added: [],
          removed: [],
          weakening: [],
          invalidates: [],
          ...change,
        } as never;
      },
    };
    return { agent, calls };
  };

  const submit = async (
    agent: TuiAgent,
    line: string
  ): Promise<{ frames: string[]; unmount: () => void }> => {
    const { stdin, lastFrame, frames, unmount } = render(<App {...baseProps} agent={agent} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write(line);
    await vi.waitFor(() => expect(lastFrame()).toContain(line));
    stdin.write('\r');
    return { frames, unmount };
  };

  it('hands the server and hints to the agent exactly as typed, and reports what landed', async () => {
    const { agent, calls } = trustingAgent({ trusted: ['readOnlyHint'], added: ['readOnlyHint'] });
    const { frames, unmount } = await submit(agent, '/approvals trust jira readOnlyHint');
    await vi.waitFor(() =>
      expect(plain(frames)).toContain('Now believing from jira: readOnlyHint')
    );
    expect(calls).toEqual([['jira', ['readOnlyHint'], true]]);
    unmount();
  });

  /**
   * §2(c) — the user withdrawing trust is told, THERE, that their saved approvals for that server
   * go with it. Its control is the test above, where no such line appears on a grant of trust.
   */
  it('a withdrawal states that the saved approvals for that server will go', async () => {
    const { agent } = trustingAgent({
      removed: ['readOnlyHint'],
      weakening: ['readOnlyHint'],
      invalidates: ['mcpTool jira/search'],
    });
    const { frames, unmount } = await submit(agent, '/approvals untrust jira readOnlyHint');
    await vi.waitFor(() =>
      expect(plain(frames)).toContain('withdrawn the next time that tool is called')
    );
    expect(plain(frames)).toContain('mcpTool jira/search');
    unmount();
  });

  it('CONTROL: granting trust says nothing about approvals being withdrawn', async () => {
    const { agent } = trustingAgent({ trusted: ['readOnlyHint'], added: ['readOnlyHint'] });
    const { frames, unmount } = await submit(agent, '/approvals trust jira readOnlyHint');
    await vi.waitFor(() => expect(plain(frames)).toContain('Now believing from jira'));
    expect(plain(frames)).not.toContain('withdrawn the next time');
    unmount();
  });

  it('a surface with no runner says so instead of pretending to move trust', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { frames, unmount } = await submit(agent, '/approvals trust jira readOnlyHint');
    await vi.waitFor(() =>
      expect(plain(frames)).toContain('Approvals are unavailable in this session.')
    );
    unmount();
  });
});
