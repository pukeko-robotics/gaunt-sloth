/**
 * @module modelLabel
 * The ONE spelling of "which model served this run", on its own so every surface can reach it.
 *
 * It is a leaf with **no imports at all**, and that is the point: the agent emits the compact run
 * header from `GthAbstractAgent`, and pulling in the launch banner — which reaches console and
 * filesystem helpers — just to format two strings would drag that graph into the agent's module
 * load. A second local `${model} (${provider})` would avoid the import and is exactly what must not
 * happen (DL-6): that is how one surface ends up saying `google-genai:gemini` where its neighbour
 * says `gemini (google-genai)`.
 */

/**
 * Build the model/provider label: `model (provider)` when both resolve, the one that resolved when
 * only one does, and nothing at all when neither does — an empty `()` would look like a bug.
 *
 * Its three renderings today are the launch banner, the review document's attribution line, and the
 * `compact` run header.
 */
export function modelProviderLabel(model?: string, provider?: string): string | undefined {
  const m = model?.trim();
  const p = provider?.trim();
  if (m && p) return `${m} (${p})`;
  return m || p || undefined;
}
