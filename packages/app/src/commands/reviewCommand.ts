import { Command, Option } from 'commander';
import { getStringFromStdin } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  getCommandProviderInput,
  getEffectiveContentProvider,
  getEffectiveRequirementsProvider,
  getReviewSystemPrompt,
} from '#src/commands/commandIntrospection.js';
import {
  REQUIREMENTS_PROVIDERS,
  CONTENT_PROVIDERS,
  type RequirementsProviderType,
  type ContentProviderType,
} from '#src/commands/commandUtils.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/review/utils/fileUtils.js';

interface ReviewCommandOptions {
  file?: string[];
  requirements?: string;
  requirementsProvider?: RequirementsProviderType;
  contentProvider?: ContentProviderType;
  message?: string;
}

export function reviewCommand(
  program: Command,
  cliConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('review')
    .description('Review provided diff or other content')
    .argument(
      '[contentId]',
      'Optional content ID argument to retrieve content with content provider'
    )
    .alias('r')
    // TODO add provider to get results of git --no-pager diff
    .option(
      '-f, --file [files...]',
      'Input files. Content of these files will be added BEFORE the diff, but after requirements'
    )
    // TODO figure out what to do with this (we probably want to merge it with requirementsId)?
    .option('-r, --requirements <requirements>', 'Requirements for this review.')
    .addOption(
      new Option(
        '-p, --requirements-provider <requirementsProvider>',
        'Requirements provider for this review.'
      ).choices(Object.keys(REQUIREMENTS_PROVIDERS))
    )
    .addOption(
      new Option('--content-provider <contentProvider>', 'Content  provider').choices(
        Object.keys(CONTENT_PROVIDERS)
      )
    )
    .option('-m, --message <message>', 'Extra message to provide just before the content')
    .action(async (contentId: string | undefined, options: ReviewCommandOptions) => {
      const { initConfig } = await import('@gaunt-sloth/core/config.js');
      const config = await initConfig(cliConfigOverrides); // Initialize and get config
      const content: string[] = [];
      const requirementsId = options.requirements;
      const requirementsProvider = getEffectiveRequirementsProvider(
        'review',
        config,
        options.requirementsProvider
      );
      const contentProvider = getEffectiveContentProvider(
        'review',
        config,
        options.contentProvider
      );

      // TODO consider calling these in parallel
      const requirements = await getCommandProviderInput(
        'review',
        'requirements',
        requirementsId,
        config,
        requirementsProvider
      );
      if (requirements) {
        content.push(requirements);
      }

      const providedContent = await getCommandProviderInput(
        'review',
        'content',
        contentId,
        config,
        contentProvider
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
