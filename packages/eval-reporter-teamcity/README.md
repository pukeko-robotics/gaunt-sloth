# @gaunt-sloth/eval-reporter-teamcity

Live TeamCity reporter for `gth eval` — the second member of the `@gaunt-sloth/eval-reporter-*`
plugin family.

## Show eval results live in a TeamCity build

You want a TeamCity build to display a `gth eval` run as tests, updating **live** as each case
finishes. This reporter interleaves TeamCity
[service messages](https://www.jetbrains.com/help/teamcity/service-messages.html)
(`##teamcity[testStarted ...]`, `##teamcity[testFailed ...]`, …) into the build log — one test per
`case × identity` cell — so TeamCity picks the results up straight from stdout, with **zero
artifact-path wiring** (no XML Report Processing build feature needed). Failure messages carry the
assertion/judge reasons, fully escaped, so a reason containing `'`, `[`, `]`, `|`, or newlines never
corrupts the message stream.

It ships with the CLI — `gaunt-sloth` depends on it, so there is nothing extra to install:

```bash
npm install -g gaunt-sloth@alpha
gth eval prompts.eval.yaml --reporter teamcity
```

`--reporter` replaces the default set, so pass `--reporter text,teamcity` to keep the console
summary alongside the service messages. The always-on `results.json` + per-cell JSON are written
regardless. Prefer a single end-of-run XML artifact instead? Use the sibling
[`@gaunt-sloth/eval-reporter-junit`](https://www.npmjs.com/package/@gaunt-sloth/eval-reporter-junit)
reporter.

See the [`gth eval` docs](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/COMMANDS.md)
for suites, judges, and the three-way exit-code contract.

## As a reference for writing your own reporter

The package implements the public `EvalReporter` contract exported by
[`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) and the CLI registers it
through the same seam a config-declared reporter uses (`reporters` in `.gsloth.config.*`, mapping
a name to a module whose default export is `() => EvalReporter`) — a live, streaming counterpart to
the artifact-writing JUnit reporter:

```js
import { createTeamCityReporter, TEAMCITY_REPORTER_NAME } from '@gaunt-sloth/eval-reporter-teamcity';
```

`createTeamCityReporter(write?)` takes an optional sink (defaults to `process.stdout.write` — stdout
is the TeamCity build-log channel), which is how its own unit tests capture the emitted stream.

This package is versioned independently of the synced `@gaunt-sloth/*` set: its version moves
only when the reporter itself changes.

## Related packages

- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — the batch / eval /
  workflow runtime that defines the reporter contract
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`@gaunt-sloth/eval-reporter-junit`](https://www.npmjs.com/package/@gaunt-sloth/eval-reporter-junit)
  — the JUnit XML (artifact) reporter
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/eval-reporter-junit))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
