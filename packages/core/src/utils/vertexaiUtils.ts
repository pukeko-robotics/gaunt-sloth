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

export function enhanceVertexUnauthorizedMessage(originalMessage: string, llm: unknown): string {
  if (!isVertexGoogleLlm(llm) || !VERTEX_AUTH_ERROR_PATTERN.test(originalMessage)) {
    return originalMessage;
  }

  return (
    `${originalMessage}\n\n` +
    'Vertex AI authentication failed. ' +
    `${VERTEX_AUTH_GUIDANCE[vertexAuthMode(llm)]}\n`
  );
}
