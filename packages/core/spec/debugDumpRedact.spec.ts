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

  it('GS2-54 (gap 3): strips a LIVE chat model to a { type, model } descriptor — internals + a non-secret-named opaque field never reach config.json', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    const INLINE_KEY = 'sk-ant-INLINEMODELKEY0123456789abcdef';
    // An opaque, sensitive value under a field name that does NOT match the secret-key regex, so
    // redactValue's field-masking would MISS it. Its absence therefore proves the DESCRIPTOR strip
    // (not redactValue) hid the live model — the discriminating assertion the brief calls for.
    const OPAQUE_SECRET = 'PRIVATE-CACERT-BLOB-not-secret-named-xyz';

    // A realistic minimal BaseChatModel shape: `_llmType()` and `invoke()` are the live-model
    // signals `isLiveChatModel` keys off; it also carries model internals + an inline key.
    const liveModel = {
      _llmType: () => 'anthropic',
      invoke: async () => ({}),
      model: 'claude-3-5-sonnet',
      lc_namespace: ['langchain', 'chat_models', 'anthropic'],
      anthropicApiKey: INLINE_KEY,
      clientConfig: { apiKey: INLINE_KEY, caCert: OPAQUE_SECRET },
    };

    const { archiveDir } = writeDebugDump({
      transcript: [],
      config: { modelDisplayName: 'claude-3-5-sonnet', llm: liveModel },
      modelDisplayName: 'claude-3-5-sonnet',
      cwd: notGitDir,
    });

    const configText = readFileSync(resolve(archiveDir, 'config.json'), 'utf8');
    const config = JSON.parse(configText);

    // The live model is replaced by a compact descriptor — and ONLY `type`/`model` (no leftovers).
    expect(config.llm).toEqual({ type: 'anthropic', model: 'claude-3-5-sonnet' });
    // None of the model internals serialized.
    expect(configText).not.toContain('clientConfig');
    expect(configText).not.toContain('lc_namespace');
    expect(configText).not.toContain('_llmType');
    // The opaque, non-secret-NAMED value is gone ONLY because the whole live model was stripped
    // (redactValue would not mask a `caCert` field) — this is the descriptor doing the work.
    expect(configText).not.toContain(OPAQUE_SECRET);
    // …and the inline key is absent too.
    expect(configText).not.toContain(INLINE_KEY);
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

// GS2-54 — the three specced hardening gaps, exercised at the pure `redactText` level (secrets=[]
// so ONLY the provider/auth patterns are in play — deterministic, machine-independent). Gap 3 (live
// model → descriptor) is a debugDump-config concern, tested through `writeDebugDump` above.
describe('utils/redactSecrets — GS2-54 hardening (gaps 1 & 2)', () => {
  it('gap 1: redacts an Authorization header value REGARDLESS OF SCHEME (ApiKey / unknown scheme)', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // Non-standard `ApiKey` scheme — the token must NOT survive beside the marker (the old bug).
    expect(redactText('Authorization: ApiKey s3cr3t-token-abc123', [])).toBe(
      'Authorization: <redacted>'
    );
    // An arbitrary unknown scheme.
    expect(redactText('Authorization: Zonk abc123def456ghi789', [])).toBe(
      'Authorization: <redacted>'
    );
    // JSON-quoted form, scheme included, closing quote preserved.
    expect(redactText('"Authorization":"ApiKey s3cr3t-token-xyz"', [])).toBe(
      '"Authorization":"<redacted>"'
    );
  });

  it('gap 1: an Authorization header does NOT swallow following prose (GS2-47 no-prose-swallow invariant preserved)', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    const input =
      'Sent header Authorization: ApiKey abc123def456. Then the request succeeded and returned 200.';
    const out = redactText(input, []);
    expect(out).toContain('Authorization: <redacted>');
    expect(out).toContain('Then the request succeeded and returned 200.');
    expect(out).not.toContain('abc123def456');
  });

  it('gap 1: redacts SigV4 Credential and Signature while keeping the header name + SignedHeaders', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    const CRED = 'AKIAIOSFODNN7EXAMPLE/20260720/us-east-1/s3/aws4_request';
    const SIG = 'fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024';
    const input =
      `Authorization: AWS4-HMAC-SHA256 Credential=${CRED}, ` +
      `SignedHeaders=host;x-amz-date, Signature=${SIG}`;
    const out = redactText(input, []);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain(SIG);
    // The non-sensitive SignedHeaders list is preserved for debuggability.
    expect(out).toContain('SignedHeaders=host;x-amz-date');
    expect(out).toContain('Signature=<redacted>');
  });

  it('gap 2: redacts GitHub classic/scoped PATs (ghp_/gho_) and fine-grained github_pat_ tokens', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    const ghp = 'ghp_ABCDEFghijkl0123456789MNOPqrstuvwx';
    const gho = 'gho_0123456789abcdefABCDEF0123456789ab';
    const fineGrained =
      'github_pat_11ABCDEFG0abcdefghijklmn_0123456789ABCDEFGHIJKLMNOPqrstuvwxyz0123456789ABCD';
    expect(redactText(`token=${ghp}`, [])).toBe('token=<redacted>');
    expect(redactText(`token=${gho}`, [])).toBe('token=<redacted>');
    expect(redactText(`token=${fineGrained}`, [])).toBe('token=<redacted>');
  });

  it('gap 2: redacts a credential-in-URL userinfo, keeping scheme + host', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // `user:tok@host` — userinfo redacted, scheme + host + path kept (artifact stays debuggable).
    expect(redactText('clone url https://user:tok@github.com/owner/repo.git', [])).toBe(
      'clone url https://<redacted>@github.com/owner/repo.git'
    );
    // A URL WITHOUT userinfo is left untouched (no `user:pass@` to redact).
    expect(redactText('remote https://github.com/owner/repo.git', [])).toBe(
      'remote https://github.com/owner/repo.git'
    );
    // A host:port (no `@`) is not mistaken for userinfo.
    expect(redactText('server http://localhost:3000/health', [])).toBe(
      'server http://localhost:3000/health'
    );
  });
});
