import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { isFailClosed, rateShellCommand } from '@gaunt-sloth/core/core/shell/rater.js';
import {
  askStructured,
  describeStructuredFailure,
} from '@gaunt-sloth/core/runtime/askStructured.js';
import {
  findApiKeyEnvVar,
  PROVIDER_DESCRIPTORS,
} from '@gaunt-sloth/core/providers/modelDiscovery.js';

/**
 * EXT-88 — structured output survives a real provider's `withStructuredOutput` conversion.
 *
 * ## What broke, and why no unit test could see it
 *
 * A `z.string().optional()` field is not sent to a model as "optional". Each provider's
 * zod-to-JSON-Schema conversion decides that, and two of them decide it in opposite, mutually
 * incompatible ways. The defect lives in that conversion plus the model's response shape, so it is
 * invisible to every test that stubs the model — which is every unit test we have.
 *
 * ## The coverage map — read this before treating a green matrix as coverage
 *
 * Many legs collect this file; exactly TWO of them can fail on a defect it guards. Measured against
 * unfixed trunk, on the real providers:
 *
 * - **groq (`openai/gpt-oss-120b`) — the null-rejection guard.** The ChatGroq path hoists optional
 *   properties into `required` and types them `["string","null"]`. The model complies and answers
 *   `null`; a bare `.optional()` then rejects its own request's answer, and `rateShellCommand`
 *   fail-closes on every benign command. This is the ONE leg of
 *   `.github/workflows/integration-tests-small.yml` that goes red without the fix.
 * - **openai (`gpt-5-mini`) — the 400 guard.** `@langchain/openai` does the opposite: it omits
 *   optional keys from `required`, violating OpenAI's own strict rule, and the API rejects the
 *   request outright (`'required' is required to be … including every key in properties. Missing
 *   'suggestedTool'`). openai is not in the small matrix — it is `BIG_TEST_PROVIDER` in
 *   `.github/workflows/integration-tests.yml`, which runs the suite UNFILTERED and therefore
 *   collects this file for free.
 * - **Every other run is smoke, not a regression guard.** xai, inception, openrouter, xai-build,
 *   google-genai-flash-lite, huggingface, anthropic and ollama were each measured against unfixed
 *   trunk: all left the optional out of `required`, the model omitted the key, and the old code
 *   passed. Their value is the other direction: the fix changes the emitted wire shape for EVERY
 *   provider, so they are what prove that change does not break the providers that already worked —
 *   and they catch any provider that later adopts groq's hoisting.
 *
 * Which of those actually run anywhere is a smaller list than which were measured. In the small
 * matrix: anthropic, xai, inception, openrouter, google-genai-flash-lite, huggingface — and the same
 * set minus openrouter runs non-gating at a release (`release.yml`'s `integration-tests-small`).
 * `.github/workflows/integration-tests-platforms.yml` adds macOS/Windows × openrouter, and the local
 * `pnpm run it ollama xx-small` pre-merge gate adds ollama. **xai-build is measured but is a leg in
 * no workflow** — its config exists and `pnpm run it xai-build xx-small` runs by hand.
 *
 * ## Why programmatic rather than a spawned CLI run
 *
 * Same reasoning as `providerContract.it.ts` (GS2-65): the failing code is a runtime function, not a
 * verb. `rateShellCommand` only runs behind an approvals rung with a gated command, and
 * `askStructured` has no CLI entry point at all — a CLI-driven test would either not reach them or
 * reach them so indirectly that a failure would not name them.
 *
 * ## Why it uses the AMBIENT provider
 *
 * Unlike `providerContract.it.ts`, which pins one vendor's config on purpose, this file reads
 * `workdir/.gsloth.config.json` — whatever `pnpm run it <provider> xx-small` copied there. One file,
 * every model in every matrix. `xx-small` in the filename is what makes the tiered runs collect it.
 *
 * ## Cost and skipping
 *
 * Two model calls, trivial prompts, `temperature: 0` where the config sets it. `describe.skipIf` on
 * a missing key means a fork or a CI leg without the secret stays green — and because a skip and a
 * pass are indistinguishable from the outside, the module prints one line at collection saying which
 * provider it resolved and whether it will run. The key is resolved the same way the provider layer
 * resolves it (the config's own `apiKeyEnvironmentVariable` first, then every spelling the provider
 * descriptor accepts), so a CI leg that sets `OPEN_ROUTER_API_KEY` where this machine has
 * `OPENROUTER_API_KEY` does not silently skip.
 */

const IT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR_CONFIG = path.join(IT_DIR, 'workdir', '.gsloth.config.json');

/**
 * Model calls here get a wider budget than the 30s default: this file runs on local ollama as well
 * as on hosted providers, and a small local model answering a nested schema is slow without being
 * broken. A timeout would surface as the same fail-closed verdict the ticket is about, so the
 * budget is raised to keep the signal specific.
 */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Say WHICH failure a red is, in the test output itself.
 *
 * The two things a red here can mean want opposite responses — a provider that never answered is
 * the provider's problem and is re-run, a provider that refused the request is ours and must be
 * investigated — and from the outside they look identical: one line, one budget, no verdict. Naming
 * the class is what stops a real rejection being shrugged off as flakiness, which is exactly how a
 * guard stops guarding without anyone deciding to remove it.
 *
 * The sentences and the classification that selects them both live in `@gaunt-sloth/core`, beside
 * `askStructured`'s own error texts, where the unit suite reaches them and pins each sentence to the
 * class it names. This file supplies only the budget its calls were made with — nothing here
 * re-types a sentence or re-decides a class, so it cannot drift into reporting one as another. The
 * budget is bound once here rather than at each call site because passing a different one to the
 * classifier reports a genuine timeout as a failed call.
 */
function describeFailure(error: string): string {
  return describeStructuredFailure(error, CALL_TIMEOUT_MS);
}

interface AmbientProvider {
  /** Provider `type` from the config's `llm` block, e.g. `xai` for the `xai-build` config. */
  type: string;
  model: string;
  /** Name only — never a value; an API key must not reach test output. */
  keyEnvVar?: string;
  runnable: boolean;
  why: string;
}

function resolveAmbientProvider(): AmbientProvider {
  if (!fs.existsSync(WORKDIR_CONFIG)) {
    return {
      type: '(none)',
      model: '(none)',
      runnable: false,
      why: `no ${WORKDIR_CONFIG} — run through \`pnpm run it <provider> xx-small\`, which copies one there`,
    };
  }

  let llm: Record<string, string> | undefined;
  try {
    llm = JSON.parse(fs.readFileSync(WORKDIR_CONFIG, 'utf8'))?.llm;
  } catch (error) {
    return {
      type: '(unreadable)',
      model: '(unreadable)',
      runnable: false,
      why: `could not parse ${WORKDIR_CONFIG}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!llm?.type) {
    return { type: '(none)', model: '(none)', runnable: false, why: 'config has no llm.type' };
  }

  const type = llm.type;
  const model = llm.model ?? '(provider default)';

  // Order matters: an explicit `apiKeyEnvironmentVariable` wins over the descriptor, exactly as
  // every provider factory's own getApiKey does. The `inception` config is `type: "openai"` with
  // `apiKeyEnvironmentVariable: "INCEPTION_API_KEY"` — resolving it by descriptor would consult
  // OPENAI_API_KEY and call the leg runnable on a machine that cannot reach Inception at all.
  const configured = llm.apiKeyEnvironmentVariable;
  if (configured) {
    const present = (process.env[configured] ?? '').trim().length > 0;
    return {
      type,
      model,
      keyEnvVar: present ? configured : undefined,
      runnable: present,
      why: present ? `${configured} is set` : `${configured} is not set`,
    };
  }

  const descriptor = PROVIDER_DESCRIPTORS.find((candidate) => candidate.id === type);
  if (!descriptor) {
    return { type, model, runnable: false, why: `no provider descriptor for type "${type}"` };
  }
  if (descriptor.apiKeyEnvironmentVariables.length === 0) {
    // ollama and vertexai authenticate outside the environment (a local daemon / gcloud ADC).
    // There is no key to look for, so a key check would skip them forever. ollama's own presence
    // is preflighted by `it.js`, which exits 0 before vitest starts when the daemon is absent.
    return { type, model, runnable: true, why: 'provider authenticates outside the environment' };
  }
  const keyEnvVar = findApiKeyEnvVar(descriptor);
  return {
    type,
    model,
    keyEnvVar,
    runnable: Boolean(keyEnvVar),
    why: keyEnvVar
      ? `${keyEnvVar} is set`
      : `none of ${descriptor.apiKeyEnvironmentVariables.join(', ')} is set`,
  };
}

const ambient = resolveAmbientProvider();

// `process.stdout.write`, not `console.log`, and that is the whole point of the line. Vitest
// intercepts `console` and its default reporter shows the captured output only for FAILING tests —
// so a `console.log` here would be invisible in exactly the case it exists for, a leg that skipped
// for a missing key and exited 0 looking like a pass. Writing to the stream directly bypasses the
// interception and prints under the default reporter, skipping or running.
process.stdout.write(
  `[EXT-88 structured output] provider=${ambient.type} model=${ambient.model} ` +
    `${ambient.runnable ? 'RUNNING' : 'SKIPPING'} (${ambient.why})\n`
);

/**
 * The shape from takahē's `scripts/graph-recall.workflow.mjs` — the real exposed `askStructured`
 * caller — reduced to one pick. The optional is NESTED (inside an object inside an array), which is
 * the shape a top-level-only fix would miss, and it is described so that nothing in the prompt can
 * satisfy it: there is no prior note to carry over, so a model has nothing to put there.
 */
const RecallSchema = z.object({
  summary: z.string().describe('One short sentence describing the picks.'),
  picks: z
    .array(
      z.object({
        id: z.string().describe('The item id, copied exactly as given.'),
        relation: z.string().describe('One lowercase word naming what the item relates to.'),
        annotation: z
          .string()
          .optional()
          .describe(
            'OPTIONAL. The prior note the caller supplied for this item, copied verbatim. ' +
              'Omit it entirely when the caller supplied no prior note — never invent one.'
          ),
      })
    )
    .describe('One entry per item id given.'),
});

describe.skipIf(!ambient.runnable)(
  `EXT-88 structured output survives the provider's withStructuredOutput conversion (${ambient.type})`,
  () => {
    let config: GthConfig;

    beforeAll(async () => {
      config = await initConfig({ customConfigPath: WORKDIR_CONFIG });
    });

    it('the shell rater reaches a real verdict instead of failing closed', async () => {
      const verdict = await rateShellCommand("date '+%Y-%m-%d'", config, {
        timeoutMs: CALL_TIMEOUT_MS,
      });

      // THE signal, and on this call the ONLY discriminating one. Asserting `outcome === 'safe'`
      // would be an assertion about model judgement and would flap across the matrix; asserting
      // "the gate reached a verdict rather than defaulting" holds on every model and is exactly
      // what regressed. `isFailClosed` keys on the exported COULD_NOT_ASSESS_PREFIX, so it covers
      // all four fail-closed causes without this file restating any reason text.
      expect(isFailClosed(verdict), `fail-closed verdict: ${JSON.stringify(verdict)}`).toBe(false);
      expect(typeof verdict.reason).toBe('string');

      // Stated plainly so nobody credits this pair with more than it does: with no `grantedTools`
      // supplied, `validateSuggestedTool` drops any suggestion, and the pre-fix fail-closed verdict
      // carries no `suggestedTool` key either — so these two hold before AND after the fix. They
      // pin the "absent, never null" contract at the rater's public surface; the NON-VACUOUS
      // absent-vs-null evidence is the askStructured case below, which has no such normalizer.
      expect(verdict.suggestedTool).toBeUndefined();
      expect('suggestedTool' in verdict).toBe(false);
    });

    it('a nested optional the model omits comes back absent, not null', async () => {
      const result = await askStructured(RecallSchema, {
        config,
        system:
          'You extract one small structured record. Follow the schema exactly and add nothing.',
        user: [
          'Item id: A-1. It relates to: bicycles.',
          'Return a one-sentence summary and exactly one pick for A-1 with that relation.',
          'The caller supplied no prior note for any item, so omit the annotation field.',
        ].join('\n'),
        timeoutMs: CALL_TIMEOUT_MS,
      });

      // Pre-fix this reds two different ways depending on the provider — a hoisting provider
      // (groq) answers `null` and the caller's `.optional()` rejects it, openai rejects the request
      // itself with a 400 — and a stalled provider reds a third way that is not the guard at all.
      // `describeFailure` names which of the three happened, in the output.
      expect(result.ok, result.ok ? '' : describeFailure(result.error)).toBe(true);
      if (!result.ok) return;

      expect(result.value.picks.length).toBeGreaterThan(0);
      const pick = result.value.picks[0];
      expect(typeof pick.id).toBe('string');

      // The pair that discriminates: `null` fails the first, a normalizer that writes `null` back
      // into the object fails the second.
      expect(pick.annotation).toBeUndefined();
      expect('annotation' in pick).toBe(false);
    });
  }
);
