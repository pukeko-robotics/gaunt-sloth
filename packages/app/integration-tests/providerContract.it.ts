import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { runSingleShot } from '@gaunt-sloth/core/runtime/singleShot.js';
import { runConversation } from '@gaunt-sloth/core/runtime/conversation.js';

/**
 * GS2-65 — single-leading-system provider contract smoke (the CI gap GS2-64 slipped through).
 *
 * GS2-64 was a double-`SystemMessage` bug that hard-crashed ALL Anthropic single-shot
 * (`runSingleShot`) AND multi-turn (`runConversation`) with "System messages are only permitted as
 * the first passed message" — yet it shipped undetected. The integration suite's CI runs against
 * `vertexai`, and Google silently MERGES duplicate system messages, hiding the fault. Anthropic and
 * OpenAI ENFORCE single-leading-system, so this file calls the two runtime functions the bug broke
 * DIRECTLY against a real provider.
 *
 * Why a direct call rather than a spawned CLI (as the other ITs do): the natural CLI multi-turn
 * command (`gth chat`) routes through `runner.processMessages`, NOT `runConversation` — so a
 * CLI-only test would miss the exact multi-turn function GS2-64 broke. Both functions are invoked
 * with NO resolvers / NO explicit agentFactory, i.e. the runner's LEAN default backend, which
 * composes the system prompt itself (the BATCH-13 fix path) — the precise code path that regressed.
 *
 * The signal is `ok === true` (the pre-fix bug was a hard provider rejection, so success == no
 * double-system rejection), not answer content — prompts are trivial (Haiku / cheapest model,
 * temperature 0) to keep token cost tiny and the smoke stable.
 *
 * `customConfigPath` pins each provider's own config, so the check targets Anthropic/OpenAI
 * regardless of which provider the surrounding `pnpm run it <provider>` invocation selected (this
 * file is glob-collected under every IT run). `describe.skipIf` on the key means a fork / CI leg
 * without the secret SKIPS cleanly — it never fails and never touches the network.
 */

const CONFIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configs');

async function loadProviderConfig(configFile: string): Promise<GthConfig> {
  return initConfig({ customConfigPath: path.join(CONFIG_DIR, configFile) });
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  'Provider contract: Anthropic (single-leading-system, GS2-64 regression guard)',
  () => {
    let config: GthConfig;

    beforeAll(async () => {
      config = await loadProviderConfig('anthropic.gsloth.config.json');
    });

    it('runSingleShot completes against Anthropic (no double-system rejection)', async () => {
      const result = await runSingleShot(
        'GS2-65-ANTHROPIC-SINGLE',
        '',
        'Reply with exactly one word: pong',
        config
      );

      expect(result.ok).toBe(true);
      expect(result.answer.trim().length).toBeGreaterThan(0);
    });

    it('runConversation completes across 2 turns against Anthropic', async () => {
      const turns = await runConversation(
        'GS2-65-ANTHROPIC-MULTI',
        '',
        ['Reply with exactly one word: one', 'Reply with exactly one word: two'],
        config
      );

      // A failed turn stops the conversation, so length < 2 means turn 1 crashed (the GS2-64
      // symptom). Both turns present AND ok == the multi-turn path survives on Anthropic.
      expect(turns.length).toBe(2);
      expect(turns.every((turn) => turn.ok)).toBe(true);
    });
  }
);

// OpenAI also enforces single-leading-system. Cheap (gpt-5-mini) and OPENAI_API_KEY is already in
// the integration-tests CI env, so this variant is live in CI with no new secret. Gated the same way.
describe.skipIf(!process.env.OPENAI_API_KEY)(
  'Provider contract: OpenAI (single-leading-system, GS2-64 regression guard)',
  () => {
    let config: GthConfig;

    beforeAll(async () => {
      config = await loadProviderConfig('openai.gsloth.config.json');
    });

    it('runSingleShot completes against OpenAI (no double-system rejection)', async () => {
      const result = await runSingleShot(
        'GS2-65-OPENAI-SINGLE',
        '',
        'Reply with exactly one word: pong',
        config
      );

      expect(result.ok).toBe(true);
      expect(result.answer.trim().length).toBeGreaterThan(0);
    });

    it('runConversation completes across 2 turns against OpenAI', async () => {
      const turns = await runConversation(
        'GS2-65-OPENAI-MULTI',
        '',
        ['Reply with exactly one word: one', 'Reply with exactly one word: two'],
        config
      );

      expect(turns.length).toBe(2);
      expect(turns.every((turn) => turn.ok)).toBe(true);
    });
  }
);
