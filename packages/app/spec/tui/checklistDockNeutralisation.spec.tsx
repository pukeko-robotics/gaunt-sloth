import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { CHECKLIST_TOOL_NAME } from '#src/tui/viewModel.js';

/**
 * REL-18 — the pinned checklist panel paints text the MODEL wrote, and it paints it directly above
 * the input dock: of every place forged chrome could be drawn this is the one closest to the
 * prompt. The hazard is not defacement but forgery beside a decision — SGR plus cursor positioning
 * painting something shaped like gsloth's own output, on a panel that is by design glanced at
 * rather than read.
 *
 * The case has to go through `<App>`, and that is not a stylistic preference. The checklist tool
 * call draws NOTHING inside the turn (`drawsNothing` in `viewModel.ts` returns true for it and
 * `displaySegments` drops the segment), so a spec that renders a checklist call inside a `LiveTurn`
 * asserts on a panel that was never mounted and would pass against raw ANSI. And the guard sits on
 * `parseChecklistArgs`, the function that PRODUCES the painted rows — so mounting `ChecklistPanel`
 * with hand-built items would bypass the very treatment under test. Feeding the streamed args
 * through the agent into the dock is the only arrangement in which both halves are real.
 */

/** A fake agent that replays a fixed event script for each turn (mirrors `App.spec.tsx`). */
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
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/**
 * Written as the raw bytes a terminal acts on, built with `String.fromCharCode` rather than pasted
 * literally, so the source file stays readable and a stray byte cannot go unnoticed in a diff.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * The hazards the acceptance names, in one row:
 *
 * - `ESC [ 31 m` — SGR, the colour a forgery would be painted in;
 * - `ESC ] 0 ; … BEL` — an OSC that retitles the window, terminated by BEL;
 * - `ESC [ 2 A` — cursor movement, which is what turns colour into *placement*.
 *
 * Kept short deliberately: the assertions are `toContain` over a rendered frame, and a row long
 * enough for Ink to wrap would split a token across a line break and fail for a reason that has
 * nothing to do with neutralisation.
 */
const RAW_PAYLOAD = `plan ${ESC}[31mRED${ESC}]0;pwned${BEL} ${ESC}[2A step`;

/** The same row after neutralisation: every escape visible, none of it live. */
const ESCAPED_SGR = '\\x1b[31m';
const ESCAPED_OSC = '\\x1b]0;pwned';
const ESCAPED_BEL = '\\x07';
const ESCAPED_CURSOR = '\\x1b[2A';

const checklistEvents: AgentStreamEvent[] = [
  { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
  {
    type: 'tool_args',
    id: 'c1',
    delta: JSON.stringify({ items: [{ content: RAW_PAYLOAD, status: 'in_progress' }] }),
  },
  { type: 'tool_end', id: 'c1' },
];

describe('REL-18 — the pinned checklist panel neutralises the model’s item text', () => {
  it('renders ESC, OSC, BEL and cursor movement visible and inert', async () => {
    const agent = scriptedAgent(checklistEvents);
    const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);

    await vi.waitFor(() => expect(stripAnsi(lastFrame() ?? '')).toContain('Checklist'));

    const raw = lastFrame() ?? '';
    const visible = stripAnsi(raw);

    // The panel actually painted, and it painted THIS row. Without these the negative assertions
    // below would pass just as well against a dock that never mounted the checklist at all.
    expect(visible).toContain('Checklist (0/1)');
    expect(visible).toContain('plan');
    expect(visible).toContain('step');

    // Every escape is on the screen as printable text — the sequence is still readable, which is
    // the point: nothing is discarded, it is only made incapable of acting.
    expect(visible).toContain(ESCAPED_SGR);
    expect(visible).toContain(ESCAPED_OSC);
    expect(visible).toContain(ESCAPED_BEL);
    expect(visible).toContain(ESCAPED_CURSOR);

    // …and none of it survives as bytes the terminal would obey. Checked against the RAW frame,
    // before `stripAnsi`: the frame legitimately carries Ink's own SGR (the panel's own colours),
    // so stripping first would remove the attacker's escapes along with the renderer's and leave
    // an assertion that cannot fail. BEL, an OSC introducer and a cursor-up are things Ink never
    // emits, so finding one is unambiguous.
    expect(raw).not.toContain(BEL);
    expect(raw).not.toContain(`${ESC}]0;`);
    expect(raw).not.toContain(`${ESC}[2A`);

    unmount();
  });
});
