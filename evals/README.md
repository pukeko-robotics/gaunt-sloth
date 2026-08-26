# `evals/`

Everything that points `gth eval` at something, in one tree. For where these sit among the
repository's other test entry points, see [TESTING.md](../TESTING.md).

```
evals/
├── harness/run-bed.sh   # the one lifecycle every live bed runs through
├── configs/             # cross-provider tool-call smoke suites (one is the pre-release gate)
├── self/                # suites that grade gth's own behaviour
├── mcp-authz/           # live bed: a real HTTP MCP server with per-identity authorization
├── adk/                 # live bed: a real Python google-adk agent over A2A
└── ag-ui/               # live bed: gth's own `gth api ag-ui` server
```

Nothing here is published, nothing is part of the root `pnpm build`, and nothing is wired into
`pnpm run it`. **These make real model calls and are run by hand.** That is deliberate: the only
suite on a merge or release path is the small subset named in [TESTING.md](../TESTING.md).

## The live beds

A **bed** is a system under test plus a `workdir/` of suites to grade it with. The three beds differ
only in what they stand up, so the lifecycle — build the CLI, start the system under test, wait for
it to answer, run `gth eval` from the workdir under a hermetic `HOME`, tear the system down,
propagate the eval's own exit code — lives once in `harness/run-bed.sh`. A bed contributes a
`bed.conf` and a two-line `run.sh`.

```bash
evals/<bed>/run.sh              # the passing suite
evals/<bed>/run.sh --broken     # the discrimination proof; exits 1
evals/<bed>/run.sh <suite>      # any other suite in the bed's workdir
SKIP_BUILD=1 evals/<bed>/run.sh # skip the build when you just built
```

**Every bed declares a discrimination suite, and the harness will not start one that does not.** A
suite that cannot fail proves nothing, so the `-broken` suite — which asserts something the system
under test never produces, and therefore exits 1 — is what makes a green run mean anything. It is
checked before anything is built or spawned, and a missing or absent declaration is exit 3 with a
message, never a run with the check quietly switched off.

## Adding a bed

1. Make `evals/<bed>/` with a `workdir/` holding the passing suite, the `-broken` suite and the
   `.gsloth/.gsloth-settings/` configuration they grade under.
2. Write `bed.conf`: the name, both suites, the port and its environment variable, the readiness
   probe, and a `bed_start_sut` function that **`exec`s** the system under test. `exec` is
   load-bearing — the harness backgrounds that function and later kills what it started, so the
   process it waits on must be the system under test rather than a wrapper subshell around it.
   `harness/run-bed.sh` documents every setting and its default.
3. Copy a two-line `run.sh` from a sibling.
4. Write a `README.md` saying what the bed proves, what it needs, and how its `-broken` suite fails.
5. Add it to the table in [TESTING.md](../TESTING.md).

`packages/app/spec/evalBedHarness.spec.ts` picks the new bed up automatically and will fail if it
declares no discrimination suite, names one that is not on disk, points both suites at one file, sets
a key the harness does not read, or grows a lifecycle of its own.
