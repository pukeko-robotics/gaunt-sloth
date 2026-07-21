import type { EvalReporterFactory, NamedReporter } from '#src/reporters/reporterTypes.js';
import { createTextReporter } from '#src/reporters/textReporter.js';

/** The built-in reporters, keyed by the name a user (later, A2) selects with `--reporter`. A1 ships
 * only `text` (the former `printSummary`); A2 adds a JUnit reporter and a custom-reporter map. */
const BUILTIN_REPORTERS: Record<string, EvalReporterFactory> = { text: createTextReporter };

/** Resolve reporter names to named instances ({@link NamedReporter}). `custom` (A2 — the bundled
 * JUnit reporter and any config-declared user reporters) overlays/extends the built-ins through this
 * ONE path; a `custom` key colliding with a built-in name wins (config beats built-in). A name found
 * in neither throws with the available list (the command maps that to exit 2). Reporters are
 * instantiated per call (fresh state per run). Each is paired with the name it was selected under so
 * {@link driveReporters} can name a failing reporter in its contained-error warning. */
export function resolveReporters(
  names: string[],
  custom: Record<string, EvalReporterFactory> = {}
): NamedReporter[] {
  const registry: Record<string, EvalReporterFactory> = { ...BUILTIN_REPORTERS, ...custom };
  return names.map((name) => {
    const factory = registry[name];
    if (!factory) {
      throw new Error(
        `unknown reporter "${name}". Available reporters: ${availableReporterNames(custom).join(', ')}`
      );
    }
    return { name, reporter: factory() };
  });
}

/** The names `resolveReporters` accepts, given the same `custom` map — used to build the error
 * message on an unknown name (and, in A2, to list reporters in help/errors). */
export function availableReporterNames(custom: Record<string, EvalReporterFactory> = {}): string[] {
  return Object.keys({ ...BUILTIN_REPORTERS, ...custom });
}
