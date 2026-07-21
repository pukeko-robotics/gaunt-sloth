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

    it('collapsed by default: shows a compact summary line, hides args/result', () => {
      const { lastFrame, unmount } = render(<LiveTurn turn={withTool} />);
      const f = stripAnsi(lastFrame() ?? '');
      expect(f).toContain('read_file'); // summary
      expect(f).toContain('done'); // status word
      expect(f).toContain('▸'); // collapsed caret
      expect(f).not.toContain('README.md'); // args hidden
      expect(f).not.toContain('file contents here'); // result hidden
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

    it('shows the live streamed output (TUI-C17) when expanded, hides it collapsed', () => {
      const withOutput = turn({
        toolCalls: [
          {
            id: 't1',
            name: 'run_shell_command',
            argsText: '{"command":"ls -la"}',
            status: 'running',
            output: '🔧 Executing run_shell_command: ls -la\ntotal 12\ndrwxr-xr-x  2 me\n',
          },
        ],
      });
      const collapsed = render(<LiveTurn turn={withOutput} />);
      const fc = stripAnsi(collapsed.lastFrame() ?? '');
      expect(fc).toContain('run_shell_command'); // summary line
      expect(fc).not.toContain('total 12'); // output body hidden while collapsed
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
