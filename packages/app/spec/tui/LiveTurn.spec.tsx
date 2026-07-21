import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { LiveTurn, ReasoningPanel } from '#src/tui/components/LiveTurn.js';
import type { TurnViewModel } from '#src/tui/viewModel.js';

const turn = (over: Partial<TurnViewModel> = {}): TurnViewModel => ({
  text: '',
  reasoning: '',
  isReasoning: false,
  toolCalls: [],
  ...over,
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
          { id: 't1', name: 'read_file', argsText: '{"path":"big.txt"}', status: 'done', result: longResult },
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

    it('renders a dedicated checkbox panel with a done/total header, expanded', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withChecklist} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('📋 Checklist (1/3)');
      expect(f).toContain('[x] Set up config');
      expect(f).toContain('[~] Implement tool');
      expect(f).toContain('[ ] Write tests');
      // Not the generic tool-call summary line.
      expect(f).not.toContain('running');
      unmount();
    });

    it('falls back to the generic tool panel while the args are still partial', () => {
      const partial = turn({
        toolCalls: [
          { id: 'c1', name: 'gth_checklist', argsText: '{"items":[{"cont', status: 'running' },
        ],
      });
      const { lastFrame, unmount } = render(<LiveTurn turn={partial} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('gth_checklist'); // generic summary line
      expect(f).not.toContain('📋 Checklist');
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
  // non-live) with a turn-tagged label. Asserting the panel itself (not through <Transcript>/<Static>)
  // because ink-testing-library's lastFrame() returns the last DYNAMIC frame — <Static> content is
  // written once above it and would be absent here.
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
});
