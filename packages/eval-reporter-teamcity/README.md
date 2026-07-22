# @gaunt-sloth/eval-reporter-teamcity

Live TeamCity reporter for `gth eval` — a member of the `@gaunt-sloth/eval-reporter-*` plugin
family, and the **worked example** for writing your own `gth eval` reporter.

## Show eval results live in a TeamCity build

You want a TeamCity build to display a `gth eval` run as tests, updating **live** as each case
finishes. This reporter interleaves TeamCity
[service messages](https://www.jetbrains.com/help/teamcity/service-messages.html)
(`##teamcity[testStarted ...]`, `##teamcity[testFailed ...]`, …) into the build log — one test per
`case × identity` cell — so TeamCity picks the results up straight from stdout, with **zero
artifact-path wiring** (no XML Report Processing build feature needed). Failure messages carry the
assertion/judge reasons, fully escaped, so a reason containing `'`, `[`, `]`, `|`, or newlines never
corrupts the message stream.

Unlike the built-in `text` and `junit` reporters, this one is **not bundled with the CLI** — install
it in your project and register it in config:

```bash
npm i -D @gaunt-sloth/eval-reporter-teamcity
```

```jsonc
// .gsloth.config.json (or .gsloth.config.js / .mjs)
{
  "reporters": {
    "teamcity": "@gaunt-sloth/eval-reporter-teamcity"
  }
}
```

```bash
gth eval prompts.eval.yaml --reporter text,teamcity
```

The `reporters` map takes an **installed package name** (as above) or a **local module path**
(`"./eval/my-reporter.mjs"`). `--reporter` **replaces** the default set, so pass
`--reporter text,teamcity` to keep the console summary alongside the service messages. The always-on
`results.json` + per-cell JSON are written regardless. Prefer a single end-of-run XML artifact
instead? Use the built-in `junit` reporter (`--reporter junit`), packaged as
[`@gaunt-sloth/eval-reporter-junit`](https://www.npmjs.com/package/@gaunt-sloth/eval-reporter-junit).

See the [`gth eval` docs](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/COMMANDS.md)
for suites, judges, and the three-way exit-code contract.

## Write your own reporter

A reporter is any package (or local module) whose **default export is a factory** — a zero-argument
function returning an [`EvalReporter`](https://www.npmjs.com/package/@gaunt-sloth/batch). This
package is the reference implementation; its
[source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/eval-reporter-teamcity/src)
is small enough to read as a template.

**1. Implement the contract.** `EvalReporter` (exported by
[`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch)) has three **optional**
lifecycle hooks — implement only what you need:

```ts
import type { EvalReporter } from '@gaunt-sloth/batch';

export function createMyReporter(): EvalReporter {
  return {
    onSuiteStart(ctx) {
      /* ctx.suitePath, ctx.outputDir — the run is starting */
    },
    onCellResult(result, ctx) {
      /* one graded cell: result.id, result.identity, result.verdict, result.reasons, … */
    },
    onSuiteEnd(summary, ctx) {
      /* summary.total / passed / failed — write an artifact, print a total, etc. */
    },
  };
}
```

Each hook may be sync or async (`void | Promise<void>`). A reporter **must not be able to fail the
run**: the driver contains any hook error and surfaces it as a warning, and the always-on
`results.json` is written whatever your reporter does.

**2. Default-export the factory.** The `reporters` seam reads `module.default` and calls it once per
run:

```ts
export default createMyReporter;
```

**3. Register it.** Map a name to your reporter in `.gsloth.config.*`, then select that name with
`--reporter`. The value is either an **installed package specifier** or a **local file path**:

```jsonc
{
  "reporters": {
    "my-report": "@my-scope/eval-reporter-foo", // installed package (resolved from your project)
    "local": "./eval/my-reporter.mjs"            // or a project-relative module file
  }
}
```

An installed package is resolved by Node module resolution against **your project's**
`node_modules`, honoring the package's `exports`. (Node resolves it via the `require` condition, so
if you ship conditional `exports`, include a `require`/`default` entry, not `import` only.) A name
that can't be resolved, a module that fails to import, or a default export that isn't a function is a
harness error — `gth eval` exits `2`.

**4. Watch out for output-format escaping.** A reporter that writes into a structured stream must
escape every dynamic string, or a judge/assertion reason can corrupt the output. The JUnit reporter
escapes XML; this reporter escapes TeamCity attribute values — the escape character is `|`, so `|`
itself is escaped first (`|`→`||`), then `'`→`|'`, `[`→`|[`, `]`→`|]`, and newlines→`|n`/`|r`, so a
reason containing any of those never terminates the message or splits it across lines. See
[`escapeTeamCity`](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/packages/eval-reporter-teamcity/src/teamcityReporter.ts)
for the full table. Whatever format you emit, escape reasons the same way.

### Using this reporter as an API

```js
import { createTeamCityReporter, TEAMCITY_REPORTER_NAME } from '@gaunt-sloth/eval-reporter-teamcity';
```

`createTeamCityReporter(write?)` takes an optional sink (defaults to `process.stdout.write` — stdout
is the TeamCity build-log channel), which is how its own unit tests capture the emitted stream. The
package's **default export** is `createTeamCityReporter` itself, so the config `reporters` seam
accepts the bare package name with no shim.

This package is versioned independently of the synced `@gaunt-sloth/*` set: its version moves only
when the reporter itself changes.

## Related packages

- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — the batch / eval /
  workflow runtime that defines the reporter contract
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`@gaunt-sloth/eval-reporter-junit`](https://www.npmjs.com/package/@gaunt-sloth/eval-reporter-junit)
  — the built-in JUnit XML (artifact) reporter
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/eval-reporter-junit))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
