# Review code and pull requests

Gaunt Sloth reviews are **stateless** — nothing carries over between runs, so a verdict can't be
argued down across a conversation — and a failing review **exits non-zero**. That combination is
what makes `gth` usable as an on-prem review gate: run it in CI, and a bad diff fails the job the
same way a failing test would.

## The main use case: gate every pull request in CI

Goal: every PR gets reviewed automatically against its linked issue, and the result blocks the
merge if the review fails.

In your CI job, after checking out the PR branch:

```bash
export ANTHROPIC_API_KEY="${{ secrets.ANTHROPIC_API_KEY }}"
gth pr 42
```

`gth pr 42` fetches PR #42's diff with the GitHub CLI (`gh`), finds the issue linked in the PR
description, and reviews the diff against that issue as the requirements. If the review fails, the
command exits non-zero and the CI step fails.

Two prerequisites for `gth pr`:

- the GitHub CLI (`gh`) is installed and authenticated (in CI, `gh` picks up `GH_TOKEN`);
- the provider key is exported, exactly as in the [Quickstart](../quickstart.md).

Run with no arguments — `gth pr` — and it discovers the current branch's PR and its requirements
for you, which is handy in a job that already knows its own branch.

When a large PR's diff comes back truncated, the reviewer can pull a whole changed file from the
PR's own repository over the GitHub API rather than review a hunk blind — the `gth_gh_read_file`
built-in tool, on by default for `gth pr` and using the same `gh` login. Turn it off, or cap how
much one call may return, through
[`builtInTools`](../configuration/tools.md#github-file-reads-during-a-pr-review-gth_gh_read_file).
(It follows the content source: `gth review` gets it too whenever that run's content source is
`github`, whether your config sets it or you pass `--content-source github` for the one run.)

## Review a local diff before you push

You don't need a PR to review. Pipe any diff in:

```bash
git --no-pager diff | gth review
```

Or let the `git` content source run the diff for you:

```bash
gth review --content-source git
```

Add requirements to check against, and focus the reviewer:

```bash
gth review --content-source git -r requirements.md -m "focus on security implications"
```

## What a review is labelled with

By default, every `review` and `pr` run opens its output with a fixed heading and one attribution
line:

```text
## Gaunt Sloth: Code Review

stateless review · gemini-3.1-pro-preview (google-genai)
```

That comes from the CLI itself, so it reaches everywhere the output goes — your terminal, the
[`writeOutputToFile`](../configuration/output.md#controlling-output-files) report, and any pull
request comment a workflow posts from that file — with nothing to wire up. A review is usually read
somewhere the command that produced it is not visible, and an unlabelled AI review sitting under a
bot avatar gets credited to whichever AI reviewer the reader already knows.

The heading is the same string on every run. The line under it names the review mode and the model
that served it. The provider half is dropped when a JS config hands Gaunt Sloth an already-built
model, because there is then no provider name to report; the model is dropped altogether when none
resolves, leaving `stateless review` on its own rather than a placeholder.

The heading belongs to the review document rather than to the technical run header, so
[`output.header: "compact"`](../configuration/output.md#run-header-outputheader) keeps it while
dropping the Workdir/Model/Tools preamble — on a review, this block *is* the compact header. Only
`output.header: "none"` removes it, for a caller who is piping the review into a template of their
own; set that deliberately, because a review posted without it is a review nobody can attribute.

## Examples

```bash
# Review PR #42 with GitHub issue #23 as the requirements
gth pr 42 23

# Review PR #42 against a Jira issue instead
gth pr 42 PROJ-123 -p jira

# Review a specific commit range (no pipe) via the git content source
gth review origin/main...feature-branch --content-source git

# Review the working diff with a requirements file
git --no-pager diff | gth review -r requirements.md
```

## Related

- Pull requirements from a GitHub issue or Jira automatically:
  [Content sources](../configuration/content-sources.md).
- Every `review` / `pr` flag: [Commands](../COMMANDS.md#pr).
- Run the review under a cheaper model than your coding model:
  [Choose & switch models](choose-and-switch-models.md).
