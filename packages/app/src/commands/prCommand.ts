import { Command, Option } from 'commander';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { ApprovalStopError, approvalStopRows } from '@gaunt-sloth/core/core/shell/approvalStop.js';
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
import { extractChangedPathsFromDiff } from '@gaunt-sloth/review/utils/diffPaths.js';
import { writeReviewFailureReport } from '@gaunt-sloth/review/modules/reviewFailureReport.js';

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
    .addHelpText(
      'after',
      '\n' + 'Examples:\n' + '  $ gth pr\n' + '  $ gth pr 42\n' + '  $ gth pr 42 PROJ-123 -p jira\n'
    )
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

      // REL-20 — the label `review()` would have used, hoisted because the failure report has to
      // land at the same path the successful run would have written.
      const reportSource = prId ? `PR-${prId}` : 'PR-discovery';

      /**
       * REL-20 — every exit from this action that happens BEFORE `review()` runs goes through
       * here, so a caller that asked for a report file gets one saying why there is none of the
       * usual content in it. The exit code is unchanged: the run still failed.
       *
       * This is an enumeration of exits, which is exactly the shape that rots by omission — a new
       * guard added below without this call silently reopens the hole for one more input. Anything
       * here that `return`s before the `review()` call must call one of these first —
       * `reportBeforeReview` only when the error has already been displayed.
       */
      const reportBeforeReview = (message: string): void => {
        writeReviewFailureReport(config, reportSource, 'pr', message);
        setExitCode(1);
      };
      const failBeforeReview = (message: string): void => {
        displayError(message);
        reportBeforeReview(message);
      };

      // REL-24 — an unreadable `--file` is a reported failure, not a crash, the same as it is in
      // `gaunt-sloth-review`. The reader has already displayed which file and why, so only the
      // report and the exit code are owed here.
      if (options.file) {
        try {
          content.push(readMultipleFilesFromProjectDir(options.file));
        } catch (error) {
          reportBeforeReview(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      // CFG-70 — the paths this run's DIFF touches, for `prompts.paths` selection. Declared out
      // here because `gth pr` has TWO content producers, not one: discovery mode's
      // `discoveryResult.diff` and the explicit-PR path's `prContent`. Wiring only the branch one
      // happens to be reading leaves the other silently unscoped.
      //
      // Both take the producer's own output, never `content` — which by then also carries the
      // requirements, `--file` contents and `--message`, any of which may quote a diff for a
      // module this change never touched.
      let changedPaths: string[] = [];

      const isDiscovery = !prId && !requirementsId;
      const looksLikeRequirementsOnlyMode =
        contentSource === 'github' && Boolean(prId) && !requirementsId && !/^\d+$/.test(prId);

      if (looksLikeRequirementsOnlyMode) {
        failBeforeReview(
          `Unsupported PR command arguments: "${prId}" was provided as the pull request ID. ` +
            '`gth pr <requirementsId>` requirements-only mode is not supported. ' +
            'Use `gth pr` with no arguments to discover change requirements automatically, or provide both a numeric PR ID and requirements ID: `gth pr <prId> <requirementsId>`.'
        );
        return;
      }

      // With the GitHub content source, prId ends up interpolated into `gh pr diff <prId>` and
      // the gh read-file tool's `gh api` calls. Both sinks validate again themselves (defense in
      // depth), but reject garbage upfront with a clear error instead of a downstream warning.
      // Non-GitHub content sources (file/text) accept arbitrary content ids and stay untouched.
      if (contentSource === 'github' && prId && !/^\d+$/.test(prId)) {
        failBeforeReview(
          `Invalid pull request ID "${prId}"; expected a numeric PR number, e.g. \`gth pr 42\`.`
        );
        return;
      }

      if (isDiscovery) {
        if (config.commands?.pr?.discovery?.enabled === false) {
          failBeforeReview(
            'Change requirements discovery is disabled. Provide a pull request ID to run `gth pr`.'
          );
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
            failBeforeReview(
              'Change requirements discovery did not produce a diff. Cannot continue with review.'
            );
            return;
          }
          changedPaths = extractChangedPathsFromDiff(discoveryResult.diff);
          content.push(wrapContent(discoveryResult.diff, 'discovered-diff', 'GitHub diff'));
        } catch (error) {
          // [[TUI-C71]] — `runPrDiscovery` runs an agent inside a try/FINALLY with no catch of its
          // own, so a run-ending approvals stop from the discovery agent surfaces here. That agent
          // wires no tool-approval callback either, which makes §6.2 its only escalation path, and
          // §6.2 is the message that carries the whole negotiation transcript.
          if (error instanceof ApprovalStopError) {
            for (const row of approvalStopRows(error.parts, { columns: stdout.columns })) {
              displayError(row);
            }
            // REL-20 — the report gets the stop's own message, not the rows above. Those rows are
            // the terminal rendering: a gutter and a wrap computed against this terminal's width,
            // which is meaningless in a file someone posts as a PR comment. The message is already
            // neutralised at construction, so it is safe to write raw.
            reportBeforeReview(error.message);
          } else {
            failBeforeReview(error instanceof Error ? error.message : String(error));
          }
          return;
        }
      } else {
        // REL-24 — a requirements source that cannot be resolved (a Jira source with no token, say)
        // fails the run with a report, the same as a content source that cannot be fetched.
        let requirements: string;
        try {
          requirements = await getCommandSourceInput(
            'pr',
            'requirements',
            requirementsId,
            config,
            requirementSource
          );
        } catch (error) {
          failBeforeReview(error instanceof Error ? error.message : String(error));
          return;
        }

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
            failBeforeReview(
              `Could not retrieve PR content for "${prId}". Cannot continue with review.`
            );
            return;
          }
          changedPaths = extractChangedPathsFromDiff(prContent);
          content.push(prContent);
        } catch (error) {
          failBeforeReview(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      if (options.message) {
        content.push(wrapContent(options.message, 'message', 'user message'));
      }

      const { review } = await import('@gaunt-sloth/review/modules/reviewModule.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
      await review(
        reportSource,
        getReviewSystemPrompt(config),
        content.join('\n'),
        config,
        'pr',
        createResolvers(),
        // Bind GitHub-only review tools (gth_gh_read_file) to this PR's repo/ref, so they read
        // the PR under review rather than letting the model guess owner/repo. Undefined prId =
        // discovery mode (current branch's PR), which `gh pr view` resolves on its own.
        { prId, changedPaths }
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
