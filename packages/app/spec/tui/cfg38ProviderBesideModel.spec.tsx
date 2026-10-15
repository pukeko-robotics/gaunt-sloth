import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  formatConfigSummary,
  parseSlashCommand,
  type SlashCommandContext,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import { StatusBar, statusBarSegments } from '#src/tui/components/StatusBar.js';
import { App } from '#src/tui/components/App.js';
import type { TuiAgent } from '#src/tui/types.js';

/**
 * [[CFG-38]] — **the provider is shown wherever the model is shown.**
 *
 * A model id on its own is ambiguous, and the ambiguity is not academic: `claude-sonnet-4-5` is
 * served by `anthropic` and by `openrouter`, a `gpt-*` by `openai` and by `azure`, and anything at
 * all by a local `ollama`. Which one is in play changes cost, rate limits, tool-call behaviour and
 * where the traffic goes, so every surface that names the model names the provider beside it.
 *
 * ## The one spelling
 *
 * Every site renders `modelProviderLabel`'s `model (provider)` — the same helper the launch banner
 * (TUI-C33), the compact run header (GS2-95) and the review attribution line (REL-12) already use.
 * That the sharing is real rather than four templates that happen to agree is asserted by
 * `cfg38SharedModelLabel.spec.tsx`, which changes the helper and watches every surface move; a
 * rendered-string assertion like the ones below cannot make that claim, because a hand-rolled
 * re-implementation producing the same string passes it identically.
 *
 * ## Why every claim comes in a pair
 *
 * An absent provider is a REAL, non-error state, not a defensive branch: a module config
 * (`.gsloth.config.js` returning an already-built `BaseChatModel`) hands the loader no provider
 * string at all, so `modelProviderType` is legitimately undefined for every one of them — and the
 * PTY fixtures under `packages/app/tui-e2e/fixtures/` are exactly such configs. So each surface is
 * asserted twice: with a provider (the parenthesised form appears) and without (the BARE model
 * appears, with no `unknown`, no `undefined` and no empty parentheses). Asserting only the first
 * would stay green if the provider became the only path; asserting only the second would stay
 * green if the feature were never wired at all.
 *
 * ## Why the TUI surface is driven through `<App>` rather than the registry alone
 *
 * The registry is ONE source shared with the readline session (GS2-8), so a test that builds a
 * `SlashCommandContext` by hand and dispatches through it proves nothing about either surface's
 * own dispatch call site — and the call site is precisely where a surface silently diverges, since
 * a field it forgets to thread arrives as `undefined` and renders as the bare model, which looks
 * correct. So `/status` and `/model` are driven through a real `<App>` here and through the real
 * readline loop in `packages/agent/spec/interactiveSessionModule.slash.spec.ts`. TUI-C48 classes
 * that divergence as a regression in its own right, not a cosmetic miss.
 */

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/** An agent that must never run: every command below answers without reaching the model. */
const inertAgent = (): TuiAgent => ({
  async *runTurn() {
    yield { type: 'text', delta: 'should not run' };
  },
});

/** Type a slash command into a live `<App>` and return everything it rendered, ANSI stripped. */
async function runCommand(
  command: string,
  props: { modelDisplayName?: string; modelProviderType?: string }
): Promise<string> {
  const { stdin, frames, lastFrame, unmount } = render(
    <App {...baseProps} agent={inertAgent()} {...props} />
  );
  await vi.waitFor(() => expect(lastFrame()).toContain('>'));
  stdin.write(command);
  await vi.waitFor(() => expect(lastFrame()).toContain(command));
  stdin.write('\r');
  await vi.waitFor(() => expect(stripAnsi(frames.join('\n'))).toContain('Model:'));
  const all = stripAnsi(frames.join('\n'));
  unmount();
  return all;
}

describe('CFG-38 — /status and /model on the Ink TUI surface', () => {
  it.each(['/status', '/model'])(
    '%s names the provider beside the model when one resolves',
    async (command) => {
      const out = await runCommand(command, {
        modelDisplayName: 'claude-sonnet-4-5',
        modelProviderType: 'openrouter',
      });
      expect(out).toContain('Model: claude-sonnet-4-5 (openrouter)');
      // …and the status bar in the same frames, which is the OTHER thing this live `<App>` can
      // prove: that `App` hands the field down to `StatusBar` at all. The component's own logic is
      // asserted below through `statusBarSegments`, but a component that renders correctly from a
      // prop nobody passes it renders the bare model on screen and looks right — the same silent
      // divergence TUI-C48 classes as a regression. Lowercase `model:` is the bar's own label, so
      // this cannot be satisfied by the `Model:` notice above.
      expect(out).toContain('model: claude-sonnet-4-5 (openrouter)');
    }
  );

  it.each(['/status', '/model'])(
    '%s renders the bare model, with no placeholder, when no provider resolves',
    async (command) => {
      const out = await runCommand(command, { modelDisplayName: 'claude-sonnet-4-5' });
      expect(out).toContain('Model: claude-sonnet-4-5');
      // The three ways this could go wrong, named rather than implied.
      expect(out).not.toContain('claude-sonnet-4-5 (');
      expect(out).not.toContain('(undefined)');
      expect(out).not.toContain('(unknown)');
    }
  );
});

/**
 * `/config` renders a summary the SESSION MODULE pre-builds, so the field that has to be threaded
 * is on `ConfigSummaryInput` rather than on the dispatch context. Both surfaces call
 * `formatConfigSummary(config, mode)` with the whole resolved config, so widening the structural
 * type is the whole wiring — which is why the function itself is the honest place to assert it.
 */
describe('CFG-38 — /config', () => {
  it('names the provider beside the model when one resolves', () => {
    const lines = formatConfigSummary({
      modelDisplayName: 'gemini-3.1-pro',
      modelProviderType: 'google-genai',
    });
    expect(lines).toContain('Model: gemini-3.1-pro (google-genai)');
  });

  it('renders the bare model, with no placeholder, when no provider resolves', () => {
    const lines = formatConfigSummary({ modelDisplayName: 'gemini-3.1-pro' });
    expect(lines).toContain('Model: gemini-3.1-pro');
    expect(lines.join('\n')).not.toContain('gemini-3.1-pro (');
  });

  /**
   * The pre-existing `unknown` stands in only when NEITHER half resolves. CFG-38 forbids a
   * placeholder for a missing PROVIDER; it does not change what a config with no model at all
   * reports, and this pins that distinction so a later sweep does not read the two as one rule.
   */
  it('still reports `unknown` when neither the model nor the provider resolves', () => {
    expect(formatConfigSummary({})).toContain('Model: unknown');
  });

  /**
   * The THIRD cell of the pair, and the one that is easy to miss: a provider with NO model.
   *
   * It is reachable — `llm.model` is `z.string().optional()` in the config schema, so a JSON
   * config naming only `llm.type` resolves a provider and no model — and the naive shape
   * (`modelProviderLabel(model, provider) || 'unknown'`) renders `Model: anthropic` there: a
   * provider name sitting exactly where a model name sits, which any reader takes for the model.
   *
   * The pre-existing `unknown` is what these labelled lines have always reported for a missing
   * model, so keeping it is what makes CFG-38 purely additive. It is emphatically NOT a ruling on
   * whether the launch banner (a lone provider survives) and the review heading (the label is
   * dropped whole) should converge — that question is open, both writers are untouched, and this
   * cell exists so that a later sweep cannot flatten one into the other by accident here.
   */
  it.each([
    ['/config', () => formatConfigSummary({ modelProviderType: 'anthropic' }).join('\n')],
    [
      '/status',
      () => {
        const parsed = parseSlashCommand('/status');
        return JSON.stringify(
          dispatchSlashCommand(parsed!, createCommandRegistry(), {
            mode: 'chat',
            modelDisplayName: '',
            modelProviderType: 'anthropic',
            turnCount: 0,
            toolsExpanded: false,
            debugVisible: false,
          })
        );
      },
    ],
    [
      '/model',
      () => {
        const parsed = parseSlashCommand('/model');
        return JSON.stringify(
          dispatchSlashCommand(parsed!, createCommandRegistry(), {
            mode: 'chat',
            modelDisplayName: '',
            modelProviderType: 'anthropic',
            turnCount: 0,
            toolsExpanded: false,
            debugVisible: false,
          })
        );
      },
    ],
  ])('%s never puts a bare provider name under the Model label', (_name, render) => {
    const out = render();
    expect(out).toContain('Model: unknown');
    expect(out).not.toContain('Model: anthropic');
  });

  /**
   * The notice the surfaces actually render is built from those lines, so the provider survives
   * the wrapping rather than being dropped by the notice builder.
   */
  it('reaches the rendered /config notice', () => {
    const summary = formatConfigSummary({
      modelDisplayName: 'gemini-3.1-pro',
      modelProviderType: 'google-genai',
    });
    const ctx: SlashCommandContext = {
      mode: 'chat',
      modelDisplayName: 'gemini-3.1-pro',
      modelProviderType: 'google-genai',
      turnCount: 0,
      toolsExpanded: false,
      debugVisible: false,
      configSummary: summary,
    };
    const parsed = parseSlashCommand('/config');
    expect(parsed).not.toBeNull();
    const result = dispatchSlashCommand(parsed!, createCommandRegistry(), ctx);
    expect(result.notice?.lines).toContain('Model: gemini-3.1-pro (google-genai)');
  });
});

/**
 * The status bar is the one site with a real cost — a single line already carrying the mode, a turn
 * counter, an approvals badge and sometimes a debug hint. The node calls for that width decision to
 * be made deliberately rather than left to overflow, so it is asserted at a narrow width here.
 */
describe('CFG-38 — the TUI status bar', () => {
  const wide = 200;

  it('names the provider beside the model when the line fits', () => {
    expect(
      statusBarSegments({
        mode: 'code',
        modelDisplayName: 'claude-sonnet-4-5',
        modelProviderType: 'openrouter',
        turnCount: 2,
        columns: wide,
      })
    ).toBe('code  ·  model: claude-sonnet-4-5 (openrouter)  ·  turns: 2  ·  ready');
  });

  it('renders the bare model, with no placeholder, when no provider resolves', () => {
    const line = statusBarSegments({
      mode: 'code',
      modelDisplayName: 'claude-sonnet-4-5',
      turnCount: 2,
      columns: wide,
    });
    expect(line).toBe('code  ·  model: claude-sonnet-4-5  ·  turns: 2  ·  ready');
    expect(line).not.toContain('(');
  });

  /**
   * The width decision: below the budget the PROVIDER is dropped and the model is kept, and
   * neither is truncated. The pair is what makes the claim — the same inputs at a wide terminal
   * keep the provider, so this cannot pass by the provider never being rendered at all.
   */
  it('drops the provider — never the model — on a terminal too narrow for both', () => {
    const input = {
      mode: 'code',
      modelDisplayName: 'claude-sonnet-4-5',
      modelProviderType: 'openrouter',
      turnCount: 2,
    };
    expect(statusBarSegments({ ...input, columns: wide })).toContain('(openrouter)');

    const narrow = statusBarSegments({ ...input, columns: 40 });
    expect(narrow).toBe('code  ·  model: claude-sonnet-4-5  ·  turns: 2  ·  ready');
    expect(narrow).not.toContain('openrouter');
    // Dropped whole, never clipped: a truncated provider or model would be misleading rather than
    // merely terse, which is why the launch banner drops a version it cannot fit.
    expect(narrow).not.toContain('…');
    expect(narrow).toContain('claude-sonnet-4-5');
  });

  /**
   * The siblings on the same row are separate `<Text>` nodes so they can carry their own colour,
   * but the terminal wraps the row as a whole. A budget blind to them would keep the provider on a
   * line the badge then pushes over — so the reservation is asserted, not assumed.
   */
  it('counts the approvals badge and debug hint against the width budget', () => {
    const input = {
      mode: 'code',
      modelDisplayName: 'claude-sonnet-4-5',
      modelProviderType: 'openrouter',
      turnCount: 2,
      columns: 80,
    };
    expect(statusBarSegments(input)).toContain('(openrouter)');
    expect(statusBarSegments({ ...input, reservedColumns: 40 })).not.toContain('(openrouter)');
  });

  it('renders through the component, provider included', () => {
    const { lastFrame, unmount } = render(
      <StatusBar
        running={false}
        mode="code"
        modelDisplayName="claude-sonnet-4-5"
        modelProviderType="openrouter"
        turnCount={2}
        columns={wide}
      />
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('model: claude-sonnet-4-5 (openrouter)');
    unmount();
  });
});
