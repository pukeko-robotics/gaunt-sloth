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

  /** A last-model-request snapshot that leaks a secret in the SYSTEM PROMPT and a TOOL RESULT. */
  function secretLadenModelRequest() {
    return {
      extras: {
        // A secret pasted into the composed system prompt (both the env-sourced literal and an
        // inline provider key), plus a real tool def whose name/schema must survive redaction.
        systemPrompt: `You are an agent. Do not reveal the key ${FAKE_API_KEY} or ${ENV_SECRET_VALUE}.`,
        tools: [{ name: 'read_file', description: 'read a file', schema: { type: 'object' } }],
        modelParams: { model: 'test-model', temperature: 0 },
      },
      // A ToolMessage-shaped as-sent message whose content leaks the same secrets.
      messages: [
        { type: 'system', content: 'System header' },
        {
          type: 'tool',
          content: `tool ran; token was Bearer ${BEARER_TOKEN} and key ${ENV_SECRET_VALUE}`,
        },
      ],
    };
  }

  it('GS2-56 — redacts a secret in the system prompt AND a tool result in the as-sent messages BY DEFAULT (model-request.json / model-messages.json)', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    // No `redact` field → defaults ON.
    const { archiveDir } = writeDebugDump({
      ...secretLadenInput(),
      modelRequest: secretLadenModelRequest(),
    });

    const modelReqText = readFileSync(resolve(archiveDir, 'model-request.json'), 'utf8');
    const modelMsgsText = readFileSync(resolve(archiveDir, 'model-messages.json'), 'utf8');

    for (const [name, text] of [
      ['model-request', modelReqText],
      ['model-messages', modelMsgsText],
    ] as const) {
      expect(text, `${name}: fake api key must be absent`).not.toContain(FAKE_API_KEY);
      expect(text, `${name}: env secret must be absent`).not.toContain(ENV_SECRET_VALUE);
      expect(text, `${name}: <redacted> marker present`).toContain('<redacted>');
    }
    // The bearer token in the tool result is gone; its auth scheme word is kept.
    expect(modelMsgsText).not.toContain(BEARER_TOKEN);
    expect(modelMsgsText).toContain('Bearer <redacted>');
    // Non-secret structure survives — the tool NAME/schema and model params stay debuggable.
    expect(modelReqText).toContain('read_file');
    expect(modelReqText).toContain('test-model');
  });

  it('GS2-56 — OPT-OUT (redact:false) writes the RAW model-input values back, unredacted', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { archiveDir } = writeDebugDump({
      ...secretLadenInput(),
      modelRequest: secretLadenModelRequest(),
      redact: false,
    });

    const modelReqText = readFileSync(resolve(archiveDir, 'model-request.json'), 'utf8');
    const modelMsgsText = readFileSync(resolve(archiveDir, 'model-messages.json'), 'utf8');

    expect(modelReqText).toContain(FAKE_API_KEY);
    expect(modelReqText).toContain(ENV_SECRET_VALUE);
    expect(modelMsgsText).toContain(BEARER_TOKEN);
    expect(modelMsgsText).toContain(ENV_SECRET_VALUE);
    // Nothing was masked in either new artifact.
    expect(modelReqText).not.toContain('<redacted>');
    expect(modelMsgsText).not.toContain('<redacted>');
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

  it('GS2-66 (residual 3): strips the `tools` + `middleware` arrays to count descriptors — instance internals (incl. a non-secret-named opaque field) never reach config.json — INDEPENDENT of a live llm', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    // Opaque, sensitive values under field names that do NOT match the secret-key regex, so
    // redactValue's field-masking would MISS them. Their absence proves the DESCRIPTOR strip (not
    // field-masking) hid the live instances — the discriminating assertion the brief calls for.
    const TOOL_OPAQUE = 'PRIVATE-TOOL-CACERT-BLOB-not-secret-named-abc';
    const MW_OPAQUE = 'PRIVATE-MW-INTERNAL-BLOB-not-secret-named-xyz';

    // NOTE: no live `llm` on this config — proves tools/middleware are stripped independently (the
    // pre-GS2-66 early-return `if (!('llm' in record) ...) return config` would have skipped them).
    const { archiveDir } = writeDebugDump({
      transcript: [],
      config: {
        modelDisplayName: 'test-model',
        tools: [
          { name: 'read_file', func: () => {}, caCert: TOOL_OPAQUE },
          { name: 'write_file', func: () => {} },
        ],
        middleware: [{ name: 'summarization', internalState: MW_OPAQUE }],
      },
      modelDisplayName: 'test-model',
      cwd: notGitDir,
    });

    const configText = readFileSync(resolve(archiveDir, 'config.json'), 'utf8');
    const config = JSON.parse(configText);

    // Arrays collapsed to short count descriptors (mirrors configCommand.ts redactConfigForPrint).
    expect(config.tools).toBe('[2 tool instance(s)]');
    expect(config.middleware).toBe('[1 middleware]');
    // The opaque, non-secret-NAMED instance internals are gone ONLY because the whole arrays were
    // stripped — the descriptor doing the work, not redactValue field-masking.
    expect(configText).not.toContain(TOOL_OPAQUE);
    expect(configText).not.toContain(MW_OPAQUE);
    // The descriptors carry no live instance fields.
    expect(configText).not.toContain('read_file');
    expect(configText).not.toContain('internalState');
    // Non-instance config shape is preserved.
    expect(config.modelDisplayName).toBe('test-model');
  });

  it('GS2-66 (residual 3, negative): a config WITHOUT tools/middleware does not fabricate descriptor keys', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { archiveDir } = writeDebugDump({
      transcript: [],
      config: { modelDisplayName: 'test-model', agent: { backend: 'lean' } },
      modelDisplayName: 'test-model',
      cwd: notGitDir,
    });
    const config = JSON.parse(readFileSync(resolve(archiveDir, 'config.json'), 'utf8'));
    expect(config).not.toHaveProperty('tools');
    expect(config).not.toHaveProperty('middleware');
    expect(config.agent).toEqual({ backend: 'lean' });
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

// GS2-66 — the four GS2-54 residuals, exercised at the pure `redactText` level (secrets=[] → only
// the provider/auth patterns are in play, deterministic + machine-independent). Residual 3 (live
// tools/middleware → descriptor) is a debugDump-config concern, tested through `writeDebugDump` above.
describe('utils/redactSecrets — GS2-66 hardening (residuals 1, 2 & 4)', () => {
  it('residual 1: bounds the auth value across STRUCTURED credential tails (id:secret, k="v", k=v list, Digest) — no raw tail past the token charset', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // `id:secret` — GS2-54 left `<redacted>:secret123`; the whole value must go now.
    expect(redactText('Authorization: ApiKey clientid:secret123', [])).toBe(
      'Authorization: <redacted>'
    );
    // `k="quoted"` — GS2-54 left `<redacted>"abc123"`.
    expect(redactText('Authorization: Token token="abc123"', [])).toBe('Authorization: <redacted>');
    // `k=v,k=v` list — GS2-54 left `<redacted>,key2=supersecret`.
    expect(redactText('Authorization: Custom key1=v1,key2=supersecret', [])).toBe(
      'Authorization: <redacted>'
    );
    // Digest — a `response="…"` hash must NOT survive beside the marker.
    const digest =
      'Authorization: Digest username="admin", realm="test", response="deadbeefhashvalue"';
    const digestOut = redactText(digest, []);
    expect(digestOut).toBe('Authorization: <redacted>');
    expect(digestOut).not.toContain('deadbeefhashvalue');
    expect(digestOut).not.toContain('response=');
  });

  it('residual 1 (negative): an auth value does NOT swallow following prose — after a period OR after a bare comma-word (GS2-47 invariant)', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // Prose after the credential (period boundary).
    const afterPeriod = redactText(
      'Sent header Authorization: ApiKey abc123def456. Then the request succeeded and returned 200.',
      []
    );
    expect(afterPeriod).toContain('Authorization: <redacted>');
    expect(afterPeriod).toContain('Then the request succeeded and returned 200.');
    expect(afterPeriod).not.toContain('abc123def456');
    // A comma followed by a bare (non-param-shaped) word is prose, not a credential param: the
    // comma-continuation requires `k=…`/quoted, so the sentence after the comma is preserved.
    const afterComma = redactText(
      'Authorization: Bearer tok123abcdef, then we retried the call and it worked.',
      []
    );
    expect(afterComma).toContain('Authorization: <redacted>');
    expect(afterComma).toContain(', then we retried the call and it worked.');
    expect(afterComma).not.toContain('tok123abcdef');
  });

  it('residual 1 (negative): a SigV4 header is untouched by the general rule — SignedHeaders stays, Credential/Signature are redacted by the dedicated rule', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    const CRED = 'AKIAIOSFODNN7EXAMPLE/20260720/us-east-1/s3/aws4_request';
    const SIG = 'fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024';
    const out = redactText(
      `Authorization: AWS4-HMAC-SHA256 Credential=${CRED}, SignedHeaders=host;x-amz-date, Signature=${SIG}`,
      []
    );
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain(SIG);
    // The `(?!AWS4-HMAC-SHA256[ \t]+Credential=)` exclusion is why SignedHeaders survives (the
    // broadened value rule would otherwise cross the comma into it).
    expect(out).toContain('SignedHeaders=host;x-amz-date');
    expect(out).toContain('Credential=<redacted>');
    expect(out).toContain('Signature=<redacted>');
  });

  it('residual 1 (positive): the SigV4 exclusion is NARROW — a malformed bare-token `AWS4-HMAC-SHA256 <token>` (no Credential=) is still redacted, not let through', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // The exclusion targets a GENUINE SigV4 shape only; a bare token under the AWS4 scheme has no
    // dedicated Credential/Signature rule to catch it, so the general rule MUST redact it (the old
    // two-token rule did — the narrow guard preserves that "redact any scheme" contract).
    expect(redactText('Authorization: AWS4-HMAC-SHA256 mysecrettoken123', [])).toBe(
      'Authorization: <redacted>'
    );
  });

  it('residual 2: redacts colon-LESS bare-userinfo (`opaquetoken@host`), keeping scheme + host', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // Colon-less userinfo (a PAT/opaque token in a clone URL) — GS2-54 required a `:` and missed this.
    expect(redactText('clone url https://s0m3-0paqu3-t0k3n@github.com/owner/repo.git', [])).toBe(
      'clone url https://<redacted>@github.com/owner/repo.git'
    );
    // The colon-FUL form still works (single merged rule).
    expect(redactText('fetch https://user:tok@example.com/x', [])).toBe(
      'fetch https://<redacted>@example.com/x'
    );
    // An ordinary URL without userinfo is still untouched (no `@` after the authority).
    expect(redactText('remote https://github.com/owner/repo.git', [])).toBe(
      'remote https://github.com/owner/repo.git'
    );
    // host:port with no `@` is not mistaken for userinfo.
    expect(redactText('server http://localhost:3000/health', [])).toBe(
      'server http://localhost:3000/health'
    );
  });

  it('residual 4 (safe direction): the header-prefix `\\s*` spans a newline (over-redacts a next-line value), while the credential body does not cross a newline', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // The prefix `\s*` includes `\n`, so a value on the next line is still caught — over-redaction in
    // the SAFE direction (never a leak). Documents the behavior the corrected comment describes.
    expect(redactText('Authorization:\nBearer s3cr3t-token-abc', [])).toBe(
      'Authorization:\n<redacted>'
    );
    // The credential body uses only horizontal ws, so a genuinely separate next line is preserved.
    const twoLines = redactText('Authorization: ApiKey secret-token-123\nnext line of the log', []);
    expect(twoLines).toContain('Authorization: <redacted>');
    expect(twoLines).toContain('next line of the log');
    expect(twoLines).not.toContain('secret-token-123');
  });
});

// GS2-71 — M1 hardening from the GS2-66 adversarial review: the param-list continuation now accepts
// `;` as well as `,` (`[,;]`), so a `;`-delimited param list is fully redacted — WITHOUT broadening
// the token charset and WITHOUT reintroducing the GS2-47 prose-swallow (a `;`-then-prose stays intact,
// exactly as the `,`-then-prose case already does). Pure `redactText` level (secrets=[] → only the
// provider/auth patterns are in play, deterministic + machine-independent).
describe('utils/redactSecrets — GS2-71 hardening (M1: `;` as a param separator)', () => {
  it('positive: a `;`-delimited param list is fully redacted — no raw tail past the first param', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // GS2-66 left `<redacted>;key2=supersecret` (the `;` tail leaked); the whole value must go now.
    const out = redactText('Authorization: Custom key1=v1;key2=supersecret', []);
    expect(out).toBe('Authorization: <redacted>');
    expect(out).not.toContain('key2=');
    expect(out).not.toContain('supersecret');
  });

  it('positive: a MIXED `,` + `;` param list is fully redacted', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    const out = redactText('Authorization: Custom key1=v1,key2=v2;key3=secret', []);
    expect(out).toBe('Authorization: <redacted>');
    expect(out).not.toContain('key3=');
    expect(out).not.toContain('secret');
  });

  it('negative (the invariant guard): `;`-then-PROSE is NOT swallowed — the widening did not reintroduce the GS2-47 prose-swallow', async () => {
    const { redactText } = await import('#src/utils/redactSecrets.js');
    // A `;` followed by a bare (non-param-shaped) word is prose, not a param: AUTH_PARAM still requires
    // `k=…`/quoted, so the sentence after the `;` is preserved (mirrors the GS2-66 comma-then-prose test).
    const out = redactText('Authorization: Custom key1=v1; then the user said hello', []);
    expect(out).toContain('Authorization: <redacted>');
    expect(out).toContain('; then the user said hello');
    expect(out).not.toContain('key1=v1');
    // Same invariant with a Bearer token before the `;` — the token is redacted, the prose survives.
    const bearer = redactText(
      'Authorization: Bearer tok123abcdef; then we retried the call and it worked.',
      []
    );
    expect(bearer).toContain('Authorization: <redacted>');
    expect(bearer).toContain('; then we retried the call and it worked.');
    expect(bearer).not.toContain('tok123abcdef');
  });
});
