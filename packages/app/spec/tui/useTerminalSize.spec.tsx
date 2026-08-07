import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import {
  FALLBACK_TERMINAL_ROWS,
  TerminalSizeProvider,
  useTerminalSize,
} from '#src/tui/useTerminalSize.js';

/**
 * TUI-C48 — the published terminal size, and the one property of it that no rendered output can
 * show you.
 *
 * A context consumer re-renders when the value's REFERENCE changes, whatever the numbers say. The
 * transcript's rules are consumers living inside `React.memo`'d rows whose entire job is to stay
 * out of an unrelated frame, so an identity that churns costs every rule on screen a render per
 * frame — invisibly, since the screen is identical either way. That is why this is asserted by
 * counting renders rather than by reading a frame: the defect has no appearance.
 */
describe('tui <TerminalSizeProvider>', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** A memoised consumer, exactly the shape `<Rule>` has inside a memoised transcript row. */
  function makeConsumer() {
    const renders: string[] = [];
    const Consumer = React.memo(function Consumer(): React.ReactElement {
      const { rows, columns } = useTerminalSize();
      renders.push(`${columns}x${rows}`);
      return <Text>{`${columns}x${rows}`}</Text>;
    });
    return { Consumer, renders };
  }

  it('does not re-render consumers when the caller rebuilds an equal size object', async () => {
    const { Consumer, renders } = makeConsumer();
    let bump: () => void = () => {};

    function Host(): React.ReactElement {
      const [, setTick] = React.useState(0);
      bump = () => setTick((t) => t + 1);
      // A fresh object every render, with the same numbers — the natural way to write a call site,
      // and the thing that must not reach the consumers.
      return (
        <TerminalSizeProvider size={{ rows: 40, columns: 120 }}>
          <Consumer />
        </TerminalSizeProvider>
      );
    }

    const { unmount } = render(<Host />);
    expect(renders).toEqual(['120x40']);

    // Five re-renders of the publisher, none of them a resize.
    for (let i = 0; i < 5; i += 1) {
      bump();
      await vi.waitFor(() => expect(renders.length).toBeGreaterThan(0));
    }

    // The literal count, not a ceiling: a ceiling of "under ten" is satisfied by a regression that
    // adds one render per frame, which is exactly the shape this guards against.
    expect(renders).toEqual(['120x40']);

    unmount();
  });

  it('DOES re-render consumers when the size actually changes', async () => {
    const { Consumer, renders } = makeConsumer();
    let resize: (columns: number) => void = () => {};

    function Host(): React.ReactElement {
      const [columns, setColumns] = React.useState(120);
      resize = setColumns;
      return (
        <TerminalSizeProvider size={{ rows: 40, columns }}>
          <Consumer />
        </TerminalSizeProvider>
      );
    }

    const { unmount } = render(<Host />);
    expect(renders).toEqual(['120x40']);

    // The control for the case above: memoising the published value must not freeze it. Without
    // this, "consumers never re-render" would be satisfied by a provider that never publishes.
    resize(60);
    await vi.waitFor(() => expect(renders).toEqual(['120x40', '60x40']));

    unmount();
  });

  it('falls back to its own measurement with no provider above it', () => {
    const { Consumer, renders } = makeConsumer();
    const { stdout, unmount } = render(<Consumer />);

    // Standalone, the consumer measures for itself: the width comes from the stream, and the
    // height from the fallback because this stdout reports no rows. Both halves matter — a
    // component rendered without the frame around it must never be silently frozen or blank.
    expect(renders).toEqual([`${stdout.columns}x${FALLBACK_TERMINAL_ROWS}`]);

    unmount();
  });
});
