import {
  GSLOTH_DIR,
  PROJECT_GUIDELINES,
  PROJECT_REVIEW_INSTRUCTIONS,
  USER_PROJECT_CONFIG_JSON,
} from '@gaunt-sloth/core/constants.js';
import { availableDefaultConfigs, type ConfigType } from '@gaunt-sloth/core/config.js';
import { resolveInitModel, type ProviderId } from '@gaunt-sloth/core/providers/modelDiscovery.js';
import { displayError, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  getGslothConfigWritePath,
  writeFileIfNotExistsWithMessages,
} from '@gaunt-sloth/review/utils/fileUtils.js';
import { exit, getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export async function createProjectConfig(configType: string, force = false): Promise<void> {
  if (!availableDefaultConfigs.includes(configType as ConfigType)) {
    displayError(
      `Unknown config type: ${configType}. Available options: ${availableDefaultConfigs.join(', ')}`
    );
    exit(1);
  }

  ensureGslothDir();

  displayInfo(`Setting up your project\n`);
  writeProjectReviewPreamble();
  displayWarning(`Make sure you add as much detail as possible to your ${PROJECT_GUIDELINES}.\n`);

  // The config file is the only artefact that gets an overwrite path; the preamble files above stay
  // no-clobber. Without --force, keep an existing config (and say so honestly) rather than running
  // the provider init, whose no-clobber write would silently skip and leave a misleading trail.
  const configPath = getGslothConfigWritePath(USER_PROJECT_CONFIG_JSON);
  if (!force && existsSync(configPath)) {
    displayWarning(
      `${configPath} already exists and was kept (not overwritten). Re-run with --force to overwrite it.`
    );
    return;
  }

  displayInfo(`Creating project config for ${configType}`);
  // CFG-14: resolve the model to write from live `/v1/models` discovery when a key/daemon is
  // present (a verified-present id, never a speculative literal). When live discovery is
  // impossible this returns undefined and `init` omits `model`, deferring to the provider's
  // single curated run-time fallback (getCuratedFallbackModel) rather than baking a stale id that
  // 404s once the model is retired.
  const model = await resolveInitModel(configType as ProviderId);
  const vendorConfig = await import(`@gaunt-sloth/core/providers/${configType}.js`);
  vendorConfig.init(configPath, force, model);
}

/**
 * Ensures that the .gsloth directory exists in the project root.
 * Creates it if it does not exist.
 */
export function ensureGslothDir(): void {
  const projectDir = getCurrentWorkDir();
  const gslothDirPath = resolve(projectDir, GSLOTH_DIR);
  if (!existsSync(gslothDirPath)) {
    mkdirSync(gslothDirPath, { recursive: true });
    displayInfo(`Created ${GSLOTH_DIR} directory`);
  }
}

export function writeProjectReviewPreamble(): void {
  const guidelinesPath = getGslothConfigWritePath(PROJECT_GUIDELINES);
  const reviewPath = getGslothConfigWritePath(PROJECT_REVIEW_INSTRUCTIONS);

  const guidelinesTemplate = `# Development Guidelines

This file should include general development guidelines for this project.

Important! Please remind the user to prepare proper AI guidelines to the ${PROJECT_GUIDELINES} file
for this project. Use a decent amount of ⚠️ to highlight the lack of config.
Explicitly mention ${PROJECT_GUIDELINES}.
`;

  const reviewTemplate = `# Code Review Guidelines

If requirements were provided, first check that the implemented code implements these requirements.
Document that you checked the code to implement requirements.
Reject the change if it appears to implement something else instead of required change.

Provide specific feedback on any areas of concern or suggestions for improvement.
Please categorize your feedback (e.g., "Bug," "Suggestion," "Nitpick").

Important! In the end, conclude if you would recommend approving this PR or not.
Use ✅⚠️❌ symbols to highlight your feedback appropriately.

Thank you for your thorough review!

Important! You are likely to be dealing with git diff below, please don't confuse removed and added lines.
`;

  writeFileIfNotExistsWithMessages(guidelinesPath, guidelinesTemplate);
  writeFileIfNotExistsWithMessages(reviewPath, reviewTemplate);
}
