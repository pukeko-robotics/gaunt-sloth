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

To review everything your branch will put in its pull request, uncommitted edits included, point
the `git` source at the branch you will merge into:

```json
{
  "commands": { "review": { "contentSource": "git" } },
  "contentSourceConfig": { "git": { "mergeBase": "origin/main" } }
}
```

Then a bare `gth review` diffs your working tree against the commit where the branch left
`origin/main`, so work merged to `origin/main` since then is not reviewed as if you had deleted it.
What the setting accepts, and why untracked files stay out:
[Git (local diffs)](../configuration/content-sources.md#git-local-diffs).

## Review a branch against its Jira issue, locally and in the pull request

Goal: `gth review` on your branch, and `gth pr` on its pull request, both review against the Jira
issue the branch is for, with nobody typing the issue key.

```json
{
  "mcpServers": {
    "jira": {
      "url": "https://mcp.atlassian.com/v1/mcp",
      "authProvider": "OAuth",
      "transport": "http"
    }
  },
  "contentSourceConfig": { "git": { "mergeBase": "origin/main" } },
  "commands": {
    "pr": {
      "contentSource": "github",
      "discovery": {
        "filesystem": "none",
        "builtInTools": [],
        "customTools": false,
        "allowedTools": ["gh_pr", "gh_diff", "mcp__jira__getJiraIssue"]
      }
    },
    "review": {
      "contentSource": "git",
      "filesystem": "read",
      "discovery": {
        "enabled": true,
        "filesystem": "none",
        "builtInTools": [],
        "customTools": false,
        "allowedTools": ["mcp__jira__getJiraIssue"]
      }
    }
  }
}
```

A bare `gth review` then diffs the branch against where it left `origin/main`. With no `-r`, it
collects the branch name and the branch's pull request as evidence, and because Jira is reached
through the MCP server rather than a Jira requirement source, a discovery agent reads the issue key
from that evidence and fetches the issue with `mcp__jira__getJiraIssue`. A bare `gth pr` runs the
same kind of discovery from the pull request. Each discovery agent gets only the tools in its own
`allowedTools` and no filesystem access, so it looks up the issue and nothing else. The first run
opens a browser for the Atlassian sign-in.
Every discovery key: [Review Requirements Discovery Configuration](../configuration/content-sources.md#review-requirements-discovery-configuration).

## What a review is labelled with

By default, every `review` and `pr` run opens its output with one line — the same run header every
Gaunt Sloth command opens with, naming the command you ran and the model that served it:

```text
Gaunt Sloth · review · gemini-3.1-pro-preview (google-genai)
```

A `gth pr` run says `pr`. That comes from the CLI itself, so it reaches everywhere the output goes —
your terminal, the [`writeOutputToFile`](../configuration/output.md#controlling-output-files)
report, and any pull request comment a workflow posts from that file — with nothing to wire up. A
review is usually read somewhere the command that produced it is not visible, and an unlabelled AI
review sitting under a bot avatar gets credited to whichever AI reviewer the reader already knows.

The provider half is dropped when a JS config hands Gaunt Sloth an already-built model, because
there is then no provider name to report; the model is dropped altogether when none resolves,
leaving the line ending at the command rather than showing a placeholder.

A run that fails before the model is reached — a pull request over GitHub's 300-file diff limit, no
`gh` on the path — writes that report as well, headed the same way, with the error in it in place of
a verdict. The run still exits `1`, so a workflow fails on the review step; what changes is that the
comment it posts names the failure instead of the next step dying on a file that is not there.

The header belongs to the review document rather than to the technical preamble, so the default
[`output.header: "compact"`](../configuration/output.md#run-header-outputheader) keeps it while
dropping the Workdir/Model/Tools lines — on a review, this line *is* the compact header. Only
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
- Attach a package's own guidelines only when the diff touches it, instead of one guidelines file for
  the whole repository: [Path-scoped prompts](../configuration/prompts.md#path-scoped-prompts).
