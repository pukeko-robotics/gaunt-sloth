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
  // Never read from the ambient environment: the path is asserted on, so it has to be one this
  // spec chose. It is never opened — the hint path constructs a client and never authenticates.
  const FAKE_ADC_FILE = '/nonexistent/EXT-152-adc-not-real.json';

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
    // The EXT-152 remedy below is GATED on the variable being set: a session with nothing exported
    // must not be told to go and look at a variable it does not have. This is the half that makes
    // the gate provable — without it, an implementation that appends that sentence unconditionally
    // passes every cell in this file.
    expect(hint).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
  });

  /**
   * EXT-152 — the sixth population, and the one case here where the diagnosis was already RIGHT.
   * This session really is on ADC, so naming ADC is correct and must stay correct; what was wrong
   * is that the remedy could not work. `google-auth-library` (measured on 10.9.1) resolves
   * `GOOGLE_APPLICATION_CREDENTIALS` in `getApplicationDefaultAsync` at :258, BEFORE it reads at
   * :270 the well-known file that `gcloud auth application-default login` writes. So the user runs
   * the command, it reports success, and the failure survives it.
   *
   * Keep the distinction: the five populations above asserted a FALSE credential. This one asserts
   * a TRUE credential with an inert remedy, which is a different defect and not a regression of it.
   */
  it('POPULATION 6 — ADC from GOOGLE_APPLICATION_CREDENTIALS: the file that variable names', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = FAKE_ADC_FILE;

    const hint = await hintForPreset({});

    // Still ADC, and still said to be ADC — the classifier is right here and is not second-guessed.
    expect(hint).toContain('Application Default Credentials');
    // The remedy has to name the thing that is actually in play, and the file it points at.
    expect(hint).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(hint).toContain(FAKE_ADC_FILE);
    // ...and offer an action that could actually change this session's auth state.
    expect(hint).toMatch(/unset `?GOOGLE_APPLICATION_CREDENTIALS/);
    // The login command may still be NAMED — explaining that it is the thing that will NOT help is
    // the whole point — but the clause that offered it as the entire remedy has to be gone.
    expect(hint).toContain('gcloud auth application-default login');
    expect(hint).not.toContain('Credentials: run `gcloud auth login`');
    // As for every ADC population: neither a key nor a service account may be blamed.
    expect(hint).not.toContain('express mode');
    expect(hint).not.toContain('service account');
  });

  it('POPULATION 6b — the same when the variable is spelled in lower case', async () => {
    // `googleauth.js` :316 reads `GOOGLE_APPLICATION_CREDENTIALS || google_application_credentials`,
    // so a lower-case-only session is ADC-from-a-file too and would otherwise get the inert remedy.
    // Asserts on the PATH rather than on which spelling was found, because `process.env` is
    // case-insensitive on Windows: this same assignment is visible under the upper-case spelling
    // there, so the spelling in the message is platform-dependent by design and the path is not.
    const saved = process.env.google_application_credentials;
    process.env.google_application_credentials = FAKE_ADC_FILE;
    try {
      const hint = await hintForPreset({});

      expect(hint).toContain(FAKE_ADC_FILE);
      expect(hint).toContain('Application Default Credentials');
      expect(hint).not.toContain('Credentials: run `gcloud auth login`');
    } finally {
      if (saved === undefined) {
        delete process.env.google_application_credentials;
      } else {
        process.env.google_application_credentials = saved;
      }
    }
  });

  it('POPULATION 6c — the variable holds pasted credentials, not a path: echo nothing', async () => {
    // The common CI misconfiguration: the service-account JSON is pasted INTO the variable instead
    // of being written to a file. `google-auth-library` treats the whole blob as a filename and
    // fails to open it, so this session is still ADC and still reaches this hint.
    //
    // It must not take the branch above. There is no file to point at, so "the file it points at"
    // would be precisely the kind of claim-that-does-not-hold this node exists to remove — and the
    // value is a private key, while the message it would land in is also written to the log stream
    // and to debug dumps. Falling back to the pinned sentence asserts nothing about it.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT;

    const hint = await hintForPreset({});

    expect(hint).not.toContain('not-a-real-private-key');
    expect(hint).not.toContain('service_account');
    expect(hint).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(hint).toContain('Credentials: run `gcloud auth login`');
  });

  it('POPULATION 6d — the same when the pasted credentials are base64, not JSON', async () => {
    // The CI idiom is to carry the key through a secret store base64-encoded and decode it into a
    // file; skipping the decode leaves an opaque blob in the variable. It does not start with `{`,
    // so the shape test that catches POPULATION 6c does not see it — and enumerating paste
    // encodings would only ever be as complete as the last one somebody thought of.
    //
    // What the two have in common is SIZE, and that is what is pinned here: a credential is orders
    // of magnitude longer than any filesystem path. This cell is what stops the guard being widened
    // back down to a shape test.
    const realisticKey = Buffer.from(
      JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        // Filler of the length a real PEM private key has. Not a key, and not derived from one.
        private_key:
          '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(1600) + '\n-----END PRIVATE KEY-----',
        client_email: 'test@test-project.iam.gserviceaccount.com',
      })
    ).toString('base64');
    expect(realisticKey.startsWith('{')).toBe(false); // the 6c shape test cannot catch this one
    process.env.GOOGLE_APPLICATION_CREDENTIALS = realisticKey;

    const hint = await hintForPreset({});

    expect(hint).not.toContain(realisticKey);
    expect(hint).not.toContain('AAAAAAAAAA');
    expect(hint).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(hint).toContain('Credentials: run `gcloud auth login`');
  });

  it('a long-but-plausible credentials PATH is still named — the cap is not a shape test', async () => {
    // The control for the two above: the guard must exclude credential CONTENT, not merely long
    // values, or a deep CI path would silently lose the remedy this node exists to give it.
    const deepPath =
      '/home/runner/work/_temp/8f3c1a90-4b21-4d5e-9c77-0ab12cd34ef5/' +
      'gcp/service-account/application_default_credentials.json';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = deepPath;

    const hint = await hintForPreset({});

    expect(hint).toContain(deepPath);
    expect(hint).toContain('GOOGLE_APPLICATION_CREDENTIALS');
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
