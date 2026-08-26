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

export function enhanceVertexUnauthorizedMessage(originalMessage: string, llm: unknown): string {
  if (!isVertexGoogleLlm(llm) || !VERTEX_AUTH_ERROR_PATTERN.test(originalMessage)) {
    return originalMessage;
  }

  return (
    `${originalMessage}\n\n` +
    'Vertex AI authentication failed. ' +
    'If you use ADC, run `gcloud auth login` and `gcloud auth application-default login`. ' +
    'A `type: vertexai` config authenticates through ADC and ignores any `GOOGLE_API_KEY` in ' +
    'your environment, so unsetting that will not help here. ' +
    'It does still apply to a `.gsloth.config.mjs` that constructs `ChatGoogle` itself, which ' +
    'bypasses the preset: there an exported Google AI Studio key takes over the request, and ' +
    'AI Studio keys are not valid for Vertex AI endpoints.\n'
  );
}
