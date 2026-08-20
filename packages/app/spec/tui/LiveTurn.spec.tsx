import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, renderToString } from 'ink';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { LiveTurn, ReasoningPanel } from '#src/tui/components/LiveTurn.js';
import type { ToolCallViewModel, TurnViewModel } from '#src/tui/viewModel.js';

/**
 * A turn in the reasoning-then-tools-then-text layout these cases were written for. The turn model
 * records arrival order as a segment list (TUI-C52, extended to reasoning by TUI-C81), so this
 * builds that layout explicitly; the interleaved orders it made expressible have their own spec
 * (`turnSegments.spec.tsx`).
 */
const turn = (
  over: {
    text?: string;
    reasoning?: string;
    isReasoning?: boolean;
    toolCalls?: ToolCallViewModel[];
  } = {}
): TurnViewModel => ({
  isReasoning: over.isReasoning ?? false,
  segments: [
    ...(over.reasoning ? [{ kind: 'reasoning' as const, text: over.reasoning }] : []),
    ...(over.toolCalls ?? []).map((tool) => ({ kind: 'tool' as const, tool })),
    ...(over.text ? [{ kind: 'text' as const, text: over.text }] : []),
  ],
});

describe('tui <LiveTurn>', () => {
  beforeEach(() => {
    chalk.level = 3;
  });

  describe('collapsible tool-call panels', () => {
    const withTool = turn({
      toolCalls: [
        {
          id: 't1',
          name: 'read_file',
          argsText: '{"path":"README.md"}',
          status: 'done',
          result: 'file contents here',
        },
      ],
    });

    it('collapsed by default: summary with inline params + a dim result preview (TUI-C30)', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withTool} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('read_file(path=README.md)'); // params inline, not a raw JSON dump
      expect(f).not.toContain('{"path"'); // the raw args JSON stays hidden collapsed
      expect(f).toContain('done'); // status word
      expect(f).toContain('▸'); // collapsed caret
      expect(f).toContain('file contents here'); // the head of the result previews inline
      unmount();
    });

    it('shows the Ctrl+T expand hint when collapsed on the live (streaming) turn', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withTool} streaming />);
      expect(stripAnsi(lastFrame() ?? '')).toContain('Ctrl+T to expand');
      unmount();
    });

    it('omits the Ctrl+T hint on a committed (non-live) turn', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withTool} />);
      expect(stripAnsi(lastFrame() ?? '')).not.toContain('Ctrl+T to expand');
      unmount();
    });

    it('expanded: shows the args and result body and the open caret', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withTool} toolsExpanded />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('read_file');
      expect(f).toContain('▾'); // expanded caret
      expect(f).toContain('README.md'); // args shown
      expect(f).toContain('file contents here'); // result shown
      expect(f).not.toContain('Ctrl+T to expand'); // hint gone when expanded
      unmount();
    });

    it('shows a running tool with the running marker and no result', () => {
      const running = turn({
        toolCalls: [{ id: 't1', name: 'search', argsText: '', status: 'running' }],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={running} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('search');
      expect(f).toContain('running');
      expect(f).toContain('⋯');
      unmount();
    });

    it('marks a tool as errored from the real isError signal, not the result text', () => {
      const errored = turn({
        toolCalls: [
          {
            id: 't1',
            name: 'run',
            argsText: '',
            status: 'done',
            result: 'boom happened',
            isError: true,
          },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={errored} toolsExpanded />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('error');
      expect(f).toContain('✗');
      expect(f).toContain('boom happened');
      unmount();
    });

    it('previews live streamed output collapsed (TUI-C30) and shows the notice only expanded', () => {
      const withOutput = turn({
        toolCalls: [
          {
            id: 't1',
            name: 'run_shell_command',
            argsText: '{"command":"ls -la"}',
            status: 'running',
            notice: '🔧 Executing run_shell_command: ls -la',
            output: 'total 12\ndrwxr-xr-x  2 me\n',
          },
        ],
      });
      const collapsed = render(<LiveTurn turn={withOutput} />);
      const fc = stripAnsi(collapsed.lastFrame() ?? '');
      expect(fc).toContain('run_shell_command(command=ls -la)'); // summary with inline params
      expect(fc).toContain('total 12'); // live output previews inline while collapsed
      expect(fc).not.toContain('Executing run_shell_command'); // notice is expanded-only chrome
      collapsed.unmount();

      const expanded = render(<LiveTurn turn={withOutput} toolsExpanded />);
      const fe = stripAnsi(expanded.lastFrame() ?? '');
      expect(fe).toContain('🔧 Executing run_shell_command: ls -la'); // the routed notice
      expect(fe).toContain('total 12'); // child stdout, inside the managed frame
      expect(fe).toContain('drwxr-xr-x  2 me');
      expanded.unmount();
    });

    it('the output body alone makes the panel expandable (Ctrl+T hint on the live turn)', () => {
      // A tool that has streamed output but no args/result yet must still advertise detail.
      const onlyOutput = turn({
        toolCalls: [
          { id: 't1', name: 'run_tests', argsText: '', status: 'running', output: 'suite up\n' },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={onlyOutput} streaming />);
      expect(stripAnsi(lastFrame() ?? '')).toContain('Ctrl+T to expand');
      unmount();
    });

    it('renders ✓ for a successful result even when its text literally starts with "Error"', () => {
      // Regression guard: the old heuristic sniffed the result text and mislabeled this.
      const successButErrorText = turn({
        toolCalls: [
          {
            id: 't1',
            name: 'run',
            argsText: '',
            status: 'done',
            result: 'Error handling guide: how to recover from failures',
            // isError omitted => success
          },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={successButErrorText} toolsExpanded />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('✓');
      expect(f).toContain('done');
      expect(f).not.toContain('✗');
      unmount();
    });
  });

  describe('TUI-C30 rich tool rendering (preview cap, diff colours, dedupe)', () => {
    it('caps the collapsed preview at the canonical 10 lines with an overflow marker', () => {
      const longResult = Array.from(
        { length: 14 },
        (_, i) => `row-${String(i + 1).padStart(2, '0')}`
      ).join('\n');
      const t = turn({
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            argsText: '{"path":"big.txt"}',
            status: 'done',
            result: longResult,
          },
        ],
      });
      const collapsed = render(<LiveTurn turn={t} />);
      const fc = stripAnsi(collapsed.lastFrame() ?? '');
      expect(fc).toContain('row-01'); // preview head
      expect(fc).toContain('row-10'); // the canonical 10th line
      expect(fc).not.toContain('row-11'); // beyond-cap hidden collapsed
      expect(fc).toContain('… (+4 more lines)'); // overflow marker
      collapsed.unmount();

      // Expand still shows the full body (existing /tools / Ctrl+T behaviour preserved).
      const expanded = render(<LiveTurn turn={t} toolsExpanded />);
      const fe = stripAnsi(expanded.lastFrame() ?? '');
      expect(fe).toContain('row-14');
      expect(fe).not.toContain('more lines');
      expanded.unmount();
    });

    it('renders write_file as an added-lines diff (green), not a raw args dump', () => {
      const t = turn({
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            argsText: JSON.stringify({ path: 'src/new.ts', content: 'line one\nline two' }),
            status: 'done',
            result: 'Successfully wrote to src/new.ts',
          },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} />);
      const raw = lastFrame() ?? '';
      const f = stripAnsi(raw);
      expect(f).toContain('write_file(path=src/new.ts, …)'); // content elided from the summary
      expect(f).toContain('+ line one');
      expect(f).toContain('+ line two');
      expect(f).not.toContain('"content"'); // no raw JSON dump
      expect(raw).toContain('[32m'); // chalk.level=3 → green SGR on the added lines
      unmount();
    });

    it('renders edit_file as a remove/add diff with red and green SGRs', () => {
      const t = turn({
        toolCalls: [
          {
            id: 'e1',
            name: 'edit_file',
            argsText: JSON.stringify({
              path: 'src/x.ts',
              edits: [{ oldText: 'const answer = 41;', newText: 'const answer = 42;' }],
            }),
            status: 'done',
          },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} />);
      const raw = lastFrame() ?? '';
      const f = stripAnsi(raw);
      expect(f).toContain('edit_file(path=src/x.ts, …)');
      expect(f).toContain('- const answer = 41;');
      expect(f).toContain('+ const answer = 42;');
      expect(raw).toContain('[31m'); // red SGR (removed)
      expect(raw).toContain('[32m'); // green SGR (added)
      unmount();
    });

    it('dedupes a shell result that repeats the live output (<COMMAND_OUTPUT>)', () => {
      const t = turn({
        toolCalls: [
          {
            id: 's1',
            name: 'run_shell_command',
            argsText: '{"command":"echo hi"}',
            status: 'done',
            output: 'hi\n',
            result:
              "Executing 'echo hi'...\n\n<COMMAND_OUTPUT>\nhi\n</COMMAND_OUTPUT>\n" +
              "\n\nCommand 'echo hi' completed successfully",
          },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} toolsExpanded />);
      const f = stripAnsi(lastFrame() ?? '');
      // The output body renders ONCE (live output preferred), plus the closing status line.
      expect(f.match(/^\s*hi$/gm) ?? []).toHaveLength(1);
      expect(f).toContain("Command 'echo hi' completed successfully");
      expect(f).not.toContain('<COMMAND_OUTPUT>'); // the wrapper tags are chrome, not content
      unmount();
    });

    // fix-cycle-1 regression — redact-before-truncate on the TUI path end-to-end: a >48-char
    // patternless literal secret from a secret-named env var must be FULLY redacted in the
    // rendered panel summary (truncation must never bisect it out of literal-matching).
    it('fully redacts an over-cap patternless env secret in the panel summary', async () => {
      const secret = 'deadbeef'.repeat(8); // 64 chars, matches no provider pattern
      const { resetToolDisplaySecretsCacheForTests } =
        await import('@gaunt-sloth/core/core/toolDisplay.js');
      process.env.GTH_TEST_ONLY_API_KEY = secret;
      resetToolDisplaySecretsCacheForTests(); // re-collect env-derived literals with the var set
      try {
        const t = turn({
          toolCalls: [
            {
              id: 's1',
              name: 'gth_web_fetch',
              argsText: JSON.stringify({ url: 'https://x.test', token: secret }),
              status: 'done',
            },
          ],
        });
        const { lastFrame, unmount } = render(<LiveTurn turn={t} />);
        const f = stripAnsi(lastFrame() ?? '');
        expect(f).toContain('token=<redacted>');
        expect(f).not.toContain('deadbeef'); // no leaked head of the secret
        unmount();
      } finally {
        delete process.env.GTH_TEST_ONLY_API_KEY;
        resetToolDisplaySecretsCacheForTests(); // don't leak the literal into other tests
      }
    });

    it('truncates an over-long param value with … and redacts secret-shaped values', () => {
      const longPath = 'very/long/path/'.repeat(10) + 'file.ts';
      const t = turn({
        toolCalls: [
          {
            id: 'p1',
            name: 'read_file',
            argsText: JSON.stringify({ path: longPath }),
            status: 'done',
          },
          {
            id: 'p2',
            name: 'gth_web_fetch',
            argsText: JSON.stringify({ token: 'sk-abcdefghijklmnopqrstuvwxyz123456' }),
            status: 'done',
          },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('…'); // over-long value truncated
      expect(f).not.toContain(longPath); // never the full value
      expect(f).toContain('<redacted>'); // provider-key pattern redacted (GS2-47 lineage)
      expect(f).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
      unmount();
    });
  });

  describe('checklist panel (gth_checklist)', () => {
    const withChecklist = turn({
      toolCalls: [
        {
          id: 'c1',
          name: 'gth_checklist',
          argsText: JSON.stringify({
            items: [
              { content: 'Set up config', status: 'completed' },
              { content: 'Implement tool', status: 'in_progress' },
              { content: 'Write tests', status: 'pending' },
            ],
          }),
          status: 'running',
        },
      ],
    });

    it('suppresses rendering within LiveTurn (rendered in pinned bottom dock)', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withChecklist} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).not.toContain('📋 Checklist');
      expect(f).not.toContain('[x] Set up config');
      unmount();
    });
  });

  describe('reasoning region (💭 Thinking)', () => {
    const withReasoning = turn({
      reasoning: 'First I consider the options.\nThen I decide.',
      text: '👍',
    });

    it('collapsed by default: shows the 💭 Thinking label + collapsed caret, hides the thought body', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withReasoning} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('💭 Thinking'); // label affordance
      expect(f).toContain('▸'); // collapsed caret
      expect(f).not.toContain('First I consider the options.'); // thought hidden
      expect(f).not.toContain('│'); // gutter only renders when expanded
      expect(f).toContain('👍'); // the answer still shows
      unmount();
    });

    it('expanded: shows the open caret, the │ gutter and the thought body', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withReasoning} toolsExpanded />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('💭 Thinking');
      expect(f).toContain('▾'); // expanded caret
      expect(f).toContain('│'); // gutter
      expect(f).toContain('First I consider the options.'); // thought body line 1
      expect(f).toContain('Then I decide.'); // thought body line 2
      unmount();
    });

    it('shows the Ctrl+T expand hint when collapsed on the live (streaming) turn', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withReasoning} streaming />);
      expect(stripAnsi(lastFrame() ?? '')).toContain('Ctrl+T to expand');
      unmount();
    });

    /**
     * TUI-C48 — while a turn streams, the collapsed panel keeps its newest lines on screen, so a
     * thinking model shows what it is thinking about rather than a bare header.
     *
     * The cap is its own number and not the ten-line tool-output preview: the cases below assert
     * the count exactly rather than "some lines", because a preview that silently grew to ten
     * would let thinking take over the screen the panel collapses to stay out of, and nothing on
     * screen would look wrong.
     */
    describe('live preview while streaming (TUI-C48)', () => {
      const thoughts = ['one.', 'two.', 'three.', 'four.', 'five.'];
      const streamingTurn = turn({ reasoning: thoughts.join('\n'), text: '' });

      /** The gutter rows of the reasoning region — one per previewed line. */
      const gutterLines = (frame: string): string[] =>
        stripAnsi(frame)
          .split('\n')
          .filter((row) => row.trimStart().startsWith('│'))
          .map((row) => row.slice(row.indexOf('│') + 1).trim());

      it('shows exactly the newest two lines, and not the ones before them', () => {
        const { lastFrame, unmount } = render(<LiveTurn turn={streamingTurn} streaming />);
        expect(gutterLines(lastFrame() ?? '')).toEqual(['four.', 'five.']);
        unmount();
      });

      it('follows the stream: newer lines replace older ones', () => {
        const { lastFrame, rerender, unmount } = render(
          <LiveTurn turn={turn({ reasoning: 'one.\ntwo.', text: '' })} streaming />
        );
        expect(gutterLines(lastFrame() ?? '')).toEqual(['one.', 'two.']);

        rerender(<LiveTurn turn={turn({ reasoning: 'one.\ntwo.\nthree.', text: '' })} streaming />);
        expect(gutterLines(lastFrame() ?? '')).toEqual(['two.', 'three.']);
        unmount();
      });

      it('does not spend a preview line on a trailing newline', () => {
        const { lastFrame, unmount } = render(
          <LiveTurn turn={turn({ reasoning: 'one.\ntwo.\n', text: '' })} streaming />
        );
        expect(gutterLines(lastFrame() ?? '')).toEqual(['one.', 'two.']);
        unmount();
      });

      it('Ctrl+T still expands the streaming panel to the WHOLE thought', () => {
        const { lastFrame, unmount } = render(
          <LiveTurn turn={streamingTurn} streaming toolsExpanded />
        );
        expect(gutterLines(lastFrame() ?? '')).toEqual(thoughts);
        unmount();
      });

      it('is live-only: a committed turn collapses to its header alone', () => {
        // The transcript keeps what it always kept, which is also what makes the row estimator's
        // committed-panel count of one still exact.
        const { lastFrame, unmount } = render(<LiveTurn turn={streamingTurn} />);
        expect(gutterLines(lastFrame() ?? '')).toEqual([]);
        expect(stripAnsi(lastFrame() ?? '')).toContain('💭 Thinking');
        unmount();
      });

      /**
       * The cap is in SCREEN ROWS, and the cases above cannot tell the difference.
       *
       * A logical line is not a row. Reasoning streams as prose paragraphs and the newline arrives
       * at the end of one, so the ordinary shape of a first thinking turn is one or two paragraphs
       * with no newline in them yet — which wrapped to nine and seventeen rows at 80 columns, more
       * of the screen than the ten-line tool preview this cap exists to be smaller than. Measure
       * the drawn rows, at the width, or the number two means nothing.
       */
      describe('the cap is measured in drawn rows, not logical lines', () => {
        const paragraph = (n: number) => 'x'.repeat(n);
        /** Rows the collapsed streaming panel really draws, measured with Ink's own renderer. */
        const drawnRows = (reasoning: string, columns: number): number =>
          renderToString(
            <Box flexDirection="column">
              <ReasoningPanel reasoning={reasoning} expanded={false} live />
            </Box>,
            { columns }
          ).split('\n').length;

        it('draws the header plus one row per previewed line at 80 columns', () => {
          // The measurement that motivated the cap: unwrapped, these were 9 and 17 rows.
          expect(drawnRows('alpha\nbeta', 80)).toBe(3);
          expect(drawnRows(paragraph(600), 80)).toBe(2);
          expect(drawnRows(`${paragraph(600)}\n${paragraph(600)}`, 80)).toBe(3);
        });

        for (const columns of [80, 40, 24]) {
          it(`is the same height whatever the model emits, at ${columns} columns`, () => {
            // Stated against a two-short-line baseline rather than an absolute number, because the
            // header itself wraps on a narrow terminal and that is not the preview's doing. What
            // the cap promises is that the panel's height does not depend on the thought's length.
            const baseline = drawnRows('alpha\nbeta', columns);
            expect(drawnRows(`${paragraph(600)}\n${paragraph(600)}`, columns)).toBe(baseline);
            expect(drawnRows(`${paragraph(4000)}\n${paragraph(4000)}`, columns)).toBe(baseline);
          });
        }

        it('keeps the NEWEST text of an over-long line, not its opening', () => {
          // Truncating at the end would freeze the preview on the first row of a paragraph and
          // leave it there for as long as the model kept writing — the "frozen opening" the panel
          // is documented not to be.
          const frame = renderToString(
            <Box flexDirection="column">
              <ReasoningPanel reasoning={`${'a'.repeat(200)}NEWEST`} expanded={false} live />
            </Box>,
            { columns: 80 }
          );
          expect(stripAnsi(frame)).toContain('NEWEST');
        });

        it('leaves the EXPANDED thought wrapping in full', () => {
          // Expanded is where the whole thought is read; the cap belongs to the collapsed preview
          // alone, so a long line still wraps onto as many rows as it needs.
          expect(
            renderToString(
              <Box flexDirection="column">
                <ReasoningPanel reasoning={paragraph(600)} expanded live />
              </Box>,
              { columns: 80 }
            ).split('\n').length
          ).toBeGreaterThan(3);
        });
      });
    });

    it('renders nothing for the reasoning region when there is no reasoning', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={turn({ text: 'hi' })} />);
      expect(stripAnsi(lastFrame() ?? '')).not.toContain('💭 Thinking');
      unmount();
    });

    it('reasoning region uses colour, not dim alone, for the label + gutter (DL-8)', () => {
      // The label/gutter must be a coloured layer boundary, not the dim-only region that
      // disappears on many themes. Assert the raw frame carries the cyan SGR for the label.
      const { lastFrame, unmount } = render(<LiveTurn turn={withReasoning} toolsExpanded />);
      const raw = lastFrame() ?? '';
      // chalk.level=3 → cyan foreground is SGR 36; the label text is styled with it.
      expect(raw).toContain('[36m');
      unmount();
    });
  });

  // TUI-C18 — the `/reasoning` reprint renders the exported ReasoningPanel directly (expanded,
  // non-live) with a turn-tagged label. Asserted on the panel itself so the styling contract is
  // pinned where it is defined; the viewport that mounts it has its own spec.
  describe('reprinted reasoning block (ReasoningPanel export, TUI-C18)', () => {
    it('carries the recalled thinking text with the TUI-C15 💭 + gutter styling', () => {
      const { lastFrame, unmount } = render(
        <ReasoningPanel
          reasoning={'First I weigh it.\nThen I choose.'}
          expanded
          live={false}
          label={'Thinking · turn 2 (recalled)'}
        />
      );
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('💭 Thinking · turn 2 (recalled)'); // turn-tagged header
      expect(f).toContain('▾'); // expanded caret
      expect(f).toContain('│'); // TUI-C15 gutter
      expect(f).toContain('First I weigh it.'); // the reprinted thinking, line 1
      expect(f).toContain('Then I choose.'); // line 2
      expect(f).not.toContain('Ctrl+T to expand'); // non-live: no live-only hint
      unmount();
    });

    it('label + gutter use colour, not dim alone (DL-8): the frame carries the cyan SGR', () => {
      const { lastFrame, unmount } = render(
        <ReasoningPanel reasoning={'thinking'} expanded live={false} label={'Thinking · turn 1'} />
      );
      // chalk.level=3 (beforeEach) → cyan foreground is SGR 36; proves the layer boundary is colour.
      expect(lastFrame() ?? '').toContain('[36m');
      unmount();
    });
  });

  describe('markdown vs plain text', () => {
    it('renders completed assistant text as markdown (streaming=false)', () => {
      const t = turn({ text: '# Title\n- item one' });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('Title');
      expect(f).toContain('• item one'); // bullet => markdown was applied
      unmount();
    });

    it('renders streaming text as plain (no markdown reflow mid-stream)', () => {
      const t = turn({ text: '# Title\n- item one' });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} streaming />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('# Title'); // raw markdown preserved
      expect(f).toContain('- item one');
      expect(f).not.toContain('• item one'); // not yet formatted
      unmount();
    });

    it('plain prose is unchanged whether streaming or not', () => {
      const t = turn({ text: 'just a normal answer' });
      const a = render(<LiveTurn turn={t} streaming />);
      const b = render(<LiveTurn turn={t} />);
      expect(stripAnsi(a.lastFrame() ?? '')).toContain('just a normal answer');
      expect(stripAnsi(b.lastFrame() ?? '')).toContain('just a normal answer');
      a.unmount();
      b.unmount();
    });
  });

  describe('TUI-C90 — a blank row between blocks of sense', () => {
    const probeTool: ToolCallViewModel = {
      id: 't1',
      name: 'read_file',
      argsText: '{"path":"README.md"}',
      status: 'done',
      result: '',
    };

    it('separates every adjacent pair of blocks, and neither end of the turn', () => {
      const t = turn({
        reasoning: 'a private thought',
        toolCalls: [probeTool],
        text: 'the answer',
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={t} />);
      const rows = stripAnsi(lastFrame() ?? '').split('\n');

      // Three blocks, so five rows: thought, blank, tool, blank, answer. The ends are the point —
      // a leading row would push the turn off the separator above it, and a trailing one would
      // float the conversation away from the dock.
      expect(rows).toHaveLength(5);
      expect(rows[0]).toContain('Thinking');
      expect(rows[2]).toContain('read_file');
      expect(rows[4]).toContain('the answer');
      // Exactly empty, not merely blank: a row held open with a space would satisfy `trim()` and
      // leave trailing whitespace on every separator in the session.
      expect(rows[1]).toBe('');
      expect(rows[3]).toBe('');

      unmount();
    });

    it('draws a REAL row, not an empty <Text> that Yoga collapses', () => {
      // The trap TUI-C36 hit on the launch banner, and the reason `BlankRow` is a sized <Box>: an
      // empty <Text> among siblings measures zero-high and the separation silently vanishes. A
      // one-block turn and a two-block turn differing by exactly two rows is what proves the row
      // is really painted rather than merely mounted.
      const one = render(<LiveTurn turn={turn({ text: 'the answer' })} />);
      const two = render(<LiveTurn turn={turn({ toolCalls: [probeTool], text: 'the answer' })} />);
      const rowsOf = (frame: string | undefined) => stripAnsi(frame ?? '').split('\n').length;

      expect(rowsOf(two.lastFrame())).toBe(rowsOf(one.lastFrame()) + 2);

      one.unmount();
      two.unmount();
    });

    it('adds nothing to a single-block turn', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={turn({ text: 'the answer' })} />);
      expect(stripAnsi(lastFrame() ?? '').split('\n')).toHaveLength(1);
      unmount();
    });

    it('separates the blocks of a STREAMING turn too, so nothing shifts when it commits', () => {
      const t = turn({ toolCalls: [probeTool], text: 'the answer' });
      const live = render(<LiveTurn turn={t} streaming />);
      const rows = stripAnsi(live.lastFrame() ?? '').split('\n');
      expect(rows[1]).toBe('');
      live.unmount();
    });
  });
});
