import { display, displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import type { JiraConfig } from './types.js';
import {
  getJiraCredentials,
  jiraRequest,
  type ResolvedJiraCredentials,
} from '#src/helpers/jira/jiraClient.js';

interface JiraIssueResponse {
  fields: {
    summary: string;
    description: string;
    [key: string]: unknown;
  };

  [key: string]: unknown;
}

/**
 * Gets Jira issue using Atlassian REST API v3 with Personal Access Token
 *
 * Requires an authenticated Atlassian Cloud instance (Cloud ID + API token); anonymous
 * access to a public Jira instance is not supported.
 *
 * @param config Jira configuration
 * @param issueId Jira issue ID
 * @returns Jira issue content
 */
export async function get(
  config: Partial<JiraConfig> | null,
  issueId: string | undefined
): Promise<string | null> {
  if (!config) {
    displayWarning('No Jira config provided');
    return null;
  }
  if (!issueId) {
    displayWarning('No issue ID provided');
    return null;
  }

  const credentials = getJiraCredentials(config);

  try {
    const issue = await getJiraIssue(credentials, issueId);
    if (!issue) {
      return null;
    }

    const summary = issue.fields.summary;
    const description = issue.fields.description;

    return `Jira Issue: ${issueId}\nSummary: ${summary}\n\nDescription:\n${description}`;
  } catch (error) {
    displayError(
      `Failed to get Jira issue: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Helper function to get Jira issue details using Atlassian REST API v2.
 *
 * The feature was initially developed to use Atlassian REST API v3, which by
 * default returns the ADF JSON format for description, which is not very useful for us.
 *
 * @param config Jira configuration
 * @param jiraKey Jira issue ID
 * @returns Jira issue response
 */
async function getJiraIssue(
  credentials: ResolvedJiraCredentials,
  jiraKey: string
): Promise<JiraIssueResponse> {
  // Jira Cloud ID can be found by authenticated user at https://company.atlassian.net/_edge/tenant_info

  // According to doc https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get permissions to read this resource:
  // https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issues/#api-rest-api-2-issue-issueidorkey-get
  // either Classic (RECOMMENDED) read:jira-work
  // or Granular read:issue-meta:jira, read:issue-security-level:jira, read:issue.vote:jira, read:issue.changelog:jira,
  // read:avatar:jira, read:issue:jira, read:status:jira, read:user:jira, read:field-configuration:jira

  if (credentials.displayUrl) {
    display(`Loading Jira issue ${credentials.displayUrl}${jiraKey}`);
  }

  // This filter will be necessary for V3: `&expand=renderedFields` to convert ADF to HTML
  const filters = '?fields=summary,description'; // Limit JSON to summary and description

  return jiraRequest<JiraIssueResponse>(credentials, `/rest/api/2/issue/${jiraKey}${filters}`, {
    method: 'GET',
  });
}
