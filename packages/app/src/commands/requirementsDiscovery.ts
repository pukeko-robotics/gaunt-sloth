/**
 * The agent-running half of change requirements discovery, shared by `gth pr` (discovery mode) and
 * `gth review` (with `commands.review.discovery.enabled`).
 *
 * Each command gathers its own evidence and runs its own deterministic fast path; when that does
 * not settle the requirements, it hands this module a prompt, a user message carrying the evidence
 * as data, and the helper tools it needs (`set_requirements` always, plus `set_diff` and the `gh_*`
 * helpers for `pr`). Everything that is the SAME for both — the configured tool set and its
 * allow-list, the checkpoint saver, the termination announcement — lives here, because each of
 * those was a defect once (EXT-120, EXT-159) and a second copy would have to be fixed a second time.
 */
import type {
  BuiltInToolsSetting,
  CustomToolsConfig,
  GthConfig,
  ServerTool,
} from '@gaunt-sloth/core/config.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { defaultStatusCallback, displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { buildSystemMessages } from '@gaunt-sloth/core/utils/llmUtils.js';
import { displayTermination } from '@gaunt-sloth/core/core/terminationNotice.js';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import { createResolvers } from '@gaunt-sloth/agent/resolvers.js';

/**
 * The discovery settings every command's discovery shares: whether it runs, and which tools the
 * discovery agent gets. `commands.pr.discovery` adds `deterministicDiff` on top.
 */
export interface RequirementsDiscoveryConfig {
  /**
   * Enable change requirements discovery. The default differs per command: `true` for `gth pr`,
   * `false` for `gth review`.
   */
  enabled?: boolean;
  /**
   * Optional tool overrides used only while the discovery agent runs.
   * When omitted, the normal configured tools remain available.
   */
  filesystem?: string[] | 'all' | 'read' | 'none';
  builtInTools?: BuiltInToolsSetting;
  customTools?: CustomToolsConfig | false;
  tools?: StructuredToolInterface[] | BaseToolkit[] | ServerTool[];
  /**
   * Restrict the discovery agent to this allow-list of tool names, applied after every tool
   * source (filesystem, built-in, custom, MCP, A2A, and `tools`) is resolved. Unlike
   * `builtInTools`/`customTools`/`filesystem` (which gate whole tool groups), this trims the
   * final tool set by exact name, so it can pare down MCP server tools
   * (e.g. "mcp__jira__getJiraIssue") and the discovery helper tools to the minimum needed.
   *
   * `set_requirements` is always retained regardless, since it is how the discovery agent
   * records the requirements it found. When omitted, all resolved tools remain available; an
   * empty array keeps only `set_requirements`. The discovery agent never inherits the
   * top-level `GthConfig.allowedTools`, nor the command's own `allowedTools`; this property is
   * its only allow-list.
   */
  allowedTools?: string[];
}

/** One discovery agent run, as a command describes it. */
export interface DiscoveryAgentRun {
  /** The resolved config of the command the discovery runs inside. */
  config: GthConfig;
  /** That command's `discovery` block (tool overrides and the allow-list), if any. */
  discoveryConfig: RequirementsDiscoveryConfig | undefined;
  /** Label only: which verb a notice about this run should name. */
  owningCommand: 'pr' | 'review';
  /**
   * Reads the discovery prompt (mode prompt) for this command. A reader rather than the text so
   * the prompt is read inside the run's `try`, where it always was for `gth pr`: a prompt that
   * fails to read still gets the runner cleaned up and the ending announced.
   */
  readPrompt: () => string;
  /**
   * The user message. Evidence (a branch name, a PR description) must sit inside a delimited
   * block here, as data — never in the prompt, which is instructions.
   */
  userMessage: string;
  /**
   * Builds the command's own helper tools, which record their results in the caller's state.
   * Called each time the agent resolves its tools.
   */
  createDiscoveryTools: () => StructuredToolInterface[];
}

/**
 * Run the requirements discovery agent once, to completion or to whatever ended it. Results come
 * back through the caller's own tools (`set_requirements` and friends), not through the return
 * value. Errors from the run propagate after the termination notice has been printed.
 */
export async function runDiscoveryAgent(run: DiscoveryAgentRun): Promise<void> {
  const { config, discoveryConfig, owningCommand } = run;
  const runner = new GthAgentRunner(
    defaultStatusCallback,
    createDiscoveryResolvers(run.createDiscoveryTools)
  );
  try {
    // `command` stays undefined so the discovery agent runs on the chat prompt and does NOT pick up
    // the owning command's posture; `owningCommand` is label-only, so a notice about this run says
    // "the pr command" (or "the review command") rather than something the user cannot connect to
    // what they typed (GS2-81).
    //
    // **The checkpoint saver is not optional here, even though `init` accepts none.** An unset
    // command answers approvals (`commandAnswersApprovals`), and every helper tool a discovery
    // agent binds — `set_requirements`, and for `pr` also `set_diff`, `gh_pr`, `gh_diff`,
    // `gh_issue` — has no built-in access class, so all of them are in the rung-independent
    // interrupt set whatever the rung. The first tool call therefore suspends the graph on a
    // LangGraph interrupt, and an interrupt with nowhere to checkpoint throws
    // `MISSING_CHECKPOINTER` instead of suspending — which killed the whole discovery run on its
    // first tool call (EXT-120). That is why the saver lives HERE, in the one function both
    // commands call, rather than at each call site where a second copy could forget it.
    //
    // Per run, not per process: this saver's only job is to hold the graph one discovery run
    // suspends on, and that run dies with the runner it is created beside. `MemorySaver` is what
    // every other surface that drives a gating-capable agent hands the runner.
    //
    // GS2-20 — considered for the durable saver and deliberately kept in memory. This is an internal
    // helper run inside `gth pr` / `gth review`, not a conversation the user had; there is nothing
    // here anyone would ask to resume, and persisting it would put rows in the store with no
    // listing entry.
    await runner.init(
      undefined,
      getDiscoveryAgentConfig(config, discoveryConfig),
      new MemorySaver(),
      {
        owningCommand,
      }
    );
    await runner.processMessages([
      ...buildSystemMessages(config, run.readPrompt()),
      new HumanMessage(run.userMessage),
    ]);
  } finally {
    await runner.cleanup();
    // [[EXT-159]] — say why the DISCOVERY run ended, because on the ending that matters nobody
    // else will. Shared for the same reason as the saver above: both commands need it, and it was
    // a defect in the one that had it last.
    //
    // Several endings return from `processMessages` normally rather than throwing — the interrupt
    // drain giving up, the tool-error budget and the tool-loop guard ending the graph with
    // `jumpTo: 'end'`, an Esc or abort closing the stream, a tool exception returned as the turn's
    // answer, and a refusal or truncation classified from the provider's own metadata. Each leaves
    // the caller's state unset; `prCommand` then prints "Change requirements discovery did not
    // produce a diff" and RETURNS — so `review`'s own notice, the surface this run's ending used to
    // be attributed to, is never reached. One sentence that fits a dozen unrelated causes, printed
    // while the discriminating fact sat unread on this runner: the exact shape EXT-159 removed.
    //
    // In the `finally`, so the endings that DO throw are announced too. Note the ORDER that buys:
    // the `finally` unwinds ahead of the command's catch, so the notice prints FIRST and the
    // provider's prose (or the approvals negotiation transcript) follows it — a heading, then the
    // detail, rather than `reviewModule`'s error-then-notice.
    //
    // A successful discovery costs nothing: it classifies `completed`, which
    // `shouldAnnounceTermination` suppresses, so the review that follows is not preceded by a
    // notice about the sub-run that fed it. The one case that does print twice is a discovery that
    // ended abnormally AFTER the agent had already set what the review needs — the command then
    // continues to the review, and the user sees this notice and later the review's own. That is
    // two runs with two different endings, each stating its own, which is the intended reading
    // rather than a duplicate.
    //
    // Read after `cleanup()` for the reason `reviewModule` reads it there: the agent is gone by
    // here and the runner snapshots its innermost classification at cleanup.
    try {
      displayTermination(runner.getTerminationReason());
    } catch {
      /* fail-soft: explaining a run must never be what ends it */
    }
  }

  // The discovery agent streams its final text without a trailing newline, so emit a
  // blank line to separate it from the review agent's output that follows.
  displayInfo('');
}

/**
 * The config the discovery agent runs with: the command's config with the discovery block's tool
 * overrides applied, and the discovery allow-list in place of every other one.
 */
export function getDiscoveryAgentConfig(
  config: GthConfig,
  discoveryConfig: RequirementsDiscoveryConfig | undefined
): GthConfig {
  const baseTools = discoveryConfig?.tools ?? config.tools ?? [];
  const customTools =
    discoveryConfig && 'customTools' in discoveryConfig
      ? discoveryConfig.customTools
      : config.customTools;
  return {
    ...config,
    filesystem: discoveryConfig?.filesystem ?? config.filesystem,
    builtInTools: discoveryConfig?.builtInTools ?? config.builtInTools,
    customTools: customTools === false ? undefined : customTools,
    tools: baseTools,
    // The discovery agent must never inherit the top-level allow-list (e.g. a global
    // `allowedTools: []` meant to keep review agents tool-free would strip set_requirements
    // and silently neuter discovery). Only the command's `discovery.allowedTools` applies here,
    // always augmented with set_requirements so the agent can record what it found. The
    // agent applies this list after every tool source is resolved, so it also gates tools
    // supplied via `tools` in config.
    allowedTools: discoveryConfig?.allowedTools
      ? [...new Set([...discoveryConfig.allowedTools, 'set_requirements'])]
      : undefined,
  };
}

function createDiscoveryResolvers(
  createDiscoveryTools: () => StructuredToolInterface[]
): AgentResolvers {
  const baseResolvers = createResolvers();
  return {
    ...baseResolvers,
    resolveTools: async (effectiveConfig, command) => {
      const baseTools = baseResolvers.resolveTools
        ? await baseResolvers.resolveTools(effectiveConfig, command)
        : [];
      return [...baseTools, ...createDiscoveryTools()];
    },
  };
}
