# Content sources

Goal: review a pull request against the GitHub issue it implements, without pasting the
requirements in by hand.

`gth pr` pulls the change requirements it checks a diff against from a **requirement source**.
Point it at a GitHub issue by passing the issue number after the PR number:

```bash
gth pr 42 23
```

This reviews PR #42 and uses GitHub issue #23 as the requirements. It needs the
[GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated, and access to the
repository's issues. To make GitHub the default so you can drop the per-run provider selection, set
it in your config (see [GitHub Issues](#github-issues) below).

A requirement source can be a GitHub issue, a Jira ticket, or a source the `pr` command
**discovers automatically** when you run it with no arguments. This page is the reference for
configuring each. For the review workflow itself see
[Review code and pull requests](../guides/review-code-and-prs.md) and the
[`pr` command](../COMMANDS.md#pr).

## GitHub Issues

Gaunt Sloth reads a GitHub issue as the requirement source through the GitHub CLI.

**Prerequisites:**

1. **GitHub CLI**: the official [GitHub CLI (gh)](https://cli.github.com/) is installed and
   authenticated
2. **Repository Access**: you have access to the repository's issues

The command syntax is `gth pr <prId> [githubIssueId]`, e.g. `gth pr 42 23` (shown in the lead
above). To force the GitHub provider explicitly:

```bash
gth pr 42 23 -p github
```

To set GitHub as your default requirement source, add this to your configuration file:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "commands": {
    "pr": {
      "requirementSource": "github"
    }
  }
}
```

## JIRA

Gaunt Sloth supports three methods to integrate with JIRA.

### Atlassian MCP

MCP can be used in `chat` and `code` commands. Gaunt Sloth has an OAuth client for MCP and is
confirmed to work with the public Jira MCP.

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro",
    "temperature": 0
  },
  "mcpServers": {
    "jira": {
      "url": "https://mcp.atlassian.com/v1/mcp",
      "authProvider": "OAuth",
      "transport": "http"
    }
  }
}
```

For the OAuth flow, token storage, and TLS trust details, see [MCP](./mcp.md).

### Modern Jira REST API (Scoped Token)

The Jira API is used with the `pr` and `review` commands.

This method uses the Atlassian REST API v3 with a Personal Access Token (PAT). It requires your
Atlassian Cloud ID. It only works with an authenticated Atlassian Cloud instance — anonymous access
to a public Jira instance is not supported.

**Prerequisites:**

1. **Cloud ID**: find it by visiting `https://yourcompany.atlassian.net/_edge/tenant_info` while
   authenticated.

2. **Personal Access Token (PAT)**: create a PAT with the appropriate permissions from
   `Atlassian Account Settings -> Security -> Create and manage API tokens -> [Create API token with scopes]`.
   - For issue access, the recommended permission is `read:jira-work` (classic)
   - Alternatively granular access would require: `read:issue-meta:jira`, `read:issue-security-level:jira`, `read:issue.vote:jira`, `read:issue.changelog:jira`, `read:avatar:jira`, `read:issue:jira`, `read:status:jira`, `read:user:jira`, `read:field-configuration:jira`

Refer to the JIRA API documentation for more details: [https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get)

**Environment Variables Support:**

For better security, you can set Jira credentials using environment variables instead of placing
them in the configuration file. When set, they take precedence over the values in the config file:

- `JIRA_FULL_BASE64_TOKEN`: Full pre-encoded Basic auth payload. When present, Gaunt Sloth uses it as-is and does not require `JIRA_USERNAME` or `JIRA_API_PAT_TOKEN`.
- `JIRA_USERNAME`: Your JIRA username (e.g., `user@yourcompany.com`).
- `JIRA_API_PAT_TOKEN`: Your JIRA Personal Access Token with scopes.
- `JIRA_CLOUD_ID`: Your Atlassian Cloud ID.

JSON:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "jira": {
      "username": "username@yourcompany.com",
      "token": "YOUR_JIRA_PAT_TOKEN",
      "cloudId": "YOUR_ATLASSIAN_CLOUD_ID"
    }
  }
}
```

Optionally `displayUrl` can be defined to have a clickable link in the output:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "jira": {
      "displayUrl": "https://yourcompany.atlassian.net/browse/"
    }
  }
}
```

If your environment already contains a full Base64-encoded Basic token, you can configure only the
Cloud ID and optional display URL, then export `JIRA_FULL_BASE64_TOKEN`; Gaunt Sloth will send
`Authorization: Basic <token>` directly:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "jira": {
      "cloudId": "YOUR_ATLASSIAN_CLOUD_ID",
      "displayUrl": "https://yourcompany.atlassian.net/browse/"
    }
  }
}
```

JavaScript:

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro',
      vertexai: true,
    }),
    requirementSource: 'jira',
    requirementSourceConfig: {
      jira: {
        username: 'username@yourcompany.com', // Your Jira username/email
        token: 'YOUR_JIRA_PAT_TOKEN', // Your Personal Access Token
        cloudId: 'YOUR_ATLASSIAN_CLOUD_ID', // Your Atlassian Cloud ID
      },
    },
  };
}
```

#### Automatic work logging for Jira reviews

When you pass a Jira issue ID to `gth pr` and use the modern Jira provider
(`requirementSource: "jira"`), you can have Gaunt Sloth log review time back to that issue
automatically by setting `commands.pr.logWorkForReviewInSeconds`. The value is recorded as worklog
seconds after each PR review.

```json
{
  "commands": {
    "pr": {
      "requirementSource": "jira",
      "logWorkForReviewInSeconds": 600
    }
  }
}
```

This automation only runs when a `requirementsId` is supplied on the command line and the provider
resolves to `jira`. It therefore does **not** apply when running `gth pr` with no arguments (change
requirements discovery): the Jira key discovered automatically is used for the review but is not
passed to the worklog path, so no time is logged. Pass the issue id explicitly
(`gth pr <prId> <requirementsId>`) if you need work logging.

### Legacy Jira REST API (Unscoped Token)

The Jira API is used with the `pr` and `review` commands.

This uses the Unscoped API token (aka Legacy API token) method with REST API v2. A legacy token can
be acquired from `Atlassian Account Settings -> Security -> Create and manage API tokens -> [Create API token without scopes]`.
Use your actual company domain in `baseUrl` and your personal legacy `token`.

**Environment Variables Support:**

For better security, you can set the JIRA username and token using environment variables instead of
placing them in the configuration file. When set, they take precedence over the values in the config
file:

- `JIRA_USERNAME`: Your JIRA username (e.g., `user@yourcompany.com`).
- `JIRA_LEGACY_API_TOKEN`: Your JIRA legacy API token.

JSON:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira-legacy",
  "requirementSourceConfig": {
    "jira-legacy": {
      "username": "username@yourcompany.com",
      "token": "YOUR_JIRA_LEGACY_TOKEN",
      "baseUrl": "https://yourcompany.atlassian.net/rest/api/2/issue/"
    }
  }
}
```

JavaScript:

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro',
      vertexai: true,
    }),
    requirementSource: 'jira-legacy',
    requirementSourceConfig: {
      'jira-legacy': {
        username: 'username@yourcompany.com', // Your Jira username/email
        token: 'YOUR_JIRA_LEGACY_TOKEN', // Replace with your real Jira API token
        baseUrl: 'https://yourcompany.atlassian.net/rest/api/2/issue/', // Your Jira instance base URL
      },
    },
  };
}
```

## Git (local diffs)

The `git` content source runs `git --no-pager diff` in the current directory, so `gth review` can
review local changes without a pipe (see [`review`](../COMMANDS.md#review)). Its one setting,
`contentSourceConfig.git.mergeBase`, makes a run with no `contentId` review the branch the way its
pull request will look, with your uncommitted edits on top:

```json
{
  "commands": { "review": { "contentSource": "git" } },
  "contentSourceConfig": { "git": { "mergeBase": "origin/main" } }
}
```

With that config, `gth review` resolves the merge base of `origin/main` and `HEAD` with
`git merge-base`, then diffs the working tree against that commit. Commits merged to `origin/main`
after your branch forked stay out of the diff, instead of showing up as code your branch deletes.
The reviewed content opens with the base and the commit it resolved to, for example
`Local git diff against the merge base of "origin/main" and HEAD (<sha>)`. Fetch first if the
remote-tracking branch is stale: the base is computed from what your clone already has.

- **`mergeBase`** (string, optional): a ref such as `origin/main` or `main`. Unset, `gth review`
  diffs the working tree against the index as before. It must be a non-empty string and must not
  start with `-`; any other value stops the run with an error naming the setting. A ref that does
  not exist, or that shares no history with `HEAD`, also stops the run with an error naming the
  setting. There is no fallback to a plainer diff, because that would review less than you asked
  for.
- **An explicit `contentId` wins.** `gth review main...HEAD --content-source git` diffs exactly
  that range whatever `mergeBase` says.
- **Untracked files are not included**, as with any `git diff`. To have a new file reviewed before
  you commit it, mark it with `git add -N <file>` (intent to add); it then appears in the diff.

## Change Requirements Discovery Configuration

Running `gth pr` without positional arguments triggers change requirements discovery (see
[Commands](../COMMANDS.md#change-requirements-discovery)). Discovery only runs when neither `prId`
nor `requirementsId` is provided; requirements-only syntax such as `gth pr PROJ-123` is unsupported.
It is configured under `commands.pr.discovery`:

- **`enabled`** (boolean, default: `true`): Allow `gth pr` without arguments to trigger change requirements discovery
- **`deterministicDiff`** (boolean, default: `true`): Fetch the current-branch PR diff with
  `gh pr diff` before invoking the discovery agent
- **`filesystem`**, **`builtInTools`**, **`customTools`**, **`tools`**: Tool overrides applied
  only while the discovery agent runs; when omitted, the discovery agent falls back to the
  **top-level** values for these settings, not the `commands.pr.*` ones. The `commands.pr.*` tool
  overrides apply to the review agent only — the discovery agent does not inherit them, so set its
  tools here under `commands.pr.discovery` (or top-level) if it needs anything beyond the defaults
- **`allowedTools`** (string[]): Allow-list of tool names for the discovery agent, applied after
  all tools are resolved. `set_requirements` is always retained so the agent can record what it
  found; an empty array keeps only `set_requirements`, filtering out every other tool. Note that
  because `set_requirements` is always retained, this allow-list never disables tool resolution
  itself — unlike the top-level [`allowedTools: []`](./tools.md#allowed-tools), configured MCP/A2A servers are
  still contacted (potentially triggering OAuth) before their tools are filtered out. Omit the
  property for no filtering. The discovery agent never inherits the top-level `allowedTools`; this
  property is its only allow-list.

The discovery agent always has the discovery helper tools `gh_pr`, `gh_diff`, `gh_issue`,
`set_diff` and `set_requirements` available (subject to `allowedTools`). `gh_diff` stores the
fetched diff directly as the review diff; `set_diff` exists for diffs assembled some other way.

A minimal, tight configuration for GitHub-issue-based requirements:

```json
{
  "commands": {
    "pr": {
      "allowedTools": [],
      "discovery": {
        "allowedTools": ["gh_pr", "gh_diff", "gh_issue"]
      }
    }
  }
}
```

The discovery agent's prompt can be replaced by placing a `.gsloth.pr-discovery.md` file in
`.gsloth/.gsloth-settings/` (or the project root when not using the `.gsloth` directory), or in an
identity profile directory, the same way as other prompts.

## Review Requirements Discovery Configuration

`gth review` with no `-r/--requirements` can find its own requirements (see
[Commands](../COMMANDS.md#requirements-discovery)). It is configured under
`commands.review.discovery`, with the same keys as `commands.pr.discovery` less
`deterministicDiff`, because the review's diff comes from its content source:

- **`enabled`** (boolean, default: `false`): Run requirements discovery when no `--requirements`
  is given. Off by default because it adds a `git` call, a `gh` call, possibly an issue-tracker
  call and an agent run to every review.
- **`filesystem`**, **`builtInTools`**, **`customTools`**, **`tools`**: Tool overrides applied
  only while the discovery agent runs; when omitted, the discovery agent uses the **top-level**
  values, not the `commands.review.*` ones.
- **`allowedTools`** (string[]): Allow-list of tool names for the discovery agent, with the same
  rule as `commands.pr.discovery.allowedTools`: `set_requirements` is always kept, and the
  top-level `allowedTools` is never inherited.

The evidence is the current branch name and, when the branch has one, its pull request's title,
branch names and description from `gh pr view`. With a `jira` or `jira-legacy` requirement source
(`-p`, else `commands.review.requirementSource`, else `requirementSource`), exactly one distinct
Jira key across that evidence is fetched directly; with any other source, a GitHub issue the pull
request description designates is. Commit messages are not read.

The review discovery agent has one helper tool of its own, `set_requirements`, and no diff tools.
Everything else it can use is what you configure — MCP servers such as Jira, built-in tools and
custom tools. To give it more evidence, add a custom tool and point the agent at it in the prompt.
For example, to let it read the branch's commit subjects:

```json
{
  "requirementSource": "jira",
  "commands": {
    "review": {
      "discovery": {
        "enabled": true,
        "customTools": {
          "branch_commits": {
            "command": "git log --format=%s origin/main..HEAD",
            "description": "List the subjects of the commits on this branch that are not on origin/main"
          }
        },
        "allowedTools": ["branch_commits", "mcp__jira__getJiraIssue"]
      }
    }
  }
}
```

The discovery agent's prompt can be replaced by placing a `.gsloth.review-discovery.md` file in
`.gsloth/.gsloth-settings/` (or the project root when not using the `.gsloth` directory), or in an
identity profile directory. `gth get review-discovery prompt` prints the prompt in effect.

## Review rating

The `review` and `pr` commands **automatically provide** automated review scoring with configurable pass/fail thresholds. **Rating is enabled by default** - the AI concludes every review with a numerical rating (0-10) and a comment explaining the rating.

### Rating Scale

- **0-2**: Bad code with syntax errors or critical issues (equivalent to REJECT)
- **3-5**: Code needs significant changes (equivalent to REQUEST_CHANGES)
- **6-10**: Code is acceptable (equivalent to APPROVE)

### Default Behavior

**Out of the box, without any configuration:**

- ✅ Rating is **enabled**
- ✅ Pass threshold is **6/10**
- ✅ Failed reviews (< 6) **exit with code 1** for CI/CD integration

### Configuration Options

You can customize rating behavior for `review` and `pr` commands under `commands.review.rating` or `commands.pr.rating`:

- **`enabled`** (boolean, default: `true`): Enable or disable review rating
- **`passThreshold`** (number 0-10, default: `6`): Minimum score required to pass the review
- **`minRating`** (number, default: `0`): Lower bound for the rating scale
- **`maxRating`** (number, default: `10`): Upper bound for the rating scale
- **`errorOnReviewFail`** (boolean, default: `true`): Exit with error code 1 when review fails (below threshold). It governs the verdict only — see [CI/CD Integration](#cicd-integration) for a review that could not run at all.

### Example Configurations

**Disable rating:**

```json
{
  "commands": {
    "review": {
      "rating": {
        "enabled": false
      }
    }
  }
}
```

**Custom threshold:**

```json
{
  "commands": {
    "review": {
      "rating": {
        "passThreshold": 8
      }
    }
  }
}
```

**Different thresholds for review and PR:**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "commands": {
    "review": {
      "rating": {
        "enabled": true,
        "passThreshold": 6,
        "errorOnReviewFail": true
      }
    },
    "pr": {
      "rating": {
        "enabled": true,
        "passThreshold": 7,
        "errorOnReviewFail": true
      }
    }
  }
}
```

**Rating without failing the build:**

```json
{
  "commands": {
    "review": {
      "rating": {
        "enabled": true,
        "passThreshold": 6,
        "errorOnReviewFail": false
      }
    }
  }
}
```

### Output Format

When rating is enabled, the review will conclude with a clearly formatted rating section:

```
============================================================
REVIEW RATING
============================================================
PASS 8/10 (threshold: 6)

Comment: Code quality is good with minor improvements needed.
Well-structured and follows best practices.
============================================================
```

For failing reviews:

```
============================================================
REVIEW RATING
============================================================
FAIL 4/10 (threshold: 6)

Comment: Significant issues found requiring refactoring
before this code can be merged.
============================================================
```

### CI/CD Integration

When `errorOnReviewFail` is set to `true` (default), failed reviews will exit with code 1, which will fail CI/CD pipeline steps. This is useful for enforcing code quality standards in automated workflows.

A review that **could not run** — a provider error, a context overflow, an unreachable content source — exits with code 1 whatever the rating settings say, including with rating disabled or `errorOnReviewFail` set to `false`. Those settings decide what a low score does; a run that produced no score at all is a failure, and the report it writes explains why. Keep the step that posts the report guarded on the file existing rather than on the step succeeding.

Example usage in GitHub Actions:

```yaml
- name: Run code review
  run: gth review -f changed-files.diff
  # This step will fail if rating is below threshold
```

## Continuous integration

Example GitHub workflows integration can be found in [.github/workflows/review.yml](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/.github/workflows/review.yml)
this example workflow performs AI review on any pushes to Pull Request, resulting in a comment left by,
GitHub actions bot.

For the CI review workflow itself see [Review code and pull requests](../guides/review-code-and-prs.md).
