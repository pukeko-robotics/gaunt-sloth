import { env } from '#src/utils/systemUtils.js';

export function isVertexGoogleLlm(llm: unknown): boolean {
  if (!llm || typeof llm !== 'object') {
    return false;
  }
  const model = llm as { _platform?: string };
  return model._platform === 'gcp';
}

// Matches the auth failures Vertex AI / gcloud ADC surface:
//  - HTTP 401 / "unauthorized" (token rejected by the endpoint)
//  - OAuth "invalid_grant" with "invalid_rapt" subtype, or any "reauth" wording
//    (expired ADC credentials / reauth proof token — `gcloud auth ... login` needed)
const VERTEX_AUTH_ERROR_PATTERN = /\b401\b|unauthori[sz]ed|invalid_grant|invalid_rapt|reauth/i;

/**
 * Which credential a Vertex session is actually presenting. Vertex on `@langchain/google` has three
 * of them and they are mutually exclusive — the client picks one and the other two are inert — so a
 * hint that names the wrong one sends the reader to fix something that is not in play.
 *
 * `unknown` is not a fallback to guess from: it means the client could not be read, and the message
 * for it deliberately asserts nothing about which credential is in use.
 */
type VertexAuthMode = 'apiKey' | 'serviceAccount' | 'adc' | 'unknown';

/**
 * Read the credential in use off the CONSTRUCTED client, mirroring the same precedence its own
 * request path applies: an API key wins, then service-account credentials, then ADC. Determined from
 * the client rather than from config, because the same config shape can produce different
 * credentials depending on the environment — which is the whole reason this hint was wrong before.
 *
 * Never throws: this runs while formatting somebody's error, and losing the original message to a
 * secondary failure would be worse than a less specific hint.
 */
function vertexAuthMode(llm: unknown): VertexAuthMode {
  try {
    const client = (
      llm as {
        apiClient?: { hasApiKey?: () => boolean; credentials?: unknown; googleAuth?: unknown };
      }
    )?.apiClient;
    if (!client) {
      return 'unknown';
    }
    if (typeof client.hasApiKey === 'function' && client.hasApiKey()) {
      return 'apiKey';
    }
    if (client.credentials !== undefined) {
      return 'serviceAccount';
    }
    if (client.googleAuth !== undefined) {
      return 'adc';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The remedy sentences, one per credential. Each is true for every session that reaches it and names
 * only things that session can actually change.
 *
 * The API-key branch covers two setups that are indistinguishable on the constructed client — an
 * `apiKey` in the `llm` block, and a `.gsloth.config.mjs` that builds `ChatGoogle` itself and picks
 * up `GOOGLE_API_KEY` from the environment — so it names both sources rather than asserting one.
 */
const VERTEX_AUTH_GUIDANCE: Record<VertexAuthMode, string> = {
  apiKey:
    'This session is authenticating with an API key (Vertex AI express mode), not with ' +
    'Application Default Credentials, so `gcloud auth` will not change it. ' +
    'The key is the `apiKey` in your `llm` block — or, if your `.gsloth.config.mjs` constructs ' +
    '`ChatGoogle` itself and so bypasses the preset, `GOOGLE_API_KEY` from your environment. ' +
    'A Google AI Studio key is not valid for Vertex AI endpoints: use a Vertex AI express-mode ' +
    'key, or remove the key to fall back to ADC.',
  serviceAccount:
    'This session is authenticating with a Google Cloud service account — from `credentials` in ' +
    'your `llm` block, or `GOOGLE_CLOUD_CREDENTIALS` in your environment — not with Application ' +
    'Default Credentials, so `gcloud auth` will not change it. ' +
    'Check that the service-account key is still valid and that it may use the Vertex AI API in ' +
    'this project.',
  adc:
    'This session authenticates through Application Default Credentials: run `gcloud auth login` ' +
    'and `gcloud auth application-default login`. ' +
    'No API key is in use — a `type: vertexai` config ignores any `GOOGLE_API_KEY` in your ' +
    'environment, so unsetting that will not help here.',
  unknown:
    'Vertex AI accepts three credentials and only one is in use per session: Application Default ' +
    'Credentials (`gcloud auth application-default login`), a service account (`credentials` or ' +
    '`GOOGLE_CLOUD_CREDENTIALS`), or an express-mode API key (`apiKey` in the `llm` block). ' +
    'Check the one this session is configured for — a Google AI Studio key is not valid for ' +
    'Vertex AI endpoints.',
};

/**
 * The longest value still treated as a filesystem path. 260 is Windows' classic `MAX_PATH`, which is
 * a defensible ceiling for a path and sits an order of magnitude below any credential: the deepest
 * realistic ADC path — a CI runner's temp directory plus
 * `application_default_credentials.json` — is around 120 characters, while a service-account key is
 * ~1700 as JSON and ~2300 base64-encoded. Nothing has to land in the gap for the test to be useful.
 */
const MAX_CREDENTIAL_PATH_LENGTH = 260;

/**
 * Whether a value is the credential ITSELF rather than a path to one.
 *
 * Deliberately tested by SIZE first rather than by shape. The shape test alone (`{`) catches a
 * pasted JSON key and misses the base64 form that CI secret stores hand out, and widening it one
 * encoding at a time only ever covers the last spelling somebody thought of — the value is
 * attacker-irrelevant but user-supplied and its formats are open-ended. Length closes the class
 * because every credential is enormous next to every path. The shape test is kept alongside it for
 * the short, hand-trimmed JSON that a size test alone would let through.
 */
function isCredentialContent(value: string): boolean {
  return value.length > MAX_CREDENTIAL_PATH_LENGTH || value.trimStart().startsWith('{');
}

/**
 * Where an ADC session's credentials are being read from when an environment variable names a file,
 * and the spelling of the variable that named it — `undefined` when no such variable is in play.
 *
 * THIS IS THE ONE ENVIRONMENT READ IN THIS FILE AND IT IS DELIBERATE, so read it against the
 * comment on {@link vertexAuthMode} rather than as a contradiction of it. That function decides
 * WHICH credential is in use and must keep doing so from the constructed client alone. This one
 * decides nothing: the session has already been classified as ADC from the client, and the
 * environment is consulted only to compose the DIAGNOSTIC SENTENCE for it. Read-only, through the
 * `systemUtils` accessor like every other environment read in this package.
 *
 * It is not client-derived because there is nothing client-derived to be had. Measured on
 * google-auth-library 10.9.1: `GoogleAuth.keyFilename` is populated only from constructor options,
 * so on a Vertex client it is `undefined` both with and without the variable set, and stays
 * `undefined` after a resolution attempt. The only artifact a successful resolution leaves behind is
 * `jsonContent` — the parsed key file, which holds the private key and must never be printed.
 *
 * Mirrors `googleauth.js` rather than reinventing it: both spellings, upper case first, and an empty
 * value falls through to the well-known file instead of counting as set.
 */
function adcCredentialFileFromEnvironment(): { variable: string; path: string } | undefined {
  for (const variable of ['GOOGLE_APPLICATION_CREDENTIALS', 'google_application_credentials']) {
    const path = env[variable];
    if (!path) {
      continue;
    }
    // First non-empty wins, exactly as the library's `||` does — so a value that is credential
    // CONTENT rather than a path ends the search rather than falling through to the other spelling.
    //
    // Pasting the service-account key into the variable instead of writing it to a file is a common
    // CI misconfiguration, and such a session must NOT be described below. There is no file for the
    // message to point at, so naming one would be exactly the kind of claim-that-does-not-hold this
    // hint exists to avoid; and the value is a private key, while this message also reaches the log
    // stream and debug dumps. It falls back to the pinned `adc` sentence, which asserts nothing
    // about where the credentials came from.
    return isCredentialContent(path) ? undefined : { variable, path };
  }
  return undefined;
}

/**
 * The remedy for an ADC session whose credentials come from a file named in the environment.
 *
 * The diagnosis is the same as the plain `adc` one and is CORRECT — this really is ADC. What
 * differs is that the plain remedy is inert here: `google-auth-library` resolves this variable
 * before it reads the well-known file, so `gcloud auth application-default login` writes a file
 * this session never opens, reports success, and leaves the failure exactly where it was. Naming
 * the command anyway is the point — the reader has usually just run it.
 */
function adcFromEnvironmentGuidance(variable: string, path: string): string {
  return (
    'This session authenticates through Application Default Credentials, and those credentials ' +
    'come from `' +
    variable +
    '` in your environment, which points at `' +
    path +
    '`. That variable is resolved BEFORE the well-known credentials file, so ' +
    '`gcloud auth application-default login` writes a file this session never reads and the ' +
    'failure survives it. Repair or replace the credentials in the file above, or unset ' +
    '`' +
    variable +
    '` so the well-known Application Default Credentials file is used instead. ' +
    'No API key is in use — a `type: vertexai` config ignores any `GOOGLE_API_KEY` in your ' +
    'environment, so unsetting that will not help here.'
  );
}

/**
 * The sentence for a classified session. Only the ADC branch is refined further, and only into the
 * one sub-case whose remedy would otherwise be inert; every other mode returns its pinned string
 * unchanged.
 */
function vertexAuthGuidance(mode: VertexAuthMode): string {
  if (mode === 'adc') {
    const fromEnvironment = adcCredentialFileFromEnvironment();
    if (fromEnvironment) {
      return adcFromEnvironmentGuidance(fromEnvironment.variable, fromEnvironment.path);
    }
  }
  return VERTEX_AUTH_GUIDANCE[mode];
}

export function enhanceVertexUnauthorizedMessage(originalMessage: string, llm: unknown): string {
  if (!isVertexGoogleLlm(llm) || !VERTEX_AUTH_ERROR_PATTERN.test(originalMessage)) {
    return originalMessage;
  }

  return (
    `${originalMessage}\n\n` +
    'Vertex AI authentication failed. ' +
    `${vertexAuthGuidance(vertexAuthMode(llm))}\n`
  );
}
