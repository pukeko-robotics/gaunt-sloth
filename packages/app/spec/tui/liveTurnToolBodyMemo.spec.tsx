import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { ToolCallViewModel, TurnViewModel } from '#src/tui/viewModel.js';

/**
 * TUI-C46 — the tool-call panel builds its body in the render body, so without a memo the work is
 * redone on every FRAME instead of once per tool call. Building a preview width-slices every line
 * of a tool's output, and that output is unbounded, so the residual is paid at the repaint rate of
 * a streaming turn rather than at the rate tool results arrive.
 *
 * These cases count CALLS rather than reading the code: the two builders are wrapped in spies that
 * delegate to the real implementations, so what is asserted is how often the panel asked for the
 * lines — the only thing that distinguishes "computed once per tool call" from "computed per
 * frame". The mock lives in its own spec file because it would otherwise replace the real
 * formatters for every other case in `LiveTurn.spec.tsx`.
 */
const buildToolPreviewLinesMock = vi.fn();
const buildToolBodyLinesMock = vi.fn();

vi.mock('@gaunt-sloth/core/core/toolDisplay.js', async () => {
  const actual = await vi.importActual<typeof import('@gaunt-sloth/core/core/toolDisplay.js')>(
    '@gaunt-sloth/core/core/toolDisplay.js'
  );
  return {
    ...actual,
    buildToolPreviewLines: buildToolPreviewLinesMock,
    buildToolBodyLines: buildToolBodyLinesMock,
  };
});

const toolCall = (over: Partial<ToolCallViewModel> = {}): ToolCallViewModel => ({
  id: 't1',
  name: 'run_shell_command',
  argsText: '{"command":"ls"}',
  status: 'done',
  result: 'a result the panel previews',
  ...over,
});

const turnWith = (tc: ToolCallViewModel): TurnViewModel => ({
  isReasoning: false,
  segments: [{ kind: 'tool', tool: tc }],
});

describe('tui <LiveTurn> — tool body memoisation (TUI-C46)', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const actual = await vi.importActual<typeof import('@gaunt-sloth/core/core/toolDisplay.js')>(
      '@gaunt-sloth/core/core/toolDisplay.js'
    );
    buildToolPreviewLinesMock.mockImplementation(actual.buildToolPreviewLines);
    buildToolBodyLinesMock.mockImplementation(actual.buildToolBodyLines);
  });

  it('builds the preview ONCE across repaints that do not change what it shows', async () => {
    const { LiveTurn } = await import('#src/tui/components/LiveTurn.js');
    const tc = toolCall();

    const { rerender, unmount } = render(
      <LiveTurn turn={turnWith(tc)} streaming={true} columns={100} />
    );
    expect(buildToolPreviewLinesMock).toHaveBeenCalledTimes(1);

    // Repaint with the panel's own inputs untouched. `streaming` reaches the panel — it decides
    // the "(Ctrl+T to expand)" hint — so the component genuinely re-renders; the body does not
    // depend on it, so the lines must not be rebuilt. This is the per-frame cost, isolated.
    rerender(<LiveTurn turn={turnWith(tc)} streaming={false} columns={100} />);
    rerender(<LiveTurn turn={turnWith(tc)} streaming={true} columns={100} />);
    rerender(<LiveTurn turn={turnWith(tc)} streaming={false} columns={100} />);
    expect(buildToolPreviewLinesMock).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('rebuilds when the result changes, so the memo cannot show stale output', async () => {
    const { LiveTurn } = await import('#src/tui/components/LiveTurn.js');

    const { lastFrame, rerender, unmount } = render(
      <LiveTurn
        turn={turnWith(toolCall({ result: 'first result' }))}
        streaming={true}
        columns={100}
      />
    );
    expect(buildToolPreviewLinesMock).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('first result');

    // A streamed result growing is the case a memo keyed on too little would break: the panel
    // would keep drawing the first chunk forever. Counting the call is not enough on its own —
    // what is on screen has to move too.
    rerender(
      <LiveTurn
        turn={turnWith(toolCall({ result: 'second result' }))}
        streaming={true}
        columns={100}
      />
    );
    expect(buildToolPreviewLinesMock).toHaveBeenCalledTimes(2);
    expect(lastFrame()).toContain('second result');

    unmount();
  });

  it('rebuilds through the OTHER formatter when the panel is expanded', async () => {
    const { LiveTurn } = await import('#src/tui/components/LiveTurn.js');
    const tc = toolCall();

    const { rerender, unmount } = render(
      <LiveTurn turn={turnWith(tc)} toolsExpanded={false} streaming={true} columns={100} />
    );
    expect(buildToolPreviewLinesMock).toHaveBeenCalledTimes(1);
    expect(buildToolBodyLinesMock).not.toHaveBeenCalled();

    // Expanding selects a different formatter, so it is part of the key rather than a repaint.
    rerender(<LiveTurn turn={turnWith(tc)} toolsExpanded={true} streaming={true} columns={100} />);
    expect(buildToolBodyLinesMock).toHaveBeenCalledTimes(1);
    // …and expanded repaints are memoised in their turn.
    rerender(<LiveTurn turn={turnWith(tc)} toolsExpanded={true} streaming={false} columns={100} />);
    expect(buildToolBodyLinesMock).toHaveBeenCalledTimes(1);
    expect(buildToolPreviewLinesMock).toHaveBeenCalledTimes(1);

    unmount();
  });
});
