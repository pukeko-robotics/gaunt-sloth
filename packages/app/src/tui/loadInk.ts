/**
 * Probe whether the optional Ink + React deps are installed. They are declared as
 * `optionalDependencies`, so a headless / minimal install may legitimately lack them; in
 * that case the session degrades to readline rather than crashing. The probe is cached and
 * only ever called once the cheap environment gates (TTY/flags) already favour the TUI, so
 * we don't pull React/Ink into runs that will never render them.
 */
let cached: boolean | undefined;

export async function isInkAvailable(): Promise<boolean> {
  if (cached !== undefined) return cached;
  try {
    await import('ink');
    await import('react');
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
