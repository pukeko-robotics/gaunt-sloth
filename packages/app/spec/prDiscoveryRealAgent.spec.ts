/**
 * EXT-120 — **`gth pr`'s discovery agent is a REAL LangGraph agent, so it must be handed a
 * checkpointer.**
 *
 * ## Why this file exists beside `prDiscovery.spec.ts`
 *
 * That file mocks `GthAgentRunner` wholesale. The runner is exactly the component that receives the
 * checkpoint saver and exactly the component that throws without one, so every cell in it stayed
 * green while a real `gth pr` died on the discovery agent's first tool call. The mock sits at the
 * layer that breaks — and it is module-scoped and hoisted, so a real-runner case cannot live in the
 * same file.
 *
 * This file replaces the mock with the production stack: a real `GthAgentRunner`, a real lean
 * `createAgent` graph, the real approvals gate, and the discovery agent's own five tools. Only the
 * MODEL is faked — a scripted `BaseChatModel`, no key and no network — and the two GitHub sources
 * the deterministic pre-pass calls, so the pre-pass is steered without touching `gh`.
 *
 * ## The pre-pass shape under test
 *
 * The diff resolves deterministically and the requirements come back empty, which is the live
 * trigger for the discovery agent: `runPrDiscovery` returns early only when BOTH are non-empty.
 *
 * ## The rung is the default one
 *
 * Nothing in the config below names `approvals`, so the session sits at `assisted`. That is the
 * point rather than an omission: the approval interrupt is installed **rung-independently** over
 * every bound tool any rung could gate, and none of the five discovery tools has a built-in access
 * class, so all five carry it at every rung. The interrupt therefore fires before the gate decides
 * anything — and with no checkpointer it throws instead of suspending. At `assisted` the runner
 * then approves the call with no rating and no prompt, which is why the fixture needs no rater
 * stub and why the defect was invisible to anyone reading the approvals config.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

const ghDiffMock = vi.hoisted(() => vi.fn());
const ghPrViewMock = vi.hoisted(() => vi.fn());

vi.mock('@gaunt-sloth/review/sources/ghPrDiffSource.js', () => ({ get: ghDiffMock }));
vi.mock('@gaunt-sloth/review/sources/ghPrViewSource.js', () => ({ get: ghPrViewMock }));

// The production resolvers would load the whole app toolset and dial MCP servers from a unit spec.
// An empty object leaves `createPrDiscoveryResolvers` contributing exactly the five discovery
// tools, which are the tools this regression is about.
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers: () => ({}) }));

const DETERMINISTIC_DIFF = 'diff --git a/src/a.ts b/src/a.ts';
const DISCOVERED_REQUIREMENTS = 'EXT-120: the requirements the agent found for itself';

/**
 * A minimal chat model that scripts a ReAct turn with no provider and no key: while the trailing
 * message is not a tool result it calls `set_requirements`, and once one comes back it concludes
 * with text. The same shape the ACP real-agent spec uses.
 */
class ScriptedRequirementsSettingModel extends BaseChatModel {
  callCount = 0;
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.callCount++;
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('Recorded the requirements.')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'set_requirements',
              args: { requirements: DISCOVERED_REQUIREMENTS },
              id: 'call-1',
            },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

/**
 * The persisted grant store and the prompt lookup both anchor at the project dir, so a spec driving
 * a gated call must clamp it or it reads (and writes) the real allow-list of whoever runs the suite.
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-pr-discovery-real-agent-spec-'));

function realAgentConfig(llm: BaseChatModel): GthConfig {
  return {
    llm,
    streamOutput: true,
    contentSource: 'github',
    requirementSource: 'github',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    // Raw-mode stdin does not exist under vitest.
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    commands: {
      pr: {
        contentSource: 'github',
        requirementSource: 'github',
        discovery: { enabled: true, deterministicDiff: true },
      },
      review: {},
    },
  } as Partial<GthConfig> as GthConfig;
}

/** What one discovery run reports back. */
interface DiscoveryRun {
  diff?: string;
  requirements?: string;
  /** The message the run died with, or undefined when it completed. */
  failure: string | undefined;
  /** How many times the scripted model was asked — 2 means the tool result got back to it. */
  modelCalls: number;
}

async function runDiscovery(): Promise<DiscoveryRun> {
  const llm = new ScriptedRequirementsSettingModel();
  const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
  try {
    const result = await runPrDiscovery(realAgentConfig(llm));
    return { ...result, failure: undefined, modelCalls: llm.callCount };
  } catch (error) {
    return { failure: (error as Error).message, modelCalls: llm.callCount };
  }
}

let priorProjectDir: string | undefined;
let priorInitCwd: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  priorProjectDir = peekProjectDir();
  priorInitCwd = process.env.INIT_CWD;
  setProjectDir(projectDir);
  ghDiffMock.mockResolvedValue(DETERMINISTIC_DIFF);
  // No PR metadata, so the pre-pass leaves the requirements empty and the discovery agent runs.
  ghPrViewMock.mockResolvedValue('');
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  if (priorInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = priorInitCwd;
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('EXT-120: the pr discovery agent, driven through the REAL runner and graph', () => {
  /**
   * The reported regression. Without a checkpointer the graph cannot suspend on the approval
   * interrupt, so the first tool call throws and the run produces nothing; with one, the same run
   * completes the call and the requirements the agent set come back to the caller.
   */
  it('completes a gated discovery tool call and returns what the agent set', async () => {
    const run = await runDiscovery();

    // Named rather than left to a bare "the run failed": a real-agent run has a dozen other ways to
    // throw, and only this assertion makes a red run say it is THE reported regression.
    expect(run.failure ?? '').not.toContain('No checkpointer set');
    expect(run.failure).toBeUndefined();
    // The behaviour the missing saver destroyed: the tool actually ran and mutated the discovery
    // state that `runPrDiscovery` returns.
    expect(run.requirements).toBe(DISCOVERED_REQUIREMENTS);
    // The deterministic half is untouched by the agent, and proves the pre-pass shape under test:
    // a diff was already resolved and only the requirements were missing.
    expect(run.diff).toBe(DETERMINISTIC_DIFF);
    // The tool RESULT went back to the model, so the call was resumed rather than merely dispatched.
    expect(run.modelCalls).toBe(2);
  }, 30000);
});
