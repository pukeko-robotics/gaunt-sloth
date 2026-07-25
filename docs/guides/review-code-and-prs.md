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
