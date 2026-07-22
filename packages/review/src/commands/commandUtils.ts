import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';

import {
  readBackstory,
  readGuidelines,
  readReviewInstructions,
  readSystemPrompt,
  wrapContent,
} from '@gaunt-sloth/core/utils/llmUtils.js';

/**
 * Compose the review system preamble the way the fat CLI's `gth review` / `gth pr` do:
 * backstory + guidelines + review instructions + the optional project system prompt, each
 * segment honouring the GS2-43 `prompts.*` config. Empty segments are dropped rather than
 * left as blank lines (the shape the README embed example documents).
 */
export function getReviewPreamble(config: GthConfig): string {
  return [
    readBackstory(config),
    readGuidelines(config),
    readReviewInstructions(config),
    readSystemPrompt(config),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Requirement sources. Expected to be in `.sources/` dir.
 * Aliases are mapped to actual sources in this file
 */
export const REQUIREMENTS_SOURCES = {
  'jira-legacy': 'jiraIssueLegacySource.js',
  jira: 'jiraIssueSource.js',
  github: 'ghIssueSource.js',
  text: 'textSource.js',
  file: 'fileSource.js',
} as const;

export type RequirementSourceType = keyof typeof REQUIREMENTS_SOURCES;

/**
 * Content sources. Expected to be in `.sources/` dir.
 * Aliases are mapped to actual sources in this file
 */
export const CONTENT_SOURCES = {
  github: 'ghPrDiffSource.js',
  git: 'gitDiffSource.js',
  text: 'textSource.js',
  file: 'fileSource.js',
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
    contentSource === 'github' ? 'GitHub diff' : contentSource === 'git' ? 'git diff' : 'content'
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
      const sourcePath = `#src/sources/${legitPredefinedSources[source as keyof typeof legitPredefinedSources]}`;
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
