import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import jiraLogWork from '#src/helpers/jira/jiraLogWork.js';
import type { JiraConfig } from '@gaunt-sloth/review/sources/types.js';
import { GthConfig } from '@gaunt-sloth/core/config.js';

// Define the input schema for the tool
const gthJiraLogWorkSchema = z.object({
  jiraId: z.string().describe('The Jira issue ID (e.g., "PROJ-123")'),
  timeInSeconds: z.number().describe('Time spent in seconds'),
  comment: z.string().optional().describe('Work log comment'),
  startedAt: z.string().optional().describe('ISO 8601 date string for when work started'),
});

const toolDefinition = {
  name: 'gth_jira_log_work',
  description: `Gaunt Sloth Jira Log Work Tool. Log work time to a Jira issue. Requires Jira configuration with credentials.
Example: gth_jira_log_work({ jiraId: "PROJ-123", timeInSeconds: 3600, comment: "Implemented feature X" })`,
  schema: gthJiraLogWorkSchema,
};

function getToolImpl(config?: Partial<JiraConfig>): StructuredToolInterface {
  const toolImpl = async ({
    jiraId,
    timeInSeconds,
    comment = 'Work logged',
    startedAt,
  }: z.infer<typeof gthJiraLogWorkSchema>): Promise<string> => {
    const jiraConfig = config || {};

    const startDate = startedAt ? new Date(startedAt) : new Date();

    return await jiraLogWork(jiraConfig, jiraId, timeInSeconds, comment, startDate);
  };
  return tool(toolImpl, toolDefinition);
}

// Export a default instance that uses environment variables
export function get(config: GthConfig) {
  if (!config.builtInToolsConfig?.jira && config.requirementsProviderConfig?.jira) {
    displayWarning(
      'config.prebuiltToolsConfig.jira is not defined. Using config.requirementsProviderConfig.jira.'
    );
  }
  const jiraConfig = config.builtInToolsConfig?.jira || config.requirementsProviderConfig?.jira;
  if (!jiraConfig) {
    throw new Error('gth_jira_log_work is added to builtInTools, but no Jira config is provided.');
  }
  return getToolImpl(jiraConfig);
}
