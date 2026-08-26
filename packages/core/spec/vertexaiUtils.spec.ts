import { describe, expect, it } from 'vitest';
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

  it('scopes the AI Studio caveat to the hand-built client instead of stating it flatly (CFG-58)', () => {
    const enhanced = enhanceVertexUnauthorizedMessage('Got 401 from endpoint', vertexLlm);

    // A `type: vertexai` config demotes the ambient key, so telling that user to unset
    // GOOGLE_API_KEY sends them after a cause the preset already rules out.
    expect(enhanced).toMatch(/ignores any `?GOOGLE_API_KEY/);
    expect(enhanced).not.toMatch(/make sure `?GOOGLE_API_KEY`? is unset/);
    // The caveat is still TRUE for a .gsloth.config.mjs that builds ChatGoogle directly and
    // bypasses the preset, so it is reworded rather than dropped — named with its condition.
    expect(enhanced).toContain('.gsloth.config.mjs');
    expect(enhanced).toMatch(/Google AI Studio key/);
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
