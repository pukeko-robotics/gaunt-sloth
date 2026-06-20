import type { JiraConfig } from '@gaunt-sloth/review/sources/types.js';
import { getJiraCredentials, jiraRequest } from '@gaunt-sloth/review/helpers/jira/jiraClient.js';
import { displayError, displaySuccess } from '@gaunt-sloth/core/utils/consoleUtils.js';

interface WorklogRequestBody {
  comment: {
    content: Array<{
      content: Array<{
        text: string;
        type: 'text';
      }>;
      type: 'paragraph';
    }>;
    type: 'doc';
    version: 1;
  };
  started: string;
  timeSpentSeconds: number;
}

export default async function jiraLogWork(
  config: Partial<JiraConfig> | null,
  jiraId: string,
  timeInSeconds: number,
  comment: string = 'Work logged',
  startedAt: Date = new Date()
): Promise<string> {
  try {
    // Use provided config or empty config (will use environment variables)
    const credentials = getJiraCredentials(config);

    const bodyData: WorklogRequestBody = {
      comment: {
        content: [
          {
            content: [
              {
                text: comment,
                type: 'text',
              },
            ],
            type: 'paragraph',
          },
        ],
        type: 'doc',
        version: 1,
      },
      started: startedAt.toISOString().replace('Z', '+0000'),
      timeSpentSeconds: timeInSeconds,
    };

    /**
     * https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/#api-rest-api-3-issue-issueidorkey-worklog-post
     * Needs:
     * Classic RECOMMENDED:write:jira-work
     *
     * OR
     *
     * write:issue-worklog:jira, write:issue-worklog.property:jira, read:avatar:jira, read:group:jira,
     * read:issue-worklog:jira, read:project-role:jira, read:user:jira, read:issue-worklog.property:jira
     */
    await jiraRequest(credentials, `/rest/api/3/issue/${jiraId}/worklog`, {
      method: 'POST',
      body: JSON.stringify(bodyData),
    });

    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const successMessage = `Logged ${timeStr} to ${jiraId}`;
    displaySuccess(successMessage);
    return successMessage;
  } catch (error) {
    const errorMessage = `Failed to log work to Jira: ${
      error instanceof Error ? error.message : String(error)
    }`;
    displayError(errorMessage);
    return errorMessage;
  }
}
