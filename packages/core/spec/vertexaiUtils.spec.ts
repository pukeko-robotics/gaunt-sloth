import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatGoogle } from '@langchain/google/node';
import { enhanceVertexUnauthorizedMessage, isVertexGoogleLlm } from '#src/utils/vertexaiUtils.js';

const vertexLlm = { _platform: 'gcp' };
const genAiLlm = { _platform: 'gai' };

describe('isVertexGoogleLlm', () => {
  it('returns true only for gcp-platform models', () => {
    expect(isVertexGoogleLlm(vertexLlm)).toBe(true);
    expect(isVertexGoogleLlm(genAiLlm)).toBe(false);
    expect(isVertexGoogleLlm(null)).toBe(false);
    expect(isVertexGoogleLlm('not-an-llm')).toBe(false);
  });
});

describe('enhanceVertexUnauthorizedMessage', () => {
  it('appends the reauth hint for HTTP 401 / unauthorized errors', () => {
    expect(enhanceVertexUnauthorizedMessage('Got 401 from endpoint', vertexLlm)).toContain(
      'gcloud auth application-default login'
    );
    expect(enhanceVertexUnauthorizedMessage('Request unauthorized', vertexLlm)).toContain(
      'Vertex AI authentication failed.'
    );
  });

  it('appends the reauth hint for expired ADC credential errors (invalid_grant / invalid_rapt)', () => {
    const adcReauthError =
      'Agent processing failed: {"error":"invalid_grant",' +
      '"error_description":"reauth related error (invalid_rapt)",' +
      '"error_subtype":"invalid_rapt"}';

    const enhanced = enhanceVertexUnauthorizedMessage(adcReauthError, vertexLlm);

    expect(enhanced).toContain(adcReauthError);
    expect(enhanced).toContain('gcloud auth application-default login');
  });

  it('leaves the message untouched for non-vertex models', () => {
    const message = 'invalid_grant reauth related error';
    expect(enhanceVertexUnauthorizedMessage(message, genAiLlm)).toBe(message);
  });

  it('leaves unrelated errors untouched even on vertex', () => {
    const message = 'Model returned an empty response.';
    expect(enhanceVertexUnauthorizedMessage(message, vertexLlm)).toBe(message);
  });
});

/**
 * CFG-58 — the hint fires on `_platform === 'gcp'`, and FOUR different sessions carry that platform.
 * Vertex accepts three mutually exclusive credentials, so a hint that names the wrong one sends the
 * reader to change something that is not in play — which is how the same sentence was wrong twice.
 *
 * Every case below reads its message off a REAL constructed client (the preset for a JSON config, a
 * hand-built `ChatGoogle` for a `.gsloth.config.mjs`), so the population is produced the way a user
 * produces it rather than asserted into existence by a double. Each pin is DISCRIMINATING: it states
 * what that population must be told and what it must NOT be told, because a message that merely
 * contains the right words can still lead with the wrong diagnosis.
 *
 * No key is compared by value anywhere — only presence, absence, and the wording of the advice.
 */
describe('the credential a Vertex hint names (CFG-58)', () => {
  const AMBIENT_KEY = 'ambient-env-key-not-real';
  const CONFIG_KEY = 'config-express-key-not-real';
  const SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: 'not-a-real-private-key',
    client_email: 'test@test-project.iam.gserviceaccount.com',
  });
  const MODEL = 'gemini-3.7-flash';
  const A_401 = 'Request failed with status code 401';

  const MANAGED_VARS = [
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_CLOUD_CREDENTIALS',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Cleared and re-set rather than read, so nothing this machine exports can reach an assertion.
    for (const name of MANAGED_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of MANAGED_VARS) {
      const value = savedEnv[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  /** The message a session of this shape would actually be shown for a 401. */
  async function hintForPreset(llmConfig: Record<string, unknown>): Promise<string> {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');
    const model = await processJsonConfig({
      type: 'vertexai',
      model: MODEL,
      ...llmConfig,
    } as never);
    return enhanceVertexUnauthorizedMessage(A_401, model);
  }

  it('POPULATION 1 — JSON `type: vertexai`, no apiKey, ambient GOOGLE_API_KEY: ADC, not the key', async () => {
    process.env.GOOGLE_API_KEY = AMBIENT_KEY;

    const hint = await hintForPreset({});

    // This is the population the node was filed for: the ambient key is demoted, so telling them
    // to unset it sends them after a cause the preset already ruled out.
    expect(hint).toContain('authenticates through Application Default Credentials');
    expect(hint).toContain('gcloud auth application-default login');
    expect(hint).toMatch(/ignores any `?GOOGLE_API_KEY/);
    expect(hint).not.toMatch(/make sure `?GOOGLE_API_KEY`? is unset/);
    // They have no API key and no service account, so neither may be blamed.
    expect(hint).not.toContain('express mode');
    expect(hint).not.toContain('service account');
  });

  it('POPULATION 2 — JSON `type: vertexai` WITH an apiKey in the llm block: the key, not ADC', async () => {
    process.env.GOOGLE_API_KEY = AMBIENT_KEY;

    const hint = await hintForPreset({ apiKey: CONFIG_KEY });

    // No ADC is built at all for this session, so ADC advice would be a dead end...
    expect(hint).toContain('not with Application Default Credentials');
    expect(hint).not.toContain('authenticates through Application Default Credentials');
    // ...and the setup the docs recommend is exactly where an AI Studio key gets mistakenly put,
    // so the key must be named as the thing to check.
    expect(hint).toContain('express mode');
    expect(hint).toContain('Google AI Studio key is not valid for Vertex AI endpoints');
    // The sentence that would make them stop looking: it must not be excluded to the .mjs case.
    expect(hint).not.toMatch(/ignores any `?GOOGLE_API_KEY/);
  });

  it('POPULATION 3 — .gsloth.config.mjs hand-building ChatGoogle: the ambient key took over', async () => {
    process.env.GOOGLE_API_KEY = AMBIENT_KEY;

    // Bypasses the preset entirely, exactly as the documented .mjs example does.
    const model = new ChatGoogle({ model: MODEL, vertexai: true });
    const hint = enhanceVertexUnauthorizedMessage(A_401, model);

    expect(hint).toContain('express mode');
    expect(hint).toContain('Google AI Studio key is not valid for Vertex AI endpoints');
    // Their key came from the environment, so the environment must be named as a source.
    expect(hint).toContain('`GOOGLE_API_KEY` from your environment');
    expect(hint).toContain('.gsloth.config.mjs');
    expect(hint).not.toContain('authenticates through Application Default Credentials');
  });

  it('POPULATION 4 — service-account credentials: neither ADC nor an API key', async () => {
    process.env.GOOGLE_CLOUD_CREDENTIALS = SERVICE_ACCOUNT;

    const hint = await hintForPreset({});

    // Measured: this session builds NO GoogleAuth, so `gcloud auth` cannot fix it either.
    expect(hint).toContain('service account');
    expect(hint).toContain('not with Application Default Credentials');
    expect(hint).not.toContain('authenticates through Application Default Credentials');
    expect(hint).not.toContain('express mode');
  });

  it('POPULATION 4b — the same when credentials come from the llm block instead of the env', async () => {
    const hint = await hintForPreset({ credentials: SERVICE_ACCOUNT });

    expect(hint).toContain('service account');
    expect(hint).not.toContain('authenticates through Application Default Credentials');
  });

  it('POPULATION 5 — JSON `type: vertexai` with nothing exported: plain ADC', async () => {
    const hint = await hintForPreset({});

    expect(hint).toContain('authenticates through Application Default Credentials');
    expect(hint).toContain('gcloud auth application-default login');
    expect(hint).not.toContain('express mode');
    expect(hint).not.toContain('service account');
  });

  it('asserts NO credential when the client cannot be read, instead of guessing one', () => {
    // Reachable only from a double or a future refactor. Guessing here is what produces a
    // confidently wrong diagnosis, so this branch names all three and blames none.
    const hint = enhanceVertexUnauthorizedMessage(A_401, { _platform: 'gcp' });

    expect(hint).toContain('only one is in use per session');
    expect(hint).not.toContain('authenticates through Application Default Credentials');
    expect(hint).not.toContain('not with Application Default Credentials');
  });
});
