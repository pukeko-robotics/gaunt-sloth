/**
 * CFG-20 — the abort signal shared by the {@link SelectFn} seam.
 *
 * The Ink `runInkSelect` host rejects its promise with this error when the user aborts a
 * selection (Ctrl+C at any time, or Esc with an empty filter), and `runFirstRunDialog`
 * catches it once around the whole flow to abort cleanly — no config written, no false
 * "Configured …" success line. Kept in its OWN tiny, Ink-free module (not in
 * `SelectList.tsx`, which statically imports `ink`) so the dialog can `import` the class
 * for a shared `instanceof` identity without pulling React/Ink into a readline-only run.
 */
export class SelectCancelledError extends Error {
  constructor(message = 'Selection cancelled') {
    super(message);
    this.name = 'SelectCancelledError';
  }
}
