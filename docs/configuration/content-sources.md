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

Gaunt Sloth reads a GitHub issue as the requirement source through the GitHub CLI. The integration
is simple and needs minimal setup.

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
      "url": "https://mcp.atlassian.com/v1/sse",
      "authProvider": "OAuth",
      "transport": "sse"
    }
  }
}
```

For the OAuth flow, token storage, and TLS trust details, see [MCP](./mcp.md).

### 1. Modern Jira REST API (Scoped Token)

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

### 2. Legacy Jira REST API (Unscoped Token)

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
- **`errorOnReviewFail`** (boolean, default: `true`): Exit with error code 1 when review fails (below threshold)

### Example Configurations

**Default configuration (no config needed):**

Rating works out of the box with no configuration required! The defaults provide sensible CI/CD integration.

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
