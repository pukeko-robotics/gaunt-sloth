import React from 'react';
import { Text } from 'ink';
import Spinner from 'ink-spinner';

/**
 * CFG-21 — the transient "fetching models" indicator shown on the interactive TTY path while the
 * first-run dialog awaits a provider's live model list (a large cloud catalog can take a moment).
 *
 * Deliberately a bare spinner + label with NO `useInput`: without an input subscriber Ink never
 * enables raw mode, so the stdin `readable` listener that would intercept Ctrl+C is never attached
 * (see ink's App component). A Ctrl+C during the fetch therefore reaches Node as an ordinary SIGINT
 * — the process exits without writing a config, consistent with CFG-20's abort semantics (part d)
 * — rather than being swallowed by an Ink key handler.
 */
export function FetchProgress({ label }: { label: string }): React.ReactElement {
  return (
    <Text>
      <Spinner type="dots" /> {label}
    </Text>
  );
}

/**
 * The subset of Ink's `render` that {@link runWithInkProgress} relies on. Declared as a seam
 * (mirroring {@link import('./SelectList.js').InkRenderFn}) so a unit test can inject a fake
 * renderer and assert the indicator mounted / cleared without a live TTY — Ink's real render is
 * otherwise un-unit-testable (it needs a raw-mode-capable stdin).
 */
export type InkProgressRenderFn = (node: React.ReactElement) => {
  clear: () => void;
  unmount: () => void;
};

/**
 * Mount {@link FetchProgress} with Ink for the duration of `run`, then clear + unmount it however
 * `run` settles. Imports `ink` dynamically (unless a `render` is injected) so a readline-only run
 * never pulls Ink in. Intended for use only after the caller has confirmed an interactive TTY +
 * Ink availability.
 *
 * `clear()` before `unmount()` wipes the spinner line so it does not linger above the following
 * prompt — Ink otherwise leaves the last rendered frame on screen.
 *
 * @param render - injectable Ink renderer (defaults to Ink's `render`); for tests only.
 */
export async function runWithInkProgress<T>(
  label: string,
  run: () => Promise<T>,
  render?: InkProgressRenderFn
): Promise<T> {
  const renderFn: InkProgressRenderFn = render ?? (await import('ink')).render;
  const instance = renderFn(<FetchProgress label={label} />);
  try {
    return await run();
  } finally {
    instance.clear();
    instance.unmount();
  }
}
