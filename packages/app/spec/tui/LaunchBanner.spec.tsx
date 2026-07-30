import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { LaunchBanner } from '#src/tui/components/LaunchBanner.js';

/**
 * TUI-C33 — the Ink half of the launch banner. The geometry itself is proved in
 * `packages/core/spec/launchBanner.spec.ts`; what matters here is that this component renders the
 * shared rows faithfully, follows the live terminal width across a resize (as <Rule> does), and
 * tidies its subscription up on unmount.
 */
describe('tui <LaunchBanner>', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the face beside the wordmark and the model/provider line', () => {
    const { lastFrame, unmount } = render(
      <LaunchBanner model="gemini-3.1-pro" provider="google-genai" />
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('▄█▀▀▀▀▀▀▀▀█▄');
    // The wordmark begins at the split column on each of its three rows.
    expect([...lines[0]].slice(21).join('')).toBe('┏┓         ┏┓┓   ┓');
    expect([...lines[2]].slice(21).join('')).toBe('┗┛┗┻┗┻┛┗┗  ┗┛┗┗┛┗┛┗');
    expect(lines[3]).toContain('gemini-3.1-pro (google-genai)');

    unmount();
  });

  it('omits the model line when neither a model nor a provider is known (fixture branch)', () => {
    const { lastFrame, unmount } = render(<LaunchBanner />);

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines[3].trim()).toBe('▀▄▀▀ ██████ ▀▀▄▀');
    // The directory still resolves, so row 5 keeps its field.
    expect(lines[4].length).toBeGreaterThan(21);

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
});
