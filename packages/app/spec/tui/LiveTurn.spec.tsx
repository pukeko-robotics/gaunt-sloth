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
