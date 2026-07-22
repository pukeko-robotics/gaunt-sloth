import { Command, Option } from 'commander';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  getCommandSourceInput,
  getEffectiveContentSource,
  getEffectiveRequirementSource,
  getReviewSystemPrompt,
} from '#src/commands/commandIntrospection.js';
import { REQUIREMENTS_SOURCES, type RequirementSourceType } from './commandUtils.js';
import jiraLogWork from '#src/helpers/jira/jiraLogWork.js';
import { JiraConfig } from '@gaunt-sloth/review/sources/types.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';
import { runPrDiscovery } from '#src/commands/prDiscovery.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/review/utils/fileUtils.js';

interface PrCommandOptions {
  file?: string[];
  requirementsSource?: RequirementSourceType;
  message?: string;
}

export function prCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('pr')
    .description(
      'Review provided Pull Request in current directory. ' +
        'This command is similar to `review`, but default content source is `github`. ' +
        '(assuming that GitHub CLI is installed and authenticated for current project'
    )
    .argument(
      '[prId]',
      "Pull request ID to review. Omit both prId and requirementsId to discover the change requirements from the current branch's PR."
    )
    .argument(
      '[requirementsId]',
      'Optional requirements ID argument to retrieve requirements with requirement source'
    )
    .addOption(
      new Option(
        '-p, --requirements-source <requirementSource>',
        'Requirement source for this review.'
      ).choices(Object.keys(REQUIREMENTS_SOURCES))
    )
    .option(
      '-f, --file [files...]',
      'Input files. Content of these files will be added BEFORE the diff, but after requirements'
    )
    .option('-m, --message <message>', 'Extra message to provide just before the content')
    .action(async (prId: string, requirementsId: string | undefined, options: PrCommandOptions) => {
      const { initConfig } = await import('@gaunt-sloth/core/config.js');
      const config = await initConfig(commandLineConfigOverrides); // Initialize and get config
      const content: string[] = [];
      const requirementSource = getEffectiveRequirementSource(
        'pr',
        config,
        options.requirementsSource
      );
      const contentSource = getEffectiveContentSource('pr', config);

      if (options.file) {
        content.push(readMultipleFilesFromProjectDir(options.file));
      }

      const isDiscovery = !prId && !requirementsId;
      const looksLikeRequirementsOnlyMode =
        contentSource === 'github' && Boolean(prId) && !requirementsId && !/^\d+$/.test(prId);

      if (looksLikeRequirementsOnlyMode) {
        displayError(
          `Unsupported PR command arguments: "${prId}" was provided as the pull request ID. ` +
            '`gth pr <requirementsId>` requirements-only mode is not supported. ' +
            'Use `gth pr` with no arguments to discover change requirements automatically, or provide both a numeric PR ID and requirements ID: `gth pr <prId> <requirementsId>`.'
        );
        setExitCode(1);
        return;
      }

      // With the GitHub content source, prId ends up interpolated into `gh pr diff <prId>` and
      // the gh read-file tool's `gh api` calls. Both sinks validate again themselves (defense in
      // depth), but reject garbage upfront with a clear error instead of a downstream warning.
      // Non-GitHub content sources (file/text) accept arbitrary content ids and stay untouched.
      if (contentSource === 'github' && prId && !/^\d+$/.test(prId)) {
        displayError(
          `Invalid pull request ID "${prId}"; expected a numeric PR number, e.g. \`gth pr 42\`.`
        );
        setExitCode(1);
        return;
      }

      if (isDiscovery) {
        if (config.commands?.pr?.discovery?.enabled === false) {
          displayError(
            'Change requirements discovery is disabled. Provide a pull request ID to run `gth pr`.'
          );
          setExitCode(1);
          return;
        }

        try {
          const discoveryResult = await runPrDiscovery(config);
          if (discoveryResult.requirements) {
            content.push(
              wrapContent(discoveryResult.requirements, 'discovered-requirements', 'requirements')
            );
          }
          if (!discoveryResult.diff) {
            displayError(
              'Change requirements discovery did not produce a diff. Cannot continue with review.'
            );
            setExitCode(1);
            return;
          }
          content.push(wrapContent(discoveryResult.diff, 'discovered-diff', 'GitHub diff'));
        } catch (error) {
          displayError(error instanceof Error ? error.message : String(error));
          setExitCode(1);
          return;
        }
      } else {
        // Handle requirements
        const requirements = await getCommandSourceInput(
          'pr',
          'requirements',
          requirementsId,
          config,
          requirementSource
        );

        if (requirements) {
          content.push(requirements);
        }

        // Get PR diff using the source
        try {
          const prContent = await getCommandSourceInput(
            'pr',
            'content',
            prId,
            config,
            contentSource
          );
          // A source may resolve to an empty result instead of throwing - e.g. ghPrDiffSource
          // returns null (with a warning) for an invalid PR number. Without this guard the review
          // would silently proceed against no diff; fail loudly as the throwing path used to.
          if (!prContent) {
            displayError(
              `Could not retrieve PR content for "${prId}". Cannot continue with review.`
            );
            setExitCode(1);
            return;
          }
          content.push(prContent);
        } catch (error) {
          displayError(error instanceof Error ? error.message : String(error));
          setExitCode(1);
          return;
        }
      }

      if (options.message) {
        content.push(wrapContent(options.message, 'message', 'user message'));
      }

      const { review } = await import('@gaunt-sloth/review/modules/reviewModule.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
      await review(
        prId ? `PR-${prId}` : 'PR-discovery',
        getReviewSystemPrompt(config),
        content.join('\n'),
        config,
        'pr',
        createResolvers(),
        // Bind GitHub-only review tools (gth_gh_read_file) to this PR's repo/ref, so they read
        // the PR under review rather than letting the model guess owner/repo. Undefined prId =
        // discovery mode (current branch's PR), which `gh pr view` resolves on its own.
        { prId }
      );

      if (
        requirementsId &&
        (config.commands?.pr?.requirementSource ?? config.requirementSource) === 'jira' &&
        config.commands?.pr?.logWorkForReviewInSeconds
      ) {
        let jiraConfig =
          config.builtInToolsConfig?.jira || (config.requirementSourceConfig?.jira as JiraConfig);
        await jiraLogWork(
          jiraConfig,
          requirementsId,
          config.commands?.pr?.logWorkForReviewInSeconds,
          'code review'
        );
      }
    });
}
