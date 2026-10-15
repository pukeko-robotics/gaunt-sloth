import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { LaunchBanner } from '#src/tui/components/LaunchBanner.js';

/**
 * TUI-C33 — the Ink half of the launch banner. The geometry itself is proved in
 * `packages/core/spec/launchBanner.spec.ts`; what matters here is that this component renders the
 * shared rows faithfully, follows the live terminal width across a resize (as <Rule> does), and
 * tidies its subscription up on unmount. TUI-C36 added the padding, whose one Ink-specific risk —
 * an empty row measuring zero-high and vanishing — is asserted here rather than in core.
 */

/** Column at which the right-hand column starts, after TUI-C36's left margin. */
const RIGHT = 22;
/** Index of the first art row: row 0 is the blank padding row. */
const ART = 1;

describe('tui <LaunchBanner>', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the face beside the wordmark and the model/provider line', () => {
    const { lastFrame, unmount } = render(
      <LaunchBanner model="gemini-3.1-pro" provider="google-genai" />
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[ART]).toContain('▄█▀▀▀▀▀▀▀▀█▄');
    // The wordmark begins at the split column on each of its three rows.
    expect([...lines[ART]].slice(RIGHT).join('')).toBe('┏┓         ┏┓┓   ┓');
    expect([...lines[ART + 2]].slice(RIGHT).join('')).toBe('┗┛┗┻┗┻┛┗┗  ┗┛┗┗┛┗┛┗');
    expect(lines[ART + 3]).toContain('gemini-3.1-pro (google-genai)');

    unmount();
  });

  it('paints the TUI-C36 padding: a blank line above and below, and the left margin', () => {
    const { lastFrame, unmount } = render(
      <LaunchBanner model="gemini-3.1-pro" provider="google-genai" />
    );

    const lines = (lastFrame() ?? '').split('\n');
    // A blank row is an empty line in the frame, not a line of spaces — Ink drops a zero-high
    // <Text>, so this is what proves the padding rows actually paint.
    expect(lines[0]).toBe('');
    expect(lines[6]).toBe('');
    // Every art row opens with the one-column margin.
    for (const line of lines.slice(ART, ART + 5)) {
      expect(line.startsWith(' ')).toBe(true);
    }

    unmount();
  });

  it('omits the model line when neither a model nor a provider is known (fixture branch)', () => {
    const { lastFrame, unmount } = render(<LaunchBanner />);

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines[ART + 3].trim()).toBe('▀▄▀▀ ██████ ▀▀▄▀');
    // The directory still resolves, so the last art row keeps its field.
    expect(lines[ART + 4].length).toBeGreaterThan(RIGHT);

    unmount();
  });

  it('drops the right column on a narrow terminal', () => {
    const { lastFrame, unmount } = render(
      <LaunchBanner model="gemini-3.1-pro" provider="google-genai" columns={40} />
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('▀██████████▀');
    expect(frame).not.toContain('┗┛┗┻┗┻┛┗┗');
    expect(frame).not.toContain('gemini-3.1-pro');

    unmount();
  });

  it('follows the terminal width across a resize and unsubscribes on unmount', async () => {
    const { lastFrame, stdout, unmount } = render(<LaunchBanner model="gemini-3.1-pro" />);

    expect(stdout.listenerCount('resize')).toBe(1);
    expect(lastFrame()).toContain('gemini-3.1-pro');

    // Shrink below the 45-column threshold and fire the resize the way a terminal would: the
    // banner must re-render as the face alone rather than keep a stale, now-wrapping layout.
    Object.defineProperty(stdout, 'columns', { value: 30, configurable: true });
    stdout.emit('resize');
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('gemini-3.1-pro');
      expect(lastFrame()).toContain('▀██████████▀');
    });

    unmount();
    expect(stdout.listenerCount('resize')).toBe(0);
  });

  /**
   * TUI-C74 — the config-root row is the only row the five-line face does not reach, so Ink is the
   * only place its rendering can be proved: a row the component never emits, or one that measures
   * zero-high, looks exactly like a correct banner from core's side of the split.
   *
   * The divergence is genuine — the config root is an ANCESTOR of the working directory, as it is
   * whenever a session opens inside a configured project. With the two equal, every rendering of
   * this component passes and the assertion proves nothing.
   */
  describe('TUI-C74 — the config root gets its own row when it is not the working directory', () => {
    // Built through `resolve`/`join`, so the literals are the platform's own under win32.
    const PROJECT = resolve(`${sep}gth-tui-c74-tui`);
    const CWD = join(PROJECT, 'packages', 'app');
    let initCwd: string | undefined;

    beforeEach(() => {
      initCwd = process.env.INIT_CWD;
      process.env.INIT_CWD = CWD;
      setProjectDir(PROJECT); // what config discovery does on an up-tree match
    });

    afterEach(() => {
      setProjectDir(undefined);
      if (initCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = initCwd;
    });

    it('paints eight rows: the working directory, then the config root, then the padding', () => {
      const { lastFrame, unmount } = render(<LaunchBanner model="gemini-3.1-pro" columns={120} />);

      const lines = (lastFrame() ?? '').split('\n');
      expect(lines).toHaveLength(8);
      expect([...lines[ART + 4]].slice(RIGHT).join('')).toBe(`cwd: ${CWD}`);
      expect([...lines[ART + 5]].slice(RIGHT).join('')).toBe(`config: ${PROJECT}`);
      // The closing padding row still closes the block, so the extra row is inside it.
      expect(lines[7]).toBe('');

      unmount();
    });

    it('paints seven rows with one bare path when the config sits AT the working directory', () => {
      setProjectDir(CWD);
      const { lastFrame, unmount } = render(<LaunchBanner model="gemini-3.1-pro" columns={120} />);

      const frame = lastFrame() ?? '';
      expect(frame.split('\n')).toHaveLength(7);
      expect([...frame.split('\n')[ART + 4]].slice(RIGHT).join('')).toBe(CWD);
      expect(frame).not.toContain('config:');

      unmount();
    });
  });
});
