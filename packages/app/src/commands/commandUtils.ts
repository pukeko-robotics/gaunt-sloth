import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';

import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

/**
 * Requirement sources. Aliases are mapped to actual package paths.
 */
export const REQUIREMENTS_SOURCES = {
  'jira-legacy': '@gaunt-sloth/review/sources/jiraIssueLegacySource.js',
  jira: '@gaunt-sloth/review/sources/jiraIssueSource.js',
  github: '@gaunt-sloth/review/sources/ghIssueSource.js',
  text: '@gaunt-sloth/review/sources/textSource.js',
  file: '@gaunt-sloth/review/sources/fileSource.js',
} as const;

export type RequirementSourceType = keyof typeof REQUIREMENTS_SOURCES;

/**
 * Content sources. Aliases are mapped to actual package paths.
 */
export const CONTENT_SOURCES = {
  github: '@gaunt-sloth/review/sources/ghPrDiffSource.js',
  text: '@gaunt-sloth/review/sources/textSource.js',
  file: '@gaunt-sloth/review/sources/fileSource.js',
} as const;

export type ContentSourceType = keyof typeof CONTENT_SOURCES;

export async function getRequirementsFromSource(
  requirementSource: RequirementSourceType | undefined,
  requirementsId: string | undefined,
  config: GthConfig
): Promise<string> {
  const requirements = await getFromSource(
    requirementSource,
    requirementsId,
    (config?.requirementSourceConfig ?? {})[requirementSource as string],
    REQUIREMENTS_SOURCES
  );
  return wrapContent(requirements, requirementSource, 'requirements');
}

export async function getContentFromSource(
  contentSource: ContentSourceType | undefined,
  contentId: string | undefined,
  config: GthConfig
): Promise<string> {
  const content = await getFromSource(
    contentSource,
    contentId,
    (config?.contentSourceConfig ?? {})[contentSource as string],
    CONTENT_SOURCES
  );
  return wrapContent(
    content,
    contentSource,
    contentSource === 'github' ? 'GitHub diff' : 'content'
  );
}

async function getFromSource(
  source: RequirementSourceType | ContentSourceType | undefined,
  id: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  legitPredefinedSources: typeof REQUIREMENTS_SOURCES | typeof CONTENT_SOURCES
): Promise<string> {
  if (typeof source === 'string') {
    // Use one of the predefined sources
    if (legitPredefinedSources[source as keyof typeof legitPredefinedSources]) {
      const sourcePath = legitPredefinedSources[source as keyof typeof legitPredefinedSources];
      const { get } = await import(sourcePath);
      return await get(config, id);
    } else {
      displayError(`Unknown source: ${source}. Continuing without it.`);
    }
  } else if (typeof source === 'function') {
    // Type assertion to handle function call
    return await (source as (id: string | undefined) => Promise<string>)(id);
  }
  return '';
}
