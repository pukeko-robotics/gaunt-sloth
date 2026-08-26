# Testing map

Every way this repository is tested, in one place: what each entry point covers, how to run it, what
it costs, and what it gates. Two questions this answers, in this order — **where does my test go**,
and **how do I run it**.

Add a new entry point here in the same change that adds it. A suite nobody can find is a suite
nobody runs.

## At a glance

| Entry point | Covers | Costs | Gates |
|---|---|---|---|
| `pnpm test` | the unit suite, after a build | nothing | **every merge** — and the release |
| `pnpm run lint` | ESLint over the whole repo, warnings included | nothing | **every merge** |
| `pnpm run docs:check` | the rendered docs site | nothing | **every merge** |
| `pnpm run it <provider>` | the CLI end to end against a real model | that provider's key, real calls | nothing by hand; the release runs it |
| `pnpm run it ollama xx-small` | the whole agent against a local model | a local GPU | nothing; run it before an agent-runtime merge |
| `pnpm run it-tui` | the terminal UI in a real pseudo-terminal | nothing | **a TUI merge**, and the release |
| `pnpm run test:embed` | the published packages as a consumer sees them | an npm install | nothing |
| `evals/configs/` | one tool call, across providers | provider keys, real calls | **the release** |
| `evals/self/` | gth's own behaviour, graded by `gth eval` | real calls; one sweep needs a local GPU | nothing |
| `evals/{mcp-authz,adk,ag-ui}/` | a live SUT, graded by `gth eval` | real calls | nothing |

Everything in the bottom five rows is run **by hand, on purpose**. They cost real model calls, and a
gate people wait for is a gate people bypass.

## Unit tests — `pnpm test`

```bash
pnpm test          # builds, then runs the unit suite
pnpm run unit      # the suite alone, on whatever is already built
```

`vitest.config.ts` collects `packages/*/spec/**`. Put a unit test beside the package it tests, in
that package's `spec/`.

**Build first.** Several specs spawn the built CLI as a real process, and `pnpm install` runs a
no-op `prepare`, so `dist/` does not exist on a fresh checkout. `pnpm test` builds; the bare
`pnpm run unit` does not, and on an unbuilt tree those specs fail as exit-code mismatches that read
like a code regression.

Needs no key, no network and no GPU, which is why this is the suite everything else defers to.

**In CI:** `unit-tests.yml`, on every push to `main` and dispatchable against any branch. Five cells
— lint + `pnpm test` + `docs:check` on ubuntu, then `pnpm test` on {macOS, Windows} × node {24.x,
latest}. **A local run cannot stand in for the Windows cells**: path separators, `os.homedir()` and
line endings all differ there, and the recurring failure is a spec comparing a hardcoded POSIX path
against a value production builds with `resolve()`.

```bash
gh workflow run unit-tests.yml --ref <branch>
```

## Lint and formatting — `pnpm run lint`

```bash
pnpm run lint          # ESLint, --max-warnings 0
pnpm run lint-n-fix    # the same, fixing what it can
pnpm run format        # Prettier over js/mjs/ts/tsx
```

`--max-warnings 0` is what makes a warn-severity rule mean anything; without it ESLint exits 0 with
warnings reported and every such rule is decorative. `eslint.config.js` and `.prettierignore` are
kept in step: whatever only one of them sees drifts back out of format.

## Docs render — `pnpm run docs:check`

Renders the TypeDoc site and fails on the render's own errors, on a link to a page that does not
exist, on a broken anchor, and on an output tree this run did not write. Needs a build first, for
the same reason the unit suite does. `pnpm run typedoc` alone exits 0 with hundreds of warnings and
proves nothing.

## Integration tests — `pnpm run it <provider>`

```bash
pnpm run it vertexai                    # everything, ~10 minutes
pnpm run it vertexai review             # only files whose name contains `review`
pnpm run it vertexai xx-small           # the fast tier
pnpm run it ollama xx-small             # the local real-model gate
```

`it.js` builds, then runs `packages/*/integration-tests/**/*.it.ts` through `vitest-it.config.ts`,
spawning **this checkout's** CLI — never a globally installed one. Put an end-to-end test here when
you change command flows, provider integration or output contracts.

Every case costs real model calls against the provider you name, and needs that provider's key in
the environment.

**`pnpm run it ollama xx-small` is the local whole-agent gate.** Run it before merging a change to
the agent runtime, the provider layer or the CLI verbs — it catches regressions no unit test can see,
because a fake runner never reaches the provider. It needs a local GPU and a running ollama daemon,
and **skips with exit 0** when ollama is absent, so it is safe to run anywhere. **Warm the model
first** (`ollama run <model> hi`); a cold first call reliably times out and reads as a failure.

**In CI:** the `integration-tests*.yml` workflows are dispatch-only, and the release runs the small
tier across providers plus a full run on the primary one.

## TUI end-to-end — `pnpm run it-tui`

```bash
pnpm run it-tui
```

Drives the real `gth chat --tui` binary inside a pseudo-terminal (`@microsoft/tui-test`), fed by a
deterministic fixture agent. Cells live in `packages/app/tui-e2e/` and cover both the Ink TUI and the
plain readline surface. **Hermetic and key-free** — no model, no network — and it catches rendering,
input and slash-command regressions the unit suite cannot, such as a notice whose exact wording
nothing else asserts.

**Run it through the script.** `node packages/app/run-tui-e2e.js` does not build, so it silently
tests the previous `dist/` and fails in the reassuring direction.

**The trigger is the set of files that ASSERT on your change, not the set you edited.** Grep the full
path `packages/app/tui-e2e/` — there is no `tui-e2e/` at the repository root, so a search rooted
there matches nothing and looks exactly like the suite not caring.

**In CI:** `tui-e2e.yml`, on every push to `main`, over ubuntu + macOS + Windows, and a release gate.
Windows is a first-class cell and can only be proven by the CI run.

```bash
gh workflow run tui-e2e.yml --ref <branch>
```

## Embed end-to-end — `pnpm run test:embed`

Packs the publishable tarballs, installs them into a temporary consumer **outside** the workspace,
and exercises the documented embed surface (`packages/review/embed-e2e/`). Deliberately kept out of
the unit run: pack plus install takes far longer than the unit suite's timeout budget. Needs network
for the install. Not in CI — run it by hand when you change what the packages export.

## Evals

`gth eval` is a product surface, and `evals/` is where we point it at ourselves. See
[`evals/README.md`](evals/README.md) for the layout and for how to add a bed.

Everything under `evals/` is run **by hand** and makes **real model calls**. Nothing there is wired
into `pnpm run it` or into a per-merge gate. The one exception is the pre-release smoke subset below.

### `evals/configs/` — cross-provider tool-call smoke

One judge-free case: read a planted marker file through the agent's tools and report the string back.
That proves the two things a release needs proven — the agent made a **real tool call**, and it
**synthesized the tool result**. `must_contain` only, so no grader model can be the thing that flakes.

```bash
node packages/app/cli.js eval evals/configs/configs-smoke-test-ci.suite.yaml -o eval-out
```

Run these **from the repository root**: the prompt names the marker file by its repository-relative
path, and the agent reads it from the working directory the run starts in.

Each suite's `identities:` list names profiles that must exist as
`.gsloth/.gsloth-settings/<name>/.gsloth.config.json`. A named identity with no profile is a hard
error before any case runs, and no cell is graded.

- `configs-smoke-test-ci.suite.yaml` — two cheap identities, the default of the `evals.yml` workflow
  and **the pre-release gate**: `release.yml` cannot publish unless it is green.
- `configs-smoke-test.suite.yaml` — the full cross-provider matrix. Local only; its ollama cells need
  a GPU no runner has.
- `configs-vertex-smoke-test.suite.yaml` — the Vertex identities, kept separate because they authenticate
  differently.

**In CI:** `evals.yml`, dispatch-only plus the release call. It holds more provider keys than any
other job in this repository, which is why it is never triggered by `pull_request_target`.

```bash
gh workflow run evals.yml --ref <branch>                      # the default subset
gh workflow run evals.yml --ref <branch> -f suite=<path>      # any CI-runnable suite
```

### `evals/self/` — suites that grade gth's own behaviour

Point `gth eval` at Gaunt Sloth rather than at a user's agent. Run by hand; some sweeps include a
local ollama identity and so need a GPU. See [`evals/self/README.md`](evals/self/README.md).

### `evals/mcp-authz/`, `evals/adk/`, `evals/ag-ui/` — the live beds

Each stands a real system under test up, grades it through `gth eval`, and tears it down:

| Bed | System under test | Needs |
|---|---|---|
| `mcp-authz` | a real HTTP MCP server with per-identity bearer authorization | `ANTHROPIC_API_KEY` |
| `adk` | a real Python `google-adk` agent over A2A | `GOOGLE_API_KEY`, python3 |
| `ag-ui` | gth's own `gth api ag-ui` server | `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` |

```bash
evals/mcp-authz/run.sh              # the passing suite -> exit 0
evals/mcp-authz/run.sh --broken     # the discrimination proof -> exit 1
```

**A bed is only proven by running both.** The passing suite says the machinery works; the `--broken`
suite exits 1 and is what says the passing run could have gone red. Report a bed as verified only
when you have seen both.

## When a gate goes red

Fix it. A failure that predates your branch decides *who* fixes it, never *whether* the branch may be
red. Never skip, delete, loosen or `eslint-disable` a check to get to green — if the cause is
unclear or the fix would change what a test asserts, stop and say so with the exact command and its
output.
