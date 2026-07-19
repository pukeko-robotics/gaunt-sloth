import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Real fs / real temp dir (as debugDump.spec.ts does) — only `os.homedir()` is mocked, pointed at a
// fresh mkdtemp dir, so `ensureGlobalGslothDir()` + the archive path are exercised for real without
// touching the developer's `~/.gsloth`. systemUtils is deliberately NOT mocked: `writeDebugDump`
// reads `systemUtils.env` (=== process.env), so the tests set/clear a controlled decoy secret env
// var on process.env and the collector picks it up deterministically.
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: homedirMock };
});

// A secret-named env var whose long VALUE is a load-bearing "known secret" the pass must scrub
// everywhere it surfaces (technique 1). Unique name so it can't clash with the real environment.
const ENV_SECRET_NAME = 'GS2_47_REDACT_TEST_API_KEY';
const ENV_SECRET_VALUE = 'env-secret-value-abcdef1234567890';
// A fake, inline provider key (matches the `sk-ant-…` pattern AND is an inline config secret).
const FAKE_API_KEY = 'sk-ant-FAKEKEY0123456789abcdefghij';
// Fake bearer tokens: only redacted because they sit in an auth context. One in an `Authorization`
// header (whole value masked), one standalone `Bearer …` (scheme word preserved).
const BEARER_TOKEN = 'abcdefghijklmnop1234567890';
const STANDALONE_TOKEN = 'zyxwvutsrqpo9876543210token';

describe('utils/debugDump — GS2-47 secret redaction', () => {
  let homeDir: string;
  let notGitDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    homeDir = mkdtempSync(resolve(tmpdir(), 'gsloth-redact-home-'));
    notGitDir = mkdtempSync(resolve(tmpdir(), 'gsloth-redact-notgit-'));
    homedirMock.mockReturnValue(homeDir);
    process.env[ENV_SECRET_NAME] = ENV_SECRET_VALUE;
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(notGitDir, { recursive: true, force: true });
    delete process.env[ENV_SECRET_NAME];
  });

  /** A session whose transcript/config/log all leak the three kinds of secret. */
  function secretLadenInput() {
    return {
      transcript: [
        { role: 'user', text: 'why did auth fail?' },
        {
          role: 'assistant',
          text:
            `I called the API with ${FAKE_API_KEY} and env value ${ENV_SECRET_VALUE}, ` +
            `sending header Authorization: Bearer ${BEARER_TOKEN}. ` +
            `The raw token was Bearer ${STANDALONE_TOKEN} on its own.`,
        },
      ],
      config: {
        modelDisplayName: 'test-model',
        llm: {
          type: 'anthropic',
          model: 'claude-test',
          apiKey: FAKE_API_KEY, // inline secret (technique 3 field + technique 1 literal)
          apiKeyEnvironmentVariable: ENV_SECRET_NAME, // a var NAME — must be preserved, not masked
        },
      },
      // Embed the env secret in the display name so it flows into env.json's `model` field — lets
      // us assert the env.json artifact type is redacted too (it carries no secret otherwise).
      modelDisplayName: `model-${ENV_SECRET_VALUE}`,
      cwd: notGitDir,
    };
  }

  it('redacts a fake API key, a bearer token and a secret-sourced env value BY DEFAULT, in every artifact that carries them', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { debugLog } = await import('#src/utils/debugUtils.js');
    debugLog(`debug line leaking ${ENV_SECRET_VALUE} and ${FAKE_API_KEY}`);

    // No `redact` field → defaults ON.
    const { archiveDir } = writeDebugDump(secretLadenInput());

    const transcriptText = readFileSync(resolve(archiveDir, 'transcript.json'), 'utf8');
    const configText = readFileSync(resolve(archiveDir, 'config.json'), 'utf8');
    const debugLogText = readFileSync(resolve(archiveDir, 'debug-log.txt'), 'utf8');
    const envText = readFileSync(resolve(archiveDir, 'env.json'), 'utf8');

    for (const [name, text] of [
      ['transcript', transcriptText],
      ['config', configText],
      ['debug-log', debugLogText],
      ['env', envText],
    ] as const) {
      expect(text, `${name}: fake api key must be absent`).not.toContain(FAKE_API_KEY);
      expect(text, `${name}: env secret must be absent`).not.toContain(ENV_SECRET_VALUE);
      expect(text, `${name}: <redacted> marker present`).toContain('<redacted>');
    }
    // Both bearer tokens are gone (only redacted via the auth-context patterns).
    expect(transcriptText).not.toContain(BEARER_TOKEN);
    expect(transcriptText).not.toContain(STANDALONE_TOKEN);
    // An `Authorization:` header value is masked whole (scheme included).
    expect(transcriptText).toContain('Authorization: <redacted>');
    // A standalone `Bearer <token>` keeps the scheme word — we redact only the credential.
    expect(transcriptText).toContain('Bearer <redacted>');
  });

  it('preserves config STRUCTURE — keys/shape kept, only sensitive values masked (apiKeyEnvironmentVariable, a var NAME, is NOT masked)', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { archiveDir } = writeDebugDump(secretLadenInput());

    const config = JSON.parse(readFileSync(resolve(archiveDir, 'config.json'), 'utf8'));
    // Shape intact.
    expect(config.modelDisplayName).toBe('test-model');
    expect(config.llm.type).toBe('anthropic');
    expect(config.llm.model).toBe('claude-test');
    // The inline secret VALUE is masked, its key kept.
    expect(config.llm).toHaveProperty('apiKey');
    expect(config.llm.apiKey).toBe('<redacted>');
    // A var NAME is not a secret — preserved verbatim (and it's what technique 1 reads).
    expect(config.llm.apiKeyEnvironmentVariable).toBe(ENV_SECRET_NAME);
  });

  it('OPT-OUT (redact:false) writes the RAW values back, unredacted', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { archiveDir } = writeDebugDump({ ...secretLadenInput(), redact: false });

    const transcriptText = readFileSync(resolve(archiveDir, 'transcript.json'), 'utf8');
    const configText = readFileSync(resolve(archiveDir, 'config.json'), 'utf8');

    expect(transcriptText).toContain(FAKE_API_KEY);
    expect(transcriptText).toContain(ENV_SECRET_VALUE);
    expect(transcriptText).toContain(BEARER_TOKEN);
    expect(configText).toContain(FAKE_API_KEY);
    // Nothing was masked.
    expect(transcriptText).not.toContain('<redacted>');
  });

  it('never throws on a circular / non-JSON-safe config while redacting (fail-safe)', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const circular: Record<string, unknown> = { apiKey: FAKE_API_KEY };
    circular.self = circular;
    circular.method = function named() {};

    let archiveDir = '';
    expect(() => {
      ({ archiveDir } = writeDebugDump({
        transcript: [],
        config: circular,
        modelDisplayName: 'm',
        cwd: notGitDir,
      }));
    }).not.toThrow();
    // Even through the circular structure, the secret did not leak.
    expect(readFileSync(resolve(archiveDir, 'config.json'), 'utf8')).not.toContain(FAKE_API_KEY);
  });
});

// The one-time false-positive spot-check the brief asks for: run the redactor over an ORDINARY,
// secret-free transcript with a controlled decoy secret env whose value does NOT appear in the
// text, and confirm nothing legitimate is masked. Driven at the util level (not through the writer)
// so it is deterministic and machine-independent (no ambient env in play).
describe('utils/redactSecrets — false-positive spot-check (GS2-47)', () => {
  it('leaves an ordinary secret-free transcript completely untouched', async () => {
    const { collectSecretValues, redactText } = await import('#src/utils/redactSecrets.js');

    const decoyEnv = { DECOY_API_KEY: 'decoy-value-never-appears-in-the-text-987654' };
    const ordinaryTranscript = JSON.stringify([
      { role: 'user', text: 'Please refactor calculateTotal to fold the discount in cleanly.' },
      {
        role: 'assistant',
        text:
          'Extracted a `applyDiscount(subtotal, rate)` helper and reused it in calculateTotal; ' +
          'ran the unit tests (42 passed). The function is pure and returns a number.',
      },
      { role: 'user', text: 'Great, ship it. Authorization to merge is granted by the team lead.' },
    ]);

    // No config secrets, decoy env value absent from the text.
    const secrets = collectSecretValues({ llm: { type: 'openai' } }, decoyEnv);
    const out = redactText(ordinaryTranscript, secrets);

    expect(out).toBe(ordinaryTranscript); // byte-for-byte identical — zero false positives
    expect(out).not.toContain('<redacted>');
  });
});
