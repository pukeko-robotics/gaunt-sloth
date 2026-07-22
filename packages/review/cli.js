#!/usr/bin/env node

/**
 * Simple CLI for gaunt-sloth-review
 * Usage: gaunt-sloth-review [pr-number-or-content] [requirements...]
 *
 * When called with a PR number, reviews the specified PR using the configured content provider.
 * When called without arguments, reads diff from stdin via the configured content provider.
 */

import { createRequire } from 'node:module';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const require = createRequire(import.meta.url);
  const { version } = require('./package.json');
  console.log(version);
  process.exit(0);
}

import { setEntryPoint } from '@gaunt-sloth/core/utils/systemUtils.js';
setEntryPoint(import.meta.url);

import { initConfig } from '@gaunt-sloth/core/config.js';
import { review } from '#src/modules/reviewModule.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  getContentFromSource,
  getRequirementsFromSource,
  getReviewPreamble,
} from '#src/commands/commandUtils.js';

async function main() {
  try {
    const config = await initConfig({
      identityProfile: process.env.GSLOTH_IDENTITY_PROFILE,
    });

    // First arg is content (e.g. PR number), rest are requirements
    const contentArg = args[0];
    const requirementArgs = args.slice(1);

    // Get content (e.g. PR diff)
    const contentSource = config.commands?.pr?.contentSource || config.contentSource || 'github';
    const content = await getContentFromSource(contentSource, contentArg, config);

    // Get requirements if provided
    let requirements = '';
    if (requirementArgs.length > 0) {
      const reqSource =
        config.commands?.pr?.requirementSource || config.requirementSource || 'github';
      for (const reqArg of requirementArgs) {
        const req = await getRequirementsFromSource(reqSource, reqArg, config);
        if (req) requirements += req + '\n';
      }
    }

    // Build the review preamble (backstory + guidelines + review instructions + optional
    // system prompt), the same composition `gth review` / `gth pr` use.
    const preambleText = getReviewPreamble(config);

    // Combine requirements and content for the review
    const diffWithReqs = requirements
      ? `Requirements:\n${requirements}\nDiff:\n${content}`
      : content;

    await review('pr-review', preambleText, diffWithReqs, config, 'pr');
  } catch (error) {
    displayError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
