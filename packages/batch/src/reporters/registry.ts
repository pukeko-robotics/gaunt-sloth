import type { EvalReporter, EvalReporterFactory } from '#src/reporters/reporterTypes.js';
import { createTextReporter } from '#src/reporters/textReporter.js';

/** The built-in reporters, keyed by the name a user (later, A2) selects with `--reporter`. A1 ships
 * only `text` (the former `printSummary`); A2 adds a JUnit reporter and a custom-reporter map. */
const BUILTIN_REPORTERS: Record<string, EvalReporterFactory> = { text: createTextReporter };

/** Resolve reporter names to instances. `custom` (A2) overlays/extends the built-ins; a name found
 * in neither throws with the available list (the command maps that to exit 2). Built-in and custom
 * reporters resolve through this ONE path — no reporter reaches past it. Reporters are instantiated
 * per call (fresh state per run). */
export function resolveReporters(
  names: string[],
  custom: Record<string, EvalReporterFactory> = {}
): EvalReporter[] {
  const registry: Record<string, EvalReporterFactory> = { ...BUILTIN_REPORTERS, ...custom };
  return names.map((name) => {
    const factory = registry[name];
    if (!factory) {
      throw new Error(
        `unknown reporter "${name}". Available reporters: ${availableReporterNames(custom).join(', ')}`
      );
    }
    return factory();
  });
}

/** The names `resolveReporters` accepts, given the same `custom` map — used to build the error
 * message on an unknown name (and, in A2, to list reporters in help/errors). */
export function availableReporterNames(custom: Record<string, EvalReporterFactory> = {}): string[] {
  return Object.keys({ ...BUILTIN_REPORTERS, ...custom });
}
