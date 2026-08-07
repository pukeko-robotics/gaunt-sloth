import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { FALLBACK_TERMINAL_ROWS } from '#src/tui/useTerminalSize.js';

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

const ESC = String.fromCharCode(27); // Escape key byte
const TAB = '\t'; // Tab key (char 9)
const PAGE_DOWN = '\x1b[6~'; // PageDown CSI sequence
const PAGE_UP = '\x1b[5~'; // PageUp CSI sequence
const ARROW_DOWN = '\x1b[B'; // Down-arrow CSI sequence
const ARROW_UP = '\x1b[A'; // Up-arrow CSI sequence
const SHIFT_TAB = '\x1b[Z'; // Shift+Tab (back-tab) CSI sequence

describe('tui <App>', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the user message, a tool-call line, and streamed assistant text', async () => {
    const agent = scriptedAgent([
      { type: 'tool_start', id: 't1', name: 'read_file' },
      { type: 'tool_args', id: 't1', delta: '{"path":"a.ts"}' },
      { type: 'tool_end', id: 't1' },
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'there' },
    ]);
    const { frames, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="Hi sloth" />
    );

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Hi sloth'); // user line
      expect(all).toContain('read_file'); // tool call
      expect(all).toContain('Hello there'); // streamed assistant text
    });

    unmount();
  });

  it('returns to the ready prompt after a turn completes', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      // Once idle the status bar shows the ready line and the prompt is back.
      expect(lastFrame()).toContain('ready');
      expect(lastFrame()).toContain('>');
    });

    unmount();
  });

  it('renders the launch banner above the untouched ready message (TUI-C33)', async () => {
    const agent = scriptedAgent([]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} showLaunchBanner />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('┗┛┗┻┗┻┛┗┗'); // the GAUNT SLOTH wordmark
      expect(frame).toContain('Gaunt Sloth is ready to chat'); // the ready line, unchanged
      // The banner is a greeting, so it sits ABOVE the ready message, not below it.
      expect(frame.indexOf('┗┛┗┻┗┻┛┗┗')).toBeLessThan(frame.indexOf('ready to chat'));
    });

    unmount();
  });

  it('omits the launch banner when stdout is not a TTY (no showLaunchBanner)', async () => {
    // The session module carries the stdout.isTTY gate; without it the frame stays banner-free so
    // piped/redirected runs are untouched.
    const agent = scriptedAgent([]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('ready to chat');
      expect(frame).not.toContain('┗┛┗┻┗┻┛┗┗');
    });

    unmount();
  });

  it('drops the launch banner once the first exchange is underway (TUI-C33)', async () => {
    // Same intro lifecycle as the ready message: an initialMessage starts a turn immediately, so
    // neither greeting should be padding the dock.
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} showLaunchBanner initialMessage="go" />
    );

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('turns: 1');
      expect(frame).not.toContain('┗┛┗┻┗┻┛┗┗');
      expect(frame).not.toContain('ready to chat');
    });

    unmount();
  });

  it('surfaces /help in the idle exit hint (TUI-C12)', async () => {
    // The idle hint is the exitMessage; it now also points at /help for command discovery.
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('exit'); // keeps the exit affordance
      expect(frame).toContain('/help for commands'); // new command-discovery hint
    });

    unmount();
  });

  // TUI-C63 — the full-screen surface took away the terminal's scrollback and replaced it with
  // bindings nothing on screen mentioned. The hint row is where the replacement is advertised, and
  // it is composed HERE (not in the shared exitMessage) so the readline session, which still has
  // the terminal's own scrollback, never inherits the claim.
  it('appends the scroll fragment to the hint row, without touching the shared exitMessage', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      // The whole row, as one sentence: the command's own half plus this surface's fragment.
      expect(frame).toContain(
        "Type 'exit' or Ctrl+C to exit chat · /help for commands · PgUp/PgDn to scroll history"
      );
    });
    // That the shared literal itself is untouched is asserted where it is declared — chatCommand
    // and codeCommand's specs pin their exitMessage exactly — not here, where the only string in
    // reach is this file's own fixture.
    // The row stays a nudge: the keyboard-honest Fn note belongs in /help, which has room for it
    // (naming a key a Mac laptop does not have is the TUI-C11 defect this must not repeat).
    expect(lastFrame() ?? '').not.toContain('Fn+');

    unmount();
  });

  it('shows mode, model name and a turn counter in the idle status bar', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} modelDisplayName="claude-opus-4" initialMessage="go" />
    );

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('chat'); // mode
      expect(frame).toContain('claude-opus-4'); // model display name
      expect(frame).toContain('turns: 1'); // counter after one completed turn
      expect(frame).toContain('ready');
    });

    unmount();
  });

  it('suppresses INFO/DEBUG status lines in the TUI but keeps WARNING/ERROR', async () => {
    // The agent routes per-turn chatter (Requested tools, Loaded tools, Thinking…) through
    // statusUpdate at INFO level; that duplicates the TUI's own live rendering and must not reach
    // the transcript. WARNING/ERROR still surface (e.g. the experimental deep-backend warning).
    let emit: ((level: string, message: string) => void) | undefined;
    const subscribeStatus = (cb: (level: string, message: string) => void) => {
      emit = cb;
      return () => {};
    };
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeStatus={subscribeStatus} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    emit?.('INFO', 'Requested tools: read_file');
    emit?.('DEBUG', 'internal state dump');
    emit?.('WARNING', 'experimental deepagents backend');

    await vi.waitFor(() => expect(frames.join('\n')).toContain('experimental deepagents backend'));
    const all = frames.join('\n');
    expect(all).not.toContain('Requested tools: read_file');
    expect(all).not.toContain('internal state dump');

    unmount();
  });

  it('dispatches /help as a system line instead of running a turn', async () => {
    let turnsRun = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        turnsRun += 1;
        yield { type: 'text', delta: 'should not run' };
      },
    };
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/help');
    await vi.waitFor(() => expect(lastFrame()).toContain('/help'));
    stdin.write('\r');

    // TUI-C63 — the notice now carries this surface's key bindings after the command list, so on a
    // short terminal its tail is what the region shows. Assert the tail here, then scroll to the
    // top for the command list: the commands are still there, and reaching them is exactly the
    // gesture the hint row and the bindings section now advertise.
    await vi.waitFor(() => {
      // The last group, so it survives the clip on a short terminal — and a line that exists only
      // in the bindings data, so this fails if <App> stops supplying them.
      expect(frames.join('\n')).toContain('Ctrl+C — exit');
    });
    stdin.write('\x1b[1;5H'); // Ctrl+Home
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Slash commands and keys');
      expect(frames.join('\n')).toContain('/clear');
      expect(frames.join('\n')).toContain('/exit');
    });
    expect(turnsRun).toBe(0);

    unmount();
  });

  it('shows a friendly hint for an unknown slash command and does not call the agent', async () => {
    let turnsRun = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        turnsRun += 1;
        yield { type: 'text', delta: 'nope' };
      },
    };
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/bogus');
    await vi.waitFor(() => expect(lastFrame()).toContain('/bogus'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Unknown command: /bogus'); // warn-tone notice title
      expect(all).toContain('Run /help to see everything available.'); // explanatory body
    });
    expect(turnsRun).toBe(0);

    unmount();
  });

  // CFG-27 — a posture stub standing in for the runner: it lands the requested rung, exactly as
  // GthAgentRunner.setSessionApprovalRung does.
  const approvalsAgent = (
    initial = 'assisted',
    extra?: Partial<TuiAgent>
  ): { agent: TuiAgent; rung: () => string } => {
    let rung = initial;
    const posture = () => ({ rung, rater: undefined, allow: [], deny: [], escalate: [] }) as any;
    return {
      rung: () => rung,
      agent: {
        async *runTurn() {
          yield { type: 'text', delta: 'should not run' };
        },
        setApprovalRung(next: string) {
          rung = next;
          return posture();
        },
        getApprovals() {
          return {
            approvals: posture(),
            allowlist: { session: 2, always: undefined },
            deny: ['npm publish'],
          };
        },
        ...extra,
      } as TuiAgent,
    };
  };

  it('/approvals <rung> switches the session rung and the badge names it in display spelling', async () => {
    const { agent, rung } = approvalsAgent('write');
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/approvals assisted');
    await vi.waitFor(() => expect(lastFrame()).toContain('/approvals assisted'));
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Approvals: Assisted');
      // §10 rule 4: the badge uses the DISPLAY spelling, never the kebab-case identifier.
      expect(lastFrame()).toContain('approvals: Assisted');
    });
    expect(rung()).toBe('assisted');
    expect(lastFrame()).not.toContain('Bypass');

    stdin.write('/approvals manual');
    await vi.waitFor(() => expect(lastFrame()).toContain('/approvals manual'));
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Approvals: Manual');
      expect(lastFrame()).toContain('approvals: Manual');
    });
    expect(rung()).toBe('manual');

    unmount();
  });

  /**
   * CFG-39 — **the picker's wiring, end to end inside the App**: `/approvals` with no argument
   * opens the four-posture picker, and choosing a row actually moves the session mode through the
   * runner. The component spec proves the picker reports the right mode; this proves the App does
   * something with it. Without this cell a regression that passed the wrong mode — or never called
   * the setter at all — is green everywhere.
   */
  it('/approvals with no arg opens the picker, and choosing a row lands that mode', async () => {
    const { agent, rung } = approvalsAgent('write');
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/approvals');
    await vi.waitFor(() => expect(lastFrame()).toContain('/approvals'));
    stdin.write('\r');

    // The status answer is still committed, AND the picker is offered.
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Approvals: Write');
      expect(lastFrame()).toContain('Choose an approvals mode:');
    });
    // Four postures, and no Write row — it is a modifier, reachable via `/approvals write`.
    for (const label of ['Manual', 'Assisted', 'Auto', 'Bypass']) {
      expect(lastFrame()).toContain(label);
    }
    expect(rung()).toBe('write');

    // On `write` no row is current, so the cursor rests on Manual; one step down is Assisted.
    stdin.write('\x1b[B');
    await vi.waitFor(() => expect(lastFrame()).toContain('❯'));
    stdin.write('\r');

    await vi.waitFor(() => {
      // The mode really moved, through the runner…
      expect(rung()).toBe('assisted');
      // …the landed notice was committed, and the badge follows.
      expect(frames.join('\n')).toContain('Approvals: Assisted');
      expect(lastFrame()).toContain('approvals: Assisted');
      // The picker is transient: it closes on selection and the prompt comes back.
      expect(lastFrame()).not.toContain('Choose an approvals mode:');
    });

    unmount();
  });

  it('CFG-39: Esc dismisses the picker and leaves the mode exactly as it was', async () => {
    const { agent, rung } = approvalsAgent('write');
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/approvals');
    await vi.waitFor(() => expect(lastFrame()).toContain('/approvals'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Choose an approvals mode:'));

    stdin.write('\x1b');
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Choose an approvals mode:'));
    expect(rung()).toBe('write');
    expect(lastFrame()).toContain('approvals: Write');

    unmount();
  });

  it('/approvals bypass shows the warn-styled ⚡ Bypass badge and cites the deny list, not the floor', async () => {
    const { agent, rung } = approvalsAgent('write');
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/approvals bypass');
    await vi.waitFor(() => expect(lastFrame()).toContain('/approvals bypass'));
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('nothing is rated and nothing is asked');
      expect(lastFrame()).toContain('⚡ Bypass');
    });
    // §8.1 — the copy names only a protection the user can inspect and extend.
    expect(frames.join('\n')).toContain('deny list');
    expect(frames.join('\n')).not.toMatch(/hardline|safety floor/i);
    expect(rung()).toBe('bypass');
    unmount();
  });

  it('/approvals with no arg SHOWS the posture (counts included) without changing it', async () => {
    const { agent, rung } = approvalsAgent('write');
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    stdin.write('/approvals');
    await vi.waitFor(() => expect(lastFrame()).toContain('/approvals'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const out = frames.join('\n');
      expect(out).toContain('Approvals: Write');
      expect(out).toContain('2 this session');
      expect(out).toContain('Denied: 1');
    });
    expect(rung()).toBe('write'); // display only — nothing switched
    unmount();
  });

  /**
   * CFG-26 acceptance #5, rescaled — the test that would have caught the original bug. The badge
   * was once seeded from a session BYPASS flag, so it read "off" while the rater was approving
   * safe commands with no prompt. It asserts the rendered RUNG, not the absence of a word, so a
   * future boolean-shaped regression cannot slip past it.
   */
  it('seeds the badge from the RESOLVED posture: the assisted default is visible from frame 1', async () => {
    const agent = scriptedAgent([]);
    const { lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        initialApprovals={{ rung: 'assisted', allow: [], deny: [] }}
      />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('approvals: Assisted'));
    // ...and it says WHO is rating, so the rung is never an unexplained word.
    expect(lastFrame()).toContain('auto-rater');
    unmount();
  });

  it('names the configured rater profile in the badge at a RATED rung', async () => {
    const agent = scriptedAgent([]);
    const { lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        initialApprovals={{ rung: 'auto', rater: 'safety-rater', allow: [], deny: [] }}
      />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('approvals: Auto (safety-rater)'));
    unmount();
  });

  it('does NOT name a rater at an unrated rung — no call happens there', async () => {
    const agent = scriptedAgent([]);
    const { lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={agent}
        initialApprovals={{ rung: 'write', rater: 'safety-rater', allow: [], deny: [] }}
      />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('approvals: Write'));
    expect(lastFrame()).not.toContain('safety-rater');
    unmount();
  });

  it('/approvals is dispatchable mid-turn; a plain message mid-turn is refused (EXT-12)', async () => {
    let rung = 'write';
    // A turn that streams then blocks until aborted, so the prompt stays mounted (running) while
    // we exercise mid-turn input.
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve());
        });
      },
      setApprovalRung(next: string) {
        rung = next;
        return { rung: next, rater: undefined, allow: [], deny: [] } as any;
      },
    } as TuiAgent;
    const { stdin, frames, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // While running, a plain message is refused with a hint.
    await vi.waitFor(() => expect(lastFrame()).toContain('Thinking'));
    stdin.write('hello there');
    await vi.waitFor(() => expect(lastFrame()).toContain('> hello there'));
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('only slash commands'));

    // While running, /approvals IS honoured (the rung switches, the badge appears by the spinner).
    stdin.write('/approvals assisted');
    await vi.waitFor(() => expect(lastFrame()).toContain('> /approvals assisted'));
    stdin.write('\r');
    await vi.waitFor(() => expect(rung).toBe('assisted'));
    await vi.waitFor(() => expect(lastFrame()).toContain('approvals: Assisted'));

    stdin.write(String.fromCharCode(27)); // Esc to end the run cleanly
    unmount();
  });

  it('toggles the docked debug panel on /debug (shows then hides the section tabs)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // Panel hidden initially.
    expect(lastFrame()).not.toContain('Subagents');

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Subagents');
      expect(f).toContain('Raw response');
    });

    // Toggle off.
    stdin.write('/debug');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/debug/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Subagents'));

    unmount();
  });

  it('advertises Tab in the status bar while the debug panel is open but unfocused', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // No panel, no hint.
    expect(lastFrame()).not.toContain('Tab: focus debug panel');

    // Open the panel: status bar now tells the user how to step into it.
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: focus debug panel'));

    // Focusing the panel replaces the status-bar hint with the panel's own focused hint.
    stdin.write(TAB);
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Tab: section');
      expect(f).not.toContain('Tab: focus debug panel');
      // TUI-C63 — the search keys are named with Enter among them. Typing the query puts the pane in
      // an input mode that every printable character extends, so a legend that jumps from `/` to
      // `n`/`N` prints a sequence that types into the query instead of stepping matches.
      expect(f).toContain('/, Enter: search');
    });

    unmount();
  });

  it('renders the subagent tree in the panel from `task` tool-call events', async () => {
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"researcher","description":"dig"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: 'done digging' },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // Wait for the turn to complete (the tool-call line is committed), then open the panel.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Subagents');
      expect(f).toContain('researcher'); // subagent type
      expect(f).toContain('dig'); // description
    });

    unmount();
  });

  it('scrolls the panel viewport with Tab-to-focus then PageDown/PageUp', async () => {
    // A subagent whose multi-line result overflows the 8-row viewport, so scrolling moves it.
    const longResult = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    // TUI-C30: the transcript's tool panel now previews the first result lines too, so scope
    // the scroll assertions to the debug-panel region of the frame (below its banner) — the
    // transcript preview above must not satisfy or break them.
    const panelOf = (frame: string | undefined): string => {
      const f = frame ?? '';
      const at = f.indexOf('Debug panel: shown');
      return at === -1 ? f : f.slice(at);
    };

    // Early lines visible, later lines clipped by the bounded viewport.
    expect(panelOf(lastFrame())).toContain('line-0');
    expect(panelOf(lastFrame())).not.toContain('line-30');

    // Focus the panel (Tab), then scroll down two pages (viewport=8, step=7 → offset 14).
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section')); // focused hint
    stdin.write(PAGE_DOWN);
    stdin.write(PAGE_DOWN);

    await vi.waitFor(() => {
      const f = panelOf(lastFrame());
      expect(f).toContain('line-12'); // a later line is now in view
      expect(f).not.toContain('line-0'); // the top scrolled out (offset moved past it)
    });

    // Scroll back up to the top.
    for (let i = 0; i < 5; i++) stdin.write(PAGE_UP);
    await vi.waitFor(() => expect(panelOf(lastFrame())).toContain('line-0'));

    unmount();
  });

  it('scrolls one line at a time with the ↑/↓ arrow keys while focused (TUI-C11)', async () => {
    // Arrows give fine control (one line) on top of PgUp/PgDn's coarse page-step — and exist on
    // every keyboard, unlike dedicated PgUp/PgDn on Mac/compact keyboards.
    const longResult = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    // TUI-C30: scope assertions to the debug-panel region — the transcript's tool panel now
    // previews the same leading result lines, which must not satisfy or break them.
    const panelOf = (frame: string | undefined): string => {
      const f = frame ?? '';
      const at = f.indexOf('Debug panel: shown');
      return at === -1 ? f : f.slice(at);
    };

    // The hint advertises the arrows as the scroll keys.
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('↑/↓: scroll'));

    // Top of the list visible. Arrow-down a few lines: the top line scrolls out one at a time.
    expect(panelOf(lastFrame())).toContain('line-0');
    for (let i = 0; i < 3; i++) stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      const f = panelOf(lastFrame());
      expect(f).not.toContain('line-0'); // top scrolled out by three single-line steps
      expect(f).toContain('line-3'); // new top line
    });

    // Arrow-up returns toward the top one line at a time.
    for (let i = 0; i < 3; i++) stdin.write(ARROW_UP);
    await vi.waitFor(() => expect(panelOf(lastFrame())).toContain('line-0'));

    unmount();
  });

  it('clamps down-scroll to the end so PgUp/↑ recover immediately (no phantom offset) (TUI-C11)', async () => {
    // Bug: PageDown had no upper clamp, so paging past the end inflated the offset; afterwards
    // PgUp/↑ had to burn through that phantom offset before anything moved. The clamp pins the
    // offset to its real max, so a single PgUp/↑ visibly scrolls back from the end.
    const longResult = Array.from({ length: 40 }, (_, i) => `row-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('↑/↓: scroll'));

    // Over-page well past the end. With the clamp the offset pins to its real maximum, so the
    // footer reads "— end —" (last line in view) and never a phantom range beyond the content.
    for (let i = 0; i < 20; i++) stdin.write(PAGE_DOWN);
    const lastLine = `row-${40 - 1}`;
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain(lastLine); // the genuine last line is in view
      expect(f).toContain('— end —'); // footer marks the real end (no over-scroll)
    });

    // A single PgUp moves immediately (no phantom offset to burn through): the last line leaves
    // view and the "more below" marker returns.
    stdin.write(PAGE_UP);
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).not.toContain(lastLine);
      expect(f).toContain('more below');
    });

    unmount();
  });

  it('cycles debug sections backward with Shift+Tab (TUI-C11)', async () => {
    // Plain Tab steps forward (subagents → history → request → response); Shift+Tab steps back.
    // From the first section, one Shift+Tab wraps to the last (response).
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    let emit: ((c: import('#src/tui/types.js').TuiDebugCapture) => void) | undefined;
    const subscribeDebug = (cb: (c: import('#src/tui/types.js').TuiDebugCapture) => void) => {
      emit = cb;
      return () => {};
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeDebug={subscribeDebug} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // Distinct content per section so we can tell which tab's body is shown (TUI-C16: system and
    // tools are now separate tabs).
    emit?.({
      kind: 'request',
      text: 'HISTORY_BODY',
      system: 'SYSTEM_BODY',
      tools: 'TOOLS_BODY',
      mcp: 'MCP_BODY',
    });
    emit?.({ kind: 'response', text: 'RESPONSE_BODY' });

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Subagents'));

    stdin.write(TAB); // focus (starts on the subagents section)
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));
    await vi.waitFor(() => expect(lastFrame()).toContain('(no subagents spawned yet)'));

    // Shift+Tab from the first section (subagents) wraps backward to the last (response).
    stdin.write(SHIFT_TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('RESPONSE_BODY'));

    // Order is subagents · system · tools · mcp · history · response (TUI-C20 inserts mcp after
    // tools), so stepping back visits each of the six sections in turn.
    stdin.write(SHIFT_TAB); // -> history
    await vi.waitFor(() => expect(lastFrame()).toContain('HISTORY_BODY'));
    stdin.write(SHIFT_TAB); // -> mcp
    await vi.waitFor(() => expect(lastFrame()).toContain('MCP_BODY'));
    stdin.write(SHIFT_TAB); // -> tools
    await vi.waitFor(() => expect(lastFrame()).toContain('TOOLS_BODY'));
    stdin.write(SHIFT_TAB); // -> system
    await vi.waitFor(() => expect(lastFrame()).toContain('SYSTEM_BODY'));

    // Plain Tab still goes forward — back to the tools section.
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('TOOLS_BODY'));

    unmount();
  });

  it('maximises and restores the focused debug panel with the "m" key', async () => {
    // A subagent result long enough to overflow the default 8-row viewport but fit a maximised one.
    const longResult = Array.from({ length: 20 }, (_, i) => `row-${i}`).join('\n');
    const agent = scriptedAgent([
      { type: 'tool_start', id: 's1', name: 'task' },
      { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
      { type: 'tool_end', id: 's1' },
      { type: 'tool_result', id: 's1', content: longResult },
      { type: 'text', delta: 'ok' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

    // Default 8-row viewport clips the later rows.
    expect(lastFrame()).toContain('row-0');
    expect(lastFrame()).not.toContain('row-10');

    // Focus the panel, then maximise: the hint flips and previously-clipped rows appear.
    stdin.write(TAB);
    await vi.waitFor(() => expect(lastFrame()).toContain('maximise'));
    stdin.write('m');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('row-10'); // grown viewport now shows further down
      expect(f).toContain('restore'); // hint flipped to the restore affordance
    });

    // Restore: tail clipped again, hint flips back.
    stdin.write('m');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).not.toContain('row-10');
      expect(f).toContain('maximise');
    });

    unmount();
  });

  it('shows the split "System prompt" and "Tools" tabs with captured request details (TUI-C16)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    let emit: ((c: import('#src/tui/types.js').TuiDebugCapture) => void) | undefined;
    const subscribeDebug = (cb: (c: import('#src/tui/types.js').TuiDebugCapture) => void) => {
      emit = cb;
      return () => {};
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeDebug={subscribeDebug} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // Feed a request capture split across the two tabs (system vs tool catalogue).
    emit?.({
      kind: 'request',
      text: '[]',
      system: '=== MODEL PARAMS ===\n{"model":"claude-opus-4"}',
      tools: '=== TOOLS (1) ===\n• read_file',
      mcp: '=== MCP SERVERS (0) ===\n(no MCP servers configured)',
    });

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('System prompt'));

    // Step to the System prompt tab (subagents -> system) and read its content.
    stdin.write(TAB); // focus
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));
    stdin.write(TAB); // -> system
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('MODEL PARAMS');
      expect(f).toContain('claude-opus-4');
    });

    // One more Tab reaches the Tools tab, which leads with the tool name list.
    stdin.write(TAB); // -> tools
    await vi.waitFor(() => expect(lastFrame()).toContain('read_file'));

    unmount();
  });

  it('shows the MCP tab: per-server instructions + server-prefixed tools, intro naming the Tools tab (TUI-C20)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    let emit: ((c: import('#src/tui/types.js').TuiDebugCapture) => void) | undefined;
    const subscribeDebug = (cb: (c: import('#src/tui/types.js').TuiDebugCapture) => void) => {
      emit = cb;
      return () => {};
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} subscribeDebug={subscribeDebug} />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));
    // A pre-rendered MCP capture: one server, its instructions, and a server-prefixed tool.
    emit?.({
      kind: 'request',
      text: '[]',
      system: 'SYSTEM_BODY',
      tools: 'TOOLS_BODY',
      mcp:
        'MCP server overview. See the Tools tab for full definitions.\n' +
        '────────\n\n' +
        '=== MCP SERVERS (1) ===\n\n── ctx7 ──\ninstructions:\n  Use library IDs.\n' +
        'tools (1):\n  • mcp__ctx7__get_docs: Fetch docs for a library',
    });

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('MCP'));

    // Tab to focus, then step subagents -> system -> tools -> mcp (the sixth-tab insertion point).
    stdin.write(TAB); // focus
    await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));
    stdin.write(TAB); // -> system
    stdin.write(TAB); // -> tools
    stdin.write(TAB); // -> mcp
    await vi.waitFor(() => expect(lastFrame()).toContain('MCP server overview'));
    // Maximise so the whole overview (which overflows the default 8-row viewport) is visible.
    stdin.write('m');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      // The intro names the Tools tab (this is the overview, not the schemas).
      expect(f).toContain('Tools tab');
      // The server, its captured instructions, and its server-prefixed tool all render.
      expect(f).toContain('ctx7');
      expect(f).toContain('Use library IDs.');
      expect(f).toContain('mcp__ctx7__get_docs');
    });

    unmount();
  });

  it('/clear resets the agent conversation thread, not just the transcript (TUI-C8)', async () => {
    // The on-screen reset is already covered by the transcript state; the bug was that the
    // model's checkpointer thread was left intact. Assert /clear calls the agent's
    // resetThread so the next turn starts from an empty model context.
    let resetCount = 0;
    const agent: TuiAgent = {
      async *runTurn() {
        yield { type: 'text', delta: 'hi there' };
      },
      resetThread() {
        resetCount += 1;
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="remember this" />
    );

    // First turn commits, then issue /clear.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    expect(resetCount).toBe(0); // not reset yet

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    // The agent thread was reset exactly once by the /clear.
    await vi.waitFor(() => expect(resetCount).toBe(1));
    // The status-bar turn counter is part of the cleared conversation state, so it resets to 0.
    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 0'));

    unmount();
  });

  it('/clear shows the "history cleared" banner as visible feedback (TUI-C12)', async () => {
    // A clear that says nothing reads as a command that did nothing (DL-1), so the banner is the
    // feedback — and its second line has to describe the clear that actually happened: in the
    // full-screen dock the transcript is a buffer this app owns, so clearing it is a deletion and
    // there is no scrollback to send the user back to.
    const agent = scriptedAgent([{ type: 'text', delta: 'hi there' }]);
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="remember this" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    // No banner before the clear.
    expect(lastFrame()).not.toContain('History cleared');

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('History cleared'); // banner title
      expect(f).toContain('The model no longer sees the prior conversation.');
      expect(f).toContain('gone from this session');
    });
    // …and it must NOT promise a scrollback that the alternate screen does not have.
    expect(lastFrame() ?? '').not.toContain('Scroll up');

    unmount();
  });

  it('/clear empties the owned transcript and writes NO terminal escapes (TUI-C48)', async () => {
    // TUI-C12 chose a scroll-and-clear "bump up" that preserved the terminal's own scrollback.
    // That choice was correct then and is re-decided here rather than silently broken: in the
    // alternate screen there is no scrollback to preserve and the transcript is a buffer this app
    // owns, so emptying that buffer IS the clear. Asserting the ABSENCE of the old escapes is what
    // catches the bump being reinstated by a merge or a well-meaning "restore the clear" change.
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, stdout, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    await vi.waitFor(() => expect(lastFrame()).toContain('go'));
    const before = stdout.frames.length;

    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    // The conversation really is gone from the viewport — the user line committed above it no
    // longer renders — and the counter is back to zero.
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('History cleared');
      expect(f).toContain('turns: 0');
      expect(f).not.toContain('You › go');
    });

    // Nothing the app wrote since the clear is a viewport-bump escape. The three that must not
    // appear are exactly the ones `viewportBumpSequence` emitted, so reinstating it turns this
    // red. (Blank rows are NOT a signal here: a full-screen frame legitimately pads the region
    // above a short conversation, so counting newlines would pass on anything.)
    const writtenSinceClear = stdout.frames.slice(before).join('');
    expect(writtenSinceClear).not.toContain('\x1b[H');
    expect(writtenSinceClear).not.toContain('\x1b[J');
    expect(writtenSinceClear).not.toContain('\x1b[3J');

    unmount();
  });

  it('/clear does not throw when the agent has no resetThread (fixture agent)', async () => {
    // The fixture agent omits resetThread; the optional-chaining call must be a safe no-op —
    // the app must keep running (prompt returns, no error system line).
    const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="hello world" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
    stdin.write('/clear');
    await vi.waitFor(() => expect(lastFrame()).toContain('/clear'));
    stdin.write('\r');

    // The command consumes cleanly (its echoed text clears from the prompt) and no error line
    // surfaced — i.e. the optional resetThread call did not blow up the run.
    await vi.waitFor(() => expect(lastFrame()).not.toContain('> /clear'));
    expect(frames.join('\n')).not.toContain('[error]');

    unmount();
  });

  it('/verbose commits a state-aware notice confirming the new fold state while idle (TUI-C9/C14)', async () => {
    // /verbose while idle must confirm the new state via a visible notice rather than reading as
    // a command that did nothing (DL-1).
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    // First /verbose turns detail on.
    stdin.write('/verbose');
    await vi.waitFor(() => expect(lastFrame()).toContain('/verbose'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Tool details: on'); // notice title
      expect(all).toContain('full inputs and results'); // explanatory body
    });

    // Second /verbose toggles back to off, again with a confirming notice.
    stdin.write('/verbose');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/verbose/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Tool details: off'));

    unmount();
  });

  it('/tools is gone (2.0 hard removal, GS2-8) — the TUI reports an unknown command', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    stdin.write('/tools');
    await vi.waitFor(() => expect(lastFrame()).toContain('/tools'));
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(frames.join('\n')).toContain('Unknown command: /tools');
    });

    unmount();
  });

  it('/status and /model commit explanatory notices, not silent one-liners (TUI-C14)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(
      <App {...baseProps} agent={agent} modelDisplayName="claude-opus-4" />
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    stdin.write('/status');
    await vi.waitFor(() => expect(lastFrame()).toContain('/status'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Session status'); // notice title
      expect(all).toContain('Mode: chat'); // the folded-in old /mode info (GS2-8)
      expect(all).toContain('how the agent handles your messages'); // explanation
    });

    stdin.write('/model');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/model/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('Model: claude-opus-4'); // notice title
      expect(all).toContain('model answering your messages'); // explanation
    });

    unmount();
  });

  it('/debug commits a state-aware notice as visible feedback (TUI-C14)', async () => {
    const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
    const { stdin, lastFrame, frames, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    stdin.write('/debug');
    await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Debug panel: shown'));

    stdin.write('/debug');
    await vi.waitFor(() =>
      expect((lastFrame() ?? '').match(/\/debug/g)?.length).toBeGreaterThan(0)
    );
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('\n')).toContain('Debug panel: hidden'));

    unmount();
  });

  it('/verbose sets the tool-call detail mode applied to the (live) turn that follows', async () => {
    // A blocking agent so the turn stays live for the assertion: /verbose sets the mode that the
    // live turn picks up.
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'tool_start', id: 't1', name: 'read_file' };
        yield { type: 'tool_args', id: 't1', delta: '{"path":"after.ts"}' };
        yield { type: 'tool_end', id: 't1' };
        yield { type: 'tool_result', id: 't1', content: 'after-body' };
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve());
        });
      },
    };
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    // Turn on expanded detail while idle, before sending a prompt.
    stdin.write('/verbose');
    await vi.waitFor(() => expect(lastFrame()).toContain('/verbose'));
    stdin.write('\r');
    // Wait for the command to be consumed: the notice commits (so detail is now on) and the
    // prompt is back to empty (the echoed "/verbose" cleared from the input line).
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Tool details: on'); // notice committed
      expect(f).not.toContain('> /verbose'); // prompt line cleared
    });

    // Now run a turn: the live tool call shows its args/result body because /verbose is on.
    stdin.write('hello');
    await vi.waitFor(() => expect(lastFrame()).toContain('hello'));
    stdin.write('\r');
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('read_file');
      expect(f).toContain('after.ts'); // args visible (expanded mode)
      expect(f).toContain('after-body'); // result visible
    });

    stdin.write(String.fromCharCode(27)); // Esc to end the run
    unmount();
  });

  it('folds live tool_output events into the turn and renders them in the managed frame (TUI-C17)', async () => {
    // The plumbing acceptance: a custom/dev tool's streamed stdout arrives as `tool_output`
    // events (not raw process.stdout), lands in the TurnViewModel via foldEvents, and renders
    // inside the tool panel — surviving the turn's commit into the transcript (React state,
    // not ephemeral stdout). Chunks arrive BEFORE tool_start, as they do live.
    const agent = scriptedAgent([
      {
        type: 'tool_output',
        id: 't1',
        name: 'run_shell_command',
        chunk: '🔧 Executing run_shell_command: ls -la',
        isNotice: true,
      },
      { type: 'tool_output', id: 't1', name: 'run_shell_command', chunk: 'total-12-marker\n' },
      { type: 'tool_start', id: 't1', name: 'run_shell_command' },
      { type: 'tool_args', id: 't1', delta: '{"command":"ls -la"}' },
      { type: 'tool_end', id: 't1' },
      { type: 'tool_result', id: 't1', content: 'shell-result-body' },
      { type: 'text', delta: 'Listed the files.' },
    ]);
    const { stdin, frames, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('>'));

    // Expand tool detail first so the committed panel renders its output body.
    stdin.write('/verbose');
    await vi.waitFor(() => expect(lastFrame()).toContain('/verbose'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Tool details: on'));

    stdin.write('go');
    await vi.waitFor(() => expect(lastFrame()).toContain('go'));
    stdin.write('\r');

    await vi.waitFor(() => {
      const all = frames.join('\n');
      expect(all).toContain('run_shell_command'); // the call panel
      expect(all).toContain('🔧 Executing run_shell_command: ls -la'); // routed notice, in-frame
      expect(all).toContain('total-12-marker'); // streamed child stdout, in-frame
      expect(all).toContain('Listed the files.'); // assistant text after (in-order)
    });

    unmount();
  });

  it('Ctrl+T toggles tool-call detail while a turn is streaming', async () => {
    const CTRL_T = '\x14'; // Ctrl+T control byte
    // TUI-C30: collapsed panels now PREVIEW the first 10 output lines inline, so the toggle is
    // proven on body content beyond the canonical cap (line 12 hidden collapsed, shown expanded).
    const longBody = Array.from(
      { length: 12 },
      (_, i) => `body-${String(i + 1).padStart(2, '0')}`
    ).join('\n');
    // Agent that streams a tool result then blocks, so the turn stays running for the toggle.
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'tool_start', id: 't1', name: 'read_file' };
        yield { type: 'tool_args', id: 't1', delta: '{"path":"live.ts"}' };
        yield { type: 'tool_end', id: 't1' };
        yield { type: 'tool_result', id: 't1', content: longBody };
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve());
        });
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // Live (running) tool call: collapsed summary with inline params + capped preview.
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('read_file(path=live.ts)');
      expect(f).toContain('body-01'); // preview head visible without expanding
      expect(f).toContain('(+2 more lines)'); // overflow marker at the canonical cap
      expect(f).not.toContain('body-12'); // beyond-cap content hidden while collapsed
    });

    // Ctrl+T while running expands the live tool's full body.
    stdin.write(CTRL_T);
    await vi.waitFor(() => expect(lastFrame()).toContain('body-12'));

    stdin.write(String.fromCharCode(27)); // Esc to end the run cleanly
    unmount();
  });

  /**
   * TUI-C48 — Ctrl+T is bound in every state, and the letter never reaches the prompt.
   *
   * The two halves are one case on purpose. Ctrl+T used to stand off while idle to keep
   * `ink-text-input` — which types any control chord it does not itself claim — from dropping a
   * stray `t` into the buffer, and that stand-off never worked: the prompt stays mounted while a
   * turn streams, so the letter arrived anyway. Now that the chord is kept out of the buffer where
   * it happens, the binding is free to work idle, which is when a reader paging back over the
   * conversation actually wants a turn's arguments and results. Assert the toggle without the
   * buffer and a later fix could "simplify" the sentinel away unnoticed.
   *
   * The message is carried on ACROSS the chord, one character per input event, because that is the
   * flow the expanded panel invites: read the earlier turn, keep writing. It is also the only shape
   * that discriminates — a chord leaves the text input's cursor stale, and a burst written as one
   * event hides that where four separate keystrokes expose it.
   */
  it('Ctrl+T expands a COMMITTED turn while idle, without disturbing the prompt', async () => {
    const CTRL_T = '\x14';
    const longBody = Array.from(
      { length: 12 },
      (_, i) => `body-${String(i + 1).padStart(2, '0')}`
    ).join('\n');
    // Unlike the case above, this turn ENDS: the toggle is exercised with nothing running.
    const agent: TuiAgent = {
      async *runTurn(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'tool_start', id: 't1', name: 'read_file' };
        yield { type: 'tool_args', id: 't1', delta: '{"path":"done.ts"}' };
        yield { type: 'tool_end', id: 't1' };
        yield { type: 'tool_result', id: 't1', content: longBody };
        yield { type: 'text', delta: 'finished' };
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="go" />
    );

    // The turn is committed: the panel is collapsed and the session is idle.
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('read_file(path=done.ts)');
      expect(f).toContain('finished');
      expect(f).not.toContain('body-12');
    });

    // A half-written message in the prompt, so the buffer has something to be corrupted.
    stdin.write('draft');
    await vi.waitFor(() => expect(lastFrame()).toContain('draft'));

    stdin.write(CTRL_T);

    // The idle toggle works…
    await vi.waitFor(() => expect(lastFrame()).toContain('body-12'));
    // …and the chord did not land in the buffer. `draftt` is what the unguarded text input
    // produces, so it is the assertion that states the difference.
    expect(lastFrame()).not.toContain('draftt');
    expect(lastFrame()).toContain('draft');

    // Carry on writing, one keystroke at a time, with exactly one chord behind us — waiting for
    // each character to be drawn, so the next one cannot be batched into the same input event.
    // Refused only at onChange, this reads `draftorem`.
    const rest = 'more';
    for (let i = 0; i < rest.length; i++) {
      stdin.write(rest[i]);
      const expected = `draft${rest.slice(0, i + 1)}`;
      await vi.waitFor(() => expect(lastFrame()).toContain(expected));
    }

    // And back: the same key re-folds it, so this is a toggle rather than a one-way reveal.
    stdin.write(CTRL_T);
    await vi.waitFor(() => expect(lastFrame()).not.toContain('body-12'));
    expect(lastFrame()).toContain('draftmore');
    // The SECOND chord's letter has its own assertion: `draftmore` is a substring of `draftmoret`,
    // so the line above would pass with the stray `t` appended and prove only the first chord.
    expect(lastFrame()).not.toContain('draftmoret');

    // The message the user is about to send is what they wrote.
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('You › draftmore'));
    expect(lastFrame()).not.toContain('You › draftmoret');

    unmount();
  });

  it('renders completed assistant markdown as formatted output in the transcript', async () => {
    const agent = scriptedAgent([
      { type: 'text', delta: '# Heading\n' },
      { type: 'text', delta: '- bullet point' },
    ]);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      // Markdown applied once the turn committed: list bullet glyph present, raw '- ' gone.
      expect(f).toContain('Heading');
      expect(f).toContain('• bullet point');
    });

    unmount();
  });

  it('aborts the in-flight turn when Esc is pressed', async () => {
    let aborted = false;
    const agent: TuiAgent = {
      async *runTurn(_input, signal) {
        yield { type: 'text', delta: 'working' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    };

    const { stdin, frames, unmount } = render(
      <App {...baseProps} agent={agent} initialMessage="run" />
    );

    await vi.waitFor(() => expect(frames.join('\n')).toContain('working'));
    stdin.write(ESC);
    await vi.waitFor(() => expect(aborted).toBe(true));

    unmount();
  });

  // ── TUI-C21: `less`-style `/` search across the focused debug pane ───────────────────────────
  describe('debug pane search (TUI-C21)', () => {
    // A subagent whose 40-line result overflows the 8-row viewport, so a match can be off-screen.
    const longResultAgent = () => {
      const longResult = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
      return scriptedAgent([
        { type: 'tool_start', id: 's1', name: 'task' },
        { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
        { type: 'tool_end', id: 's1' },
        { type: 'tool_result', id: 's1', content: longResult },
        { type: 'text', delta: 'ok' },
      ]);
    };

    it('scopes `/` to pane focus: searches the focused pane, jumps the viewport to a match, shows N/M', async () => {
      const { stdin, lastFrame, unmount } = render(
        <App {...baseProps} agent={longResultAgent()} initialMessage="go" />
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
      stdin.write('/debug');
      await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('worker'));

      // Focus the pane; now the prompt is unmounted, so `/` can only mean "search this pane".
      stdin.write(TAB);
      await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));
      // "line-30" is clipped by the 8-row viewport before searching.
      expect(lastFrame()).not.toContain('line-30');

      // Open search and type "30": the sole match is the body line "line-30", far below the fold.
      stdin.write('/');
      stdin.write('3');
      stdin.write('0');
      await vi.waitFor(() => {
        const f = lastFrame() ?? '';
        // The viewport jumped to the match — the query echo is only "30", so "line-30" in the
        // frame proves the BODY line is now visible (the reused TUI-C11 scroll offset).
        expect(f).toContain('line-30');
        expect(f).toContain('1/1'); // footer match indicator
      });
      unmount();
    });

    it('leaves the global slash line intact when the pane is NOT focused (`/` opens the command menu)', async () => {
      const agent = scriptedAgent([{ type: 'text', delta: 'hi' }]);
      const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={agent} />);
      await vi.waitFor(() => expect(lastFrame()).toContain('>'));
      stdin.write('/debug');
      await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
      stdin.write('\r');
      // Panel is open but UNFOCUSED (no Tab): the prompt still owns `/`.
      await vi.waitFor(() => expect(lastFrame()).toContain('Subagents'));

      stdin.write('/');
      await vi.waitFor(() => {
        const f = lastFrame() ?? '';
        expect(f).toContain('❯'); // the slash-command discovery menu cursor (global slash intact)
        expect(f).toContain('/help'); // a discovered command
      });
      // …and `/` did NOT open a pane search.
      expect(lastFrame()).not.toContain('no matches');
      expect(lastFrame()).not.toContain('(type to search)');
      unmount();
    });

    it('navigates matches with n/N (wrap-around) and clears the search on Esc while keeping focus', async () => {
      const body = ['alpha', 'needle one', 'beta', 'needle two', 'gamma', 'needle three'].join(
        '\n'
      );
      const agent = scriptedAgent([
        { type: 'tool_start', id: 's1', name: 'task' },
        { type: 'tool_args', id: 's1', delta: '{"subagent_type":"worker","description":"big"}' },
        { type: 'tool_end', id: 's1' },
        { type: 'tool_result', id: 's1', content: body },
        { type: 'text', delta: 'ok' },
      ]);
      const { stdin, lastFrame, unmount } = render(
        <App {...baseProps} agent={agent} initialMessage="go" />
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
      stdin.write('/debug');
      await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('worker'));
      stdin.write(TAB);
      await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));

      // Search "needle": three matches, cursor on the first → 1/3.
      stdin.write('/');
      for (const ch of 'needle') stdin.write(ch);
      await vi.waitFor(() => expect(lastFrame()).toContain('1/3'));

      // TUI-C63 — the legend has to stay ONE row, and this is the state that decides it: focused,
      // with a live query, so `Esc` reads `clear search` (its longest form) and `m` reads `maximise`
      // (longer than `restore`). ink-testing-library renders at 100 columns — the width the it-tui
      // search case also uses — and the panel's border leaves 98 cells, which the row now fills
      // exactly. So the opening `[Tab: section` and the closing bracket must land on the SAME frame
      // line; a wrap moves the tail to the next one and costs the conversation a row.
      const legendRow = (lastFrame() ?? '').split('\n').find((l) => l.includes('Tab: section'));
      expect(legendRow).toBeDefined();
      expect(legendRow).toContain('clear search]');

      stdin.write('\r'); // confirm: leave typing mode, keep highlights (n/N now navigate)

      // n steps forward; a third n wraps back to the first.
      stdin.write('n');
      await vi.waitFor(() => expect(lastFrame()).toContain('2/3'));
      stdin.write('n');
      await vi.waitFor(() => expect(lastFrame()).toContain('3/3'));
      stdin.write('n');
      await vi.waitFor(() => expect(lastFrame()).toContain('1/3')); // wrapped forward

      // N (previous) wraps backward from the first to the last.
      stdin.write('N');
      await vi.waitFor(() => expect(lastFrame()).toContain('3/3'));

      // Esc clears the search (indicator gone) but keeps the pane focused.
      stdin.write(ESC);
      await vi.waitFor(() => {
        const f = lastFrame() ?? '';
        expect(f).not.toContain('3/3');
        expect(f).toContain('Tab: section'); // still focused (Esc cleared search, did not unfocus)
      });
      unmount();
    });

    it('shows the no-match state (count 0, friendly) for a query with no hits', async () => {
      const { stdin, lastFrame, unmount } = render(
        <App {...baseProps} agent={longResultAgent()} initialMessage="go" />
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('turns: 1'));
      stdin.write('/debug');
      await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('worker'));
      stdin.write(TAB);
      await vi.waitFor(() => expect(lastFrame()).toContain('Tab: section'));

      stdin.write('/');
      for (const ch of 'zzq') stdin.write(ch);
      await vi.waitFor(() => expect(lastFrame()).toContain('no matches'));
      unmount();
    });
  });

  // TUI-C19 — persistent config-advisory line in the pinned dock, plus /config surfacing the
  // actual warning text.
  describe('config-advisory notice (TUI-C19)', () => {
    const CONFIG_WARNING =
      'Unknown top-level config key in .gsloth.config.json: pullrequest. It is kept as-is but ignored by Gaunt Sloth; check for typos.';
    const STANDING_LINE = '⚠ Your config has problems';

    it('shows the standing "config has problems" line when there are advisories', async () => {
      const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
      const { lastFrame, unmount } = render(
        <App {...baseProps} agent={agent} advisories={[CONFIG_WARNING]} />
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain(STANDING_LINE);
        expect(frame).toContain('/config'); // points the user at the details
      });

      unmount();
    });

    it('shows NO standing line when the config is clean (no advisories)', async () => {
      const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
      const { lastFrame, unmount } = render(
        <App {...baseProps} agent={agent} advisories={[]} initialMessage="go" />
      );

      // Wait until the session is idle so the chrome has fully rendered, then assert the line is
      // absent.
      await vi.waitFor(() => expect(lastFrame()).toContain('ready'));
      expect(lastFrame() ?? '').not.toContain('config has problems');

      unmount();
    });

    it('renders the line in the pinned dock — below the conversation, above the status bar', async () => {
      // TUI-C48 replaced this test's mechanism rather than porting it. It used to discriminate by
      // <Static> placement (committed output at the top, live chrome after it), and <Static> is
      // gone. The full-screen layout gives a stronger discriminator in its place: the dock is the
      // LAST rows of a frame that is exactly the terminal height, so the advisory line's position
      // can be checked against the terminal floor rather than against a render-order convention.
      //
      // The three assertions below fail for three different mistakes: putting NoticeBar inside the
      // conversation viewport (it would sit above the committed text, or scroll out of it),
      // putting it below the status bar, or letting the frame stop short of the terminal floor.
      const agent = scriptedAgent([{ type: 'text', delta: 'committed answer' }]);
      const { lastFrame, unmount } = render(
        <App {...baseProps} agent={agent} advisories={[CONFIG_WARNING]} initialMessage="hello" />
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('committed answer');
        expect(frame).toContain('ready');
      });

      const rows = (lastFrame() ?? '').split('\n');
      const rowOf = (needle: string) => rows.findIndex((line) => line.includes(needle));
      const lineRow = rowOf(STANDING_LINE);
      const transcriptRow = rowOf('committed answer');
      const statusRow = rowOf('chat');

      // Present at all (advisories → shown), and below the committed conversation.
      expect(lineRow).toBeGreaterThan(-1);
      expect(lineRow).toBeGreaterThan(transcriptRow);
      // …up in the dock with the status bar…
      expect(lineRow).toBeLessThan(statusRow);
      // …and the dock really is the floor: the status bar sits in the last handful of rows of a
      // frame that fills the terminal, not somewhere in the middle of it.
      expect(rows.length).toBe(FALLBACK_TERMINAL_ROWS);
      expect(statusRow).toBeGreaterThan(rows.length - 6);

      unmount();
    });

    it('surfaces the actual warning text via /config (the details the line points at)', async () => {
      const agent = scriptedAgent([{ type: 'text', delta: 'done' }]);
      const { stdin, lastFrame, frames, unmount } = render(
        <App
          {...baseProps}
          agent={agent}
          advisories={[CONFIG_WARNING]}
          configSummary={['Model: claude-x', 'Agent backend: lean']}
        />
      );

      // Idle first so the prompt is mounted, type /config, wait for it to register, then Enter
      // (mirrors the /help dispatch test's stdin pattern).
      await vi.waitFor(() => expect(lastFrame()).toContain('>'));
      stdin.write('/config');
      await vi.waitFor(() => expect(lastFrame()).toContain('/config'));
      stdin.write('\r');

      await vi.waitFor(() => {
        const all = frames.join('\n');
        expect(all).toContain('Resolved configuration'); // the /config notice title
        expect(all).toContain('pullrequest'); // the actual validation-warning text
        expect(all).toContain('check for typos');
      });

      unmount();
    });
  });
});
