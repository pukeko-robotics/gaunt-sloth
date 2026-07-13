import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
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
