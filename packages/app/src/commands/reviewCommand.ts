import { Command, Option } from 'commander';
import { getStringFromStdin } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  getCommandSourceInput,
  getEffectiveContentSource,
  getEffectiveRequirementSource,
  getReviewSystemPrompt,
} from '#src/commands/commandIntrospection.js';
import {
  REQUIREMENTS_SOURCES,
  CONTENT_SOURCES,
  type RequirementSourceType,
  type ContentSourceType,
} from '#src/commands/commandUtils.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/review/utils/fileUtils.js';

interface ReviewCommandOptions {
  file?: string[];
  requirements?: string;
  requirementsSource?: RequirementSourceType;
  contentSource?: ContentSourceType;
  message?: string;
}

export function reviewCommand(
  program: Command,
  cliConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('review')
    .description('Review provided diff or other content')
    .argument('[contentId]', 'Optional content ID argument to retrieve content with content source')
    .alias('r')
    // TODO add source to get results of git --no-pager diff
    .option(
      '-f, --file [files...]',
      'Input files. Content of these files will be added BEFORE the diff, but after requirements'
    )
    // TODO figure out what to do with this (we probably want to merge it with requirementsId)?
    .option('-r, --requirements <requirements>', 'Requirements for this review.')
    .addOption(
      new Option(
        '-p, --requirements-source <requirementSource>',
        'Requirement source for this review.'
      ).choices(Object.keys(REQUIREMENTS_SOURCES))
    )
    .addOption(
      new Option('--content-source <contentSource>', 'Content source').choices(
        Object.keys(CONTENT_SOURCES)
      )
    )
    .option('-m, --message <message>', 'Extra message to provide just before the content')
    .action(async (contentId: string | undefined, options: ReviewCommandOptions) => {
      const { initConfig } = await import('@gaunt-sloth/core/config.js');
      const config = await initConfig(cliConfigOverrides); // Initialize and get config
      const content: string[] = [];
      const requirementsId = options.requirements;
      const requirementSource = getEffectiveRequirementSource(
        'review',
        config,
        options.requirementsSource
      );
      const contentSource = getEffectiveContentSource('review', config, options.contentSource);

      // TODO consider calling these in parallel
      const requirements = await getCommandSourceInput(
        'review',
        'requirements',
        requirementsId,
        config,
        requirementSource
      );
      if (requirements) {
        content.push(requirements);
      }

      const providedContent = await getCommandSourceInput(
        'review',
        'content',
        contentId,
        config,
        contentSource
      );
      if (providedContent) {
        content.push(providedContent);
      }

      if (options.file) {
        content.push(readMultipleFilesFromProjectDir(options.file));
      }
      const stringFromStdin = getStringFromStdin();
      if (stringFromStdin) {
        content.push(wrapContent(stringFromStdin, 'stdin-content'));
      }
      if (options.message) {
        content.push(wrapContent(options.message, 'message', 'user message'));
      }
      const { review } = await import('@gaunt-sloth/review/modules/reviewModule.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
      await review(
        'REVIEW',
        getReviewSystemPrompt(config),
        content.join('\n'),
        config,
        'review',
        createResolvers()
      );
    });
}
