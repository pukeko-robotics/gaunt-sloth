/**
 * @packageDocumentation
 * `@gaunt-sloth/eval-reporter-junit` — a JUnit XML reporter for `gth eval`, the first member of the
 * `@gaunt-sloth/eval-reporter-*` plugin family. It implements the public {@link EvalReporter}
 * contract exported by `@gaunt-sloth/batch` and is registered by the CLI through the SAME `custom`
 * reporter seam a user's own reporter uses — so this package doubles as the reference proof that the
 * plug-in contract works from outside core.
 *
 * It writes an Ant-JUnit-flavored `results.xml` (one `<testcase>` per cell) alongside the always-on
 * `results.json`, consumable by TeamCity's XML Report Processing and generic JUnit readers.
 */
export { createJUnitReporter } from '#src/junitReporter.js';

/** The name the CLI (and a user's config) selects this reporter under: `--reporter junit`. */
export const JUNIT_REPORTER_NAME = 'junit';
