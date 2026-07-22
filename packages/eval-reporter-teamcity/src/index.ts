/**
 * @packageDocumentation
 * `@gaunt-sloth/eval-reporter-teamcity` — a LIVE TeamCity reporter for `gth eval`, the second member
 * of the `@gaunt-sloth/eval-reporter-*` plugin family. It implements the public {@link EvalReporter}
 * contract exported by `@gaunt-sloth/batch` and is registered by the CLI through the SAME `custom`
 * reporter seam a user's own reporter uses.
 *
 * Instead of writing an XML artifact (the JUnit reporter's job), it interleaves `##teamcity[...]`
 * service messages into the build log as the run progresses, so a TeamCity build shows per-cell
 * pass/fail live — with zero artifact-path wiring.
 */
export { createTeamCityReporter, escapeTeamCity } from '#src/teamcityReporter.js';
export type { TeamCityWrite } from '#src/teamcityReporter.js';

/** The name the CLI (and a user's config) selects this reporter under: `--reporter teamcity`. */
export const TEAMCITY_REPORTER_NAME = 'teamcity';
