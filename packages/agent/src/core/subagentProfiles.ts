/**
 * @packageDocumentation
 * GS2-33 — the load-bearing capability: run a subagent under a NAMED config profile. When the
 * parent declares `subagents: [{ name, profile }]`, the CHILD resolves THAT profile through the
 * GS2-1 config cascade (`initConfig({ identityProfile: profile })`), so it gets the profile's own
 * model + tools + prompt — e.g. a cheap flash-lite profile for a recall/search subagent while the
 * parent runs on a strong model.
 *
 * This module is the subagent-spawn config-resolution seam. {@link resolveSubagentProfileConfig}
 * threads the profile name through the cascade; {@link buildProfileSubagents} turns each declared
 * spec into a deepagents {@link SubAgent} whose `model`/`tools`/`systemPrompt` come from the child
 * profile. The deep backend wires the result into `createDeepAgent({ subagents })` (see
 * `GthDeepAgent.init`). Resolution mutates process globals (`setProjectDir`/`setConsoleLevel`/
 * `setUseColour`) exactly as a normal run's `initConfig` does — the caller snapshots + restores
 * them around the build so a child profile's console/colour cannot leak into the parent run.
 */
import { initConfig, type GthConfig, type SubagentProfileSpec } from '@gaunt-sloth/core/config.js';
import type { AgentResolvers, GthCommand } from '@gaunt-sloth/core/core/types.js';
import {
  buildSystemMessages,
  readChatPrompt,
  readCodePrompt,
  readExecPrompt,
} from '@gaunt-sloth/core/utils/llmUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import type { StructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { SubAgent } from 'deepagents';

/**
 * Resolve a named profile into a fully-merged child {@link GthConfig} by threading the profile name
 * through the GS2-1 cascade as `identityProfile`. Deliberately resolves with ONLY the profile
 * override — no parent `-c` / `--model` — so the child is exactly what that profile's config dir
 * defines (a parent `--model` must not silently retarget the child's profile model). The profile's
 * own `.gsloth/.gsloth-settings/<profile>/` config becomes the project-file layer; global config +
 * `DEFAULT_CONFIG` still underlay.
 *
 * NOTE: an explicitly-named profile that has no config dir makes `initConfig` fail loudly (the
 * GS2-62 guard), so a typo'd subagent profile surfaces as an error rather than silently reusing the
 * parent/global model.
 */
export async function resolveSubagentProfileConfig(profile: string): Promise<GthConfig> {
  return initConfig({ identityProfile: profile });
}

/**
 * Compose the child's system prompt the same way the parent does (backstory + guidelines +
 * per-command mode prompt + system prompt via {@link buildSystemMessages}), so the subagent honours
 * the profile's own prompt files. Returns `undefined` only when no prompt content composes.
 */
function composeChildSystemPrompt(
  config: GthConfig,
  command: GthCommand | undefined
): string | undefined {
  const modePrompt =
    command === 'code'
      ? readCodePrompt(config)
      : command === 'exec'
        ? readExecPrompt(config)
        : readChatPrompt(config);
  const systemMessages = buildSystemMessages(config, modePrompt);
  return typeof systemMessages[0]?.content === 'string' ? systemMessages[0].content : undefined;
}

/** Inputs for {@link buildProfileSubagents}. */
export interface BuildProfileSubagentsOptions {
  /** The active command (drives which mode prompt the child composes). */
  command: GthCommand | undefined;
  /**
   * The parent's tool resolver, reused to resolve the CHILD's tools from its profile config (with
   * the filesystem disabled — the deep backend owns fs access for subagents too). Optional: without
   * it a subagent gets the deepagents default tool set.
   */
  resolveTools?: AgentResolvers['resolveTools'];
}

/**
 * Turn each {@link SubagentProfileSpec} into a deepagents {@link SubAgent} whose model + tools +
 * prompt come from the named profile's resolved config. The returned specs are handed to
 * `createDeepAgent({ subagents })`; the model — the whole point — is the child profile's `llm`,
 * distinct from the parent's.
 */
export async function buildProfileSubagents(
  specs: readonly SubagentProfileSpec[],
  options: BuildProfileSubagentsOptions
): Promise<SubAgent[]> {
  const subagents: SubAgent[] = [];
  for (const spec of specs) {
    debugLog(`Resolving subagent "${spec.name}" under profile "${spec.profile}"`);
    const childConfig = await resolveSubagentProfileConfig(spec.profile);

    // Resolve the child's tools from ITS profile config, filesystem disabled (deepagents provides
    // fs for the subagent). An empty allowedTools allow-list disables every tool.
    const allowedTools = childConfig.allowedTools;
    const toolsDisabled = Array.isArray(allowedTools) && allowedTools.length === 0;
    let tools: StructuredTool[] = [];
    if (!toolsDisabled && options.resolveTools) {
      const resolved: StructuredToolInterface[] = await options.resolveTools(
        { ...childConfig, filesystem: 'none' as const },
        options.command
      );
      tools = resolved as unknown as StructuredTool[];
    }

    const systemPrompt =
      composeChildSystemPrompt(childConfig, options.command) ??
      `You are the ${spec.name} subagent.`;

    subagents.push({
      name: spec.name,
      description: spec.description ?? `Runs under the "${spec.profile}" config profile.`,
      systemPrompt,
      model: childConfig.llm,
      tools,
    });
  }
  return subagents;
}
