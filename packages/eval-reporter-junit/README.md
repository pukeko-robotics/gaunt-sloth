# @gaunt-sloth/eval-reporter-junit

JUnit XML reporter for `gth eval` — the first member of the `@gaunt-sloth/eval-reporter-*`
plugin family.

## Show eval results in your CI server

You want your CI server (TeamCity, Jenkins, GitLab, …) to display a `gth eval` run as test
results. This reporter writes an Ant-JUnit-flavored `results.xml` (one `<testcase>` per
`case × identity` cell) alongside the always-on `results.json`, consumable by TeamCity's XML
Report Processing and generic JUnit readers.

It ships with the CLI — `gaunt-sloth` depends on it, so there is nothing extra to install:

```bash
npm install -g gaunt-sloth@alpha
gth eval prompts.eval.yaml --reporter junit
```

`results.xml` is written into the eval output directory (`-o <dir>` to choose it). When you run
many suites at once (files or a directory), each suite writes its own
`<output>/<suite-name>/results.xml`, so a CI glob like `eval/out/**/*.xml` collects them all.
Failure bodies keep multi-line judge rationale and assertion reasons; ANSI escapes and other
XML-1.0-invalid control bytes are stripped, so strict libxml2-based readers accept the file.

See the [`gth eval` docs](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/COMMANDS.md)
for suites, judges, and the three-way exit-code contract.

## As a reference for writing your own reporter

The package implements the public `EvalReporter` contract exported by
[`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) and the CLI registers it
through the same seam a config-declared reporter uses (`reporters` in `.gsloth.config.*`, mapping
a name to a module whose default export is `() => EvalReporter`) — so this package doubles as the
reference proof that the plug-in contract works from outside core:

```js
import { createJUnitReporter, JUNIT_REPORTER_NAME } from '@gaunt-sloth/eval-reporter-junit';
```

This package is versioned independently of the synced `@gaunt-sloth/*` set: its version moves
only when the reporter itself changes.

## Related packages

- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — the batch / eval /
  workflow runtime that defines the reporter contract
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
