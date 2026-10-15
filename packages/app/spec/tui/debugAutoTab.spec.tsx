import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { ResolvedApprovals } from '@gaunt-sloth/core/config.js';
import type { ApprovalDecisionCapture } from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';

/**
 * TUI-C27 — the **Auto-mode** tab in the docked `/debug` pane, through a mounted `<App>`.
 *
 * The four-case distinction (floored · rated · unresolvable · list-matched) is asserted on the pure
 * renderer in `debugApprovalRender.spec.ts`, where it can be put precisely. What only a mounted
 * `<App>` can show is the rest of the tab's claim: that it is IN the strip, that TUI-C11's Tab
 * cycling reaches it, that what it draws is read from the session's live capture log rather than
 * from a snapshot taken at mount, and that a surface with no approvals gate gets an empty state
 * instead of an empty promise.
 */
function idleAgent(): TuiAgent {
  return {
    async *runTurn() {
      yield { type: 'text', delta: 'hi' };
    },
  };
}

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

const TAB = '\t';
const SHIFT_TAB = '\x1b[Z'; // Shift+Tab (back-tab) CSI sequence
const PAGE_DOWN = '\x1b[6~';

/** The tab's own first words — the description that opens it. */
const TAB_DESCRIPTION_HEAD = 'Auto-mode: what the approvals gate did';

const APPROVALS = {
  rung: 'auto',
  rater: 'sentry',
  alignmentChecker: 'sentry',
  allow: [],
  deny: [],
  escalate: [],
} as unknown as ResolvedApprovals;

/** One floored decision — short, and unmistakable in a frame. */
function flooredCapture(): ApprovalDecisionCapture {
  return {
    at: '2026-09-18T10:00:00.000Z',
    tool: 'run_shell_command',
    rung: 'auto',
    command: 'rm -rf /',
    stage: 'hardline-floor',
    action: 'reject',
    hardline: { description: 'deletes the filesystem root', pattern: 'rm-rf-root' },
    budget: {
      consecutiveRejections: 0,
      rejectionsSinceHuman: 0,
      maxConsecutive: 3,
      maxBeforeHuman: 5,
    },
  };
}

type Stdin = { write: (s: string) => void };

/**
 * Open `/debug`, focus the pane, and step to the Auto-mode tab.
 *
 * **One Shift+Tab, not six Tabs.** The tab is last in the cycle, so a single back-tab lands on it —
 * and writing six tabs in a row would arrive as one stdin chunk that Ink decodes as a single
 * six-character input rather than six Tab keys. (The forward cycle is covered by App.spec's own
 * TUI-C11 test, which waits on each section between keystrokes.)
 */
async function openAutoModeTab(stdin: Stdin, lastFrame: () => string | undefined): Promise<void> {
  await vi.waitFor(() => expect(lastFrame()).toContain('>'));
  stdin.write('/debug');
  await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
  stdin.write('\r');
  await vi.waitFor(() => expect(stripAnsi(lastFrame() ?? '')).toContain('Subagents'));
  stdin.write(TAB); // focus the pane
  await vi.waitFor(() => expect(stripAnsi(lastFrame() ?? '')).toContain('Tab: section'));
  stdin.write(SHIFT_TAB); // wrap backward from the first section onto the last
  await vi.waitFor(() => expect(stripAnsi(lastFrame() ?? '')).toContain(TAB_DESCRIPTION_HEAD));
}

describe('TUI-C27 — the Auto-mode tab in the docked debug pane', () => {
  it('is in the tab strip as soon as the pane opens', async () => {
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={idleAgent()} />);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('>'));
      expect(stripAnsi(lastFrame() ?? '')).not.toContain('Auto-mode');

      stdin.write('/debug');
      await vi.waitFor(() => expect(lastFrame()).toContain('/debug'));
      stdin.write('\r');

      await vi.waitFor(() => {
        const f = stripAnsi(lastFrame() ?? '');
        // The tabs TUI-C16/TUI-C20 already gave the pane are untouched and the new one sits with
        // them — a strip that lost one of these would be a regression, not a new tab.
        expect(f).toContain('Subagents');
        expect(f).toContain('Raw response');
        expect(f).toContain('Auto-mode');
      });
    } finally {
      unmount();
    }
  });

  it('opens with a description naming what it shows, over the rater config in force', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={idleAgent()}
        initialApprovals={APPROVALS}
        readApprovalCaptures={() => []}
      />
    );
    try {
      await openAutoModeTab(stdin, lastFrame);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain(TAB_DESCRIPTION_HEAD);
      expect(f).toContain('WHICH STAGE decided it');
      expect(f).toContain('RATER CONFIG');
    } finally {
      unmount();
    }
  });

  it('draws the gate’s decisions, read from the live log at render rather than at mount', async () => {
    // The log is mutated in place as each decision is made, and the decision this tab exists for —
    // a call the rater approves on its first rating — relays no event to any surface. A tab fed by
    // a snapshot taken at mount, or by a subscription to the approval/negotiation traffic, would
    // show an empty session straight through it. Handing back a DIFFERENT list on a later read is
    // what pins the pull.
    let live: ApprovalDecisionCapture[] = [];
    const readApprovalCaptures = vi.fn(() => live);

    const { stdin, lastFrame, unmount } = render(
      <App
        {...baseProps}
        agent={idleAgent()}
        initialApprovals={APPROVALS}
        readApprovalCaptures={readApprovalCaptures}
      />
    );
    try {
      await openAutoModeTab(stdin, lastFrame);
      // The description is long enough to fill the 8-row viewport on its own, so page to the end
      // of the tab, where the call list is.
      stdin.write(PAGE_DOWN);
      await vi.waitFor(() =>
        expect(stripAnsi(lastFrame() ?? '')).toContain('no tool call has been through the gate yet')
      );

      // A decision lands in the runner's log with no event of any kind …
      live = [flooredCapture()];
      // … and the next repaint picks it up. `m` is the keystroke used because it is a state change
      // that is certain to repaint — and it also grows the viewport enough to hold the record. This
      // IS the design: a pull redrawn with the frame, not a ticker with its own clock.
      stdin.write('m');
      await vi.waitFor(() => {
        const f = stripAnsi(lastFrame() ?? '');
        expect(f).toContain('GATED CALLS (1) — most recent first');
        expect(f).toContain('command: rm -rf /');
        expect(f).toContain('hardline floor: deletes the filesystem root');
      });
      expect(readApprovalCaptures.mock.calls.length).toBeGreaterThan(1);
    } finally {
      unmount();
    }
  });

  it('shows an empty state on a surface with no approvals gate rather than an empty promise', async () => {
    // The fixture agent and the AG-UI path omit the reader entirely; the tab must still render.
    const { stdin, lastFrame, unmount } = render(<App {...baseProps} agent={idleAgent()} />);
    try {
      await openAutoModeTab(stdin, lastFrame);
      expect(stripAnsi(lastFrame() ?? '')).toContain(TAB_DESCRIPTION_HEAD);
      stdin.write(PAGE_DOWN);
      await vi.waitFor(() => {
        const f = stripAnsi(lastFrame() ?? '');
        expect(f).toContain('this session has no approvals surface');
        expect(f).toContain('no tool call has been through the gate yet');
      });
    } finally {
      unmount();
    }
  });
});
