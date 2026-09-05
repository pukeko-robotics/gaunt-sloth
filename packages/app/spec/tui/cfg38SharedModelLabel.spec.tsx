import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

/**
 * [[CFG-38]] — **the `model (provider)` spelling is ONE helper, not four templates that agree.**
 *
 * ## Why this file exists at all
 *
 * REL-12 recorded the limitation this spec answers: *"reuses the one shared spelling" is not
 * enforceable by the current tests and cannot be* — they assert a rendered string, so a hand-rolled
 * `${model} (${provider})` at each site passes them identically. Only the import makes the sharing
 * true, and only a test that CHANGES the helper can see whether every surface is actually reading
 * it. So this file stubs `modelProviderLabel` with a sentinel no template could produce by accident
 * and asserts the sentinel reaches every surface CFG-38 touches.
 *
 * That is the difference between a convention and a mechanism. DL-6's failure mode is one surface
 * drifting to `google-genai:gemini` while its neighbour says `gemini (google-genai)`; a per-site
 * string assertion is blind to the drift right up until someone notices it on screen.
 *
 * ## Why the mock is hoisted for the whole file
 *
 * `vi.mock` is file-scoped and hoisted, and a stubbed helper makes every ordinary rendering
 * assertion meaningless — so the real strings are asserted in `cfg38ProviderBesideModel.spec.tsx`
 * and this file asserts only the wiring. The two are a pair: this one would pass if every surface
 * rendered the sentinel and nothing else; that one would pass if every surface re-implemented the
 * spelling locally.
 *
 * ## What is swept elsewhere, and what is swept by nothing
 *
 * The five cells below are the surfaces reachable from this package. The sixth this node touched —
 * the `debug` rung's `Model:` line — is not: it only exists once an agent has initialised, and the
 * harness for that lives in `packages/core/spec/GthLangChainAgent.spec.ts`. So it is swept there,
 * with the same sentinel, by a stub toggled on for that one cell (a file-wide stub would blind the
 * captured preamble literals in that file). The two files together are the sweep; neither is it
 * alone.
 *
 * Two renderers of the helper this node did not touch remain outside both: the `compact` run header
 * (`GthAbstractAgent.ts`) and the review document's attribution line (`reviewHeading.ts`). Sweeping
 * them belongs with a node that changes them — noted here so the boundary is stated rather than
 * inferred from a list that reads as if it were complete.
 */
const SENTINEL = 'SHARED-HELPER-SENTINEL';

vi.mock('@gaunt-sloth/core/core/modelLabel.js', () => ({
  modelProviderLabel: (model?: string, provider?: string) =>
    model || provider ? `${SENTINEL}:${model ?? ''}/${provider ?? ''}` : undefined,
}));

const CTX = {
  mode: 'chat',
  modelDisplayName: 'some-model',
  modelProviderType: 'some-provider',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
} as const;

/** What the stub renders for the context above — the string no local template would produce. */
const EXPECTED = `${SENTINEL}:some-model/some-provider`;

async function dispatch(name: string, extra: Record<string, unknown> = {}) {
  const { createCommandRegistry, dispatchSlashCommand, parseSlashCommand } =
    await import('@gaunt-sloth/agent/modules/slashCommands.js');
  const parsed = parseSlashCommand(`/${name}`);
  expect(parsed).not.toBeNull();
  return dispatchSlashCommand(parsed!, createCommandRegistry(), {
    ...CTX,
    ...extra,
  } as Parameters<typeof dispatchSlashCommand>[2]);
}

describe('CFG-38 — every surface moves when the shared helper changes', () => {
  it('/status renders through the shared helper', async () => {
    const result = await dispatch('status');
    expect(result.notice?.lines.join('\n')).toContain(`Model: ${EXPECTED}`);
  });

  it('/model renders through the shared helper', async () => {
    const result = await dispatch('model');
    expect(result.notice?.title).toBe(`Model: ${EXPECTED}`);
  });

  it('/config renders through the shared helper', async () => {
    const { formatConfigSummary } = await import('@gaunt-sloth/agent/modules/slashCommands.js');
    const summary = formatConfigSummary({
      modelDisplayName: 'some-model',
      modelProviderType: 'some-provider',
    });
    expect(summary).toContain(`Model: ${EXPECTED}`);

    // …and survives into the notice the surfaces actually render.
    const result = await dispatch('config', { configSummary: summary });
    expect(result.notice?.lines).toContain(`Model: ${EXPECTED}`);
  });

  it('the TUI status bar renders through the shared helper', async () => {
    const { StatusBar, statusBarSegments } = await import('#src/tui/components/StatusBar.js');
    expect(
      statusBarSegments({
        mode: 'code',
        modelDisplayName: 'some-model',
        modelProviderType: 'some-provider',
        columns: 200,
      })
    ).toContain(`model: ${EXPECTED}`);

    const { lastFrame, unmount } = render(
      <StatusBar
        running={false}
        mode="code"
        modelDisplayName="some-model"
        modelProviderType="some-provider"
        turnCount={0}
        columns={200}
      />
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain(EXPECTED);
    unmount();
  });

  /**
   * The launch banner is the surface that ESTABLISHED the spelling (TUI-C33), and it reaches the
   * helper from inside `@gaunt-sloth/core` through core's own `#src/` specifier. Its presence here
   * is what makes this a sweep rather than a test of the agent package alone: the same stub is
   * seen through two different import specifiers, which is the module identity the sharing claim
   * actually rests on.
   */
  it('the launch banner renders through the same shared helper', async () => {
    const { launchBannerText } = await import('@gaunt-sloth/core/core/launchBanner.js');
    const text = launchBannerText({
      model: 'some-model',
      provider: 'some-provider',
      columns: 200,
      colour: false,
    });
    expect(text).toContain(EXPECTED);
  });
});
