/**
 * [[EXT-80]] review finding — **does an approval interrupt raised INSIDE a `task` subagent surface
 * to the parent, where the runner reads it?**
 *
 * `createDeepAgent` installs `createSubAgentMiddleware({ defaultInterruptOn: interruptOn, … })`, so
 * a subagent is configured with the parent's gated set. That is a statement about configuration.
 * Whether a nested subgraph interrupt actually reaches
 * `GthAbstractAgent.getPendingToolInterrupts` — which reads only the PARENT's
 * `state.tasks[].interrupts[].value.actionRequests` — is a different question, and it decides how
 * much the gate on `task` is doing.
 *
 * **Measured here: it does propagate, and the decision routes back into the child.** So a
 * subagent's own gated calls are gated in their own right, and gating `task` is belt-and-braces
 * rather than the only thing between a `manual` session and an unprompted nested write. Both
 * halves are asserted, because "it surfaces" alone would leave open the worse failure — a run that
 * suspends where the runner can see it and resumes somewhere else.
 *
 * Driven against the REAL deepagents graph with a scripted model — a source read cannot answer it,
 * and the reviewer who raised this was explicit that configuration is not behaviour. Deliberately
 * no gsloth wrapper: `GthDeepAgent` would add config resolution, a real filesystem backend and a
 * system prompt, none of which bear on where an interrupt is parked.
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgent } from 'deepagents';

/** What `GthAbstractAgent.getPendingToolInterrupts` reports, read exactly as it reads it. */
function pendingInterruptNames(state: unknown): string[] {
  const names: string[] = [];
  const tasks = (state as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return names;
  for (const task of tasks) {
    const interrupts = (task as { interrupts?: unknown })?.interrupts;
    if (!Array.isArray(interrupts)) continue;
    for (const interrupt of interrupts) {
      const actionRequests = (interrupt as { value?: { actionRequests?: unknown } })?.value
        ?.actionRequests;
      if (!Array.isArray(actionRequests)) continue;
      for (const action of actionRequests) {
        const name = (action as { name?: unknown })?.name;
        if (typeof name === 'string') names.push(name);
      }
    }
  }
  return names;
}

/**
 * Scripts a two-level conversation with no provider: the parent delegates once, the child writes
 * once, and either level concludes as soon as it has seen a tool result. The two levels are told
 * apart by the FIRST human message, which for a subagent is the `description` the `task` call
 * carried — deepagents replaces the child's message list with exactly that one message.
 */
class ScriptedTwoLevelModel extends BaseChatModel {
  parentCalls = 0;
  childCalls = 0;
  _llmType(): string {
    return 'scripted-two-level';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const first = messages.find((m) => HumanMessage.isInstance(m));
    const isChild =
      typeof first?.content === 'string' && first.content.includes('CHILD: write the file');
    const last = messages[messages.length - 1];
    let message: AIMessage;
    if (ToolMessage.isInstance(last)) {
      message = new AIMessage('done');
    } else if (isChild) {
      this.childCalls++;
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            name: 'write_file',
            args: { file_path: 'child.txt', content: 'written by the child' },
            id: `child-${this.childCalls}`,
          },
        ],
      });
    } else {
      this.parentCalls++;
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            name: 'task',
            args: {
              description: 'CHILD: write the file',
              subagent_type: 'general-purpose',
            },
            id: `parent-${this.parentCalls}`,
          },
        ],
      });
    }
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

const gated = (...names: string[]) =>
  Object.fromEntries(names.map((n) => [n, { allowedDecisions: ['approve', 'reject'] }]));

/** Run until the graph stops, and report what the parent's checkpoint says is pending. */
async function runAndInspect(interruptOn: Record<string, unknown>, threadId: string) {
  const model = new ScriptedTwoLevelModel({});
  const graph = createDeepAgent({
    model: model as never,
    interruptOn: interruptOn as never,
    checkpointer: new MemorySaver(),
  });
  const config = { configurable: { thread_id: threadId }, recursionLimit: 30 };
  try {
    await graph.invoke({ messages: [new HumanMessage('delegate it')] }, config);
  } catch {
    // A GraphInterrupt surfaces as a throw on some paths; the checkpoint is what we read either way.
  }
  const state = await graph.getState(config);
  return { model, graph, config, state, pending: pendingInterruptNames(state) };
}

describe("EXT-80 — a subagent's own gated call, seen from the parent", () => {
  it('gates task itself, so the delegation is what the human approves', async () => {
    // The shape this branch ships: `task` has no access class, so both deterministic rungs gate it.
    const { pending, model } = await runAndInspect(gated('write_file', 'task'), 'task-gated');

    expect(pending).toEqual(['task']);
    // The parent suspended BEFORE delegating: the child never ran.
    expect(model.childCalls).toBe(0);
  });

  /**
   * **MEASURED: a nested interrupt DOES propagate.** With only the child's own tool gated, the
   * parent delegates, the child calls `write_file`, and that call appears in the PARENT's
   * `state.tasks[].interrupts[].value.actionRequests` — the one place
   * `GthAbstractAgent.getPendingToolInterrupts` looks. So a subagent's writes are gated in their own
   * right and the gate on `task` is belt-and-braces rather than the only thing standing between a
   * `manual` session and an unprompted write.
   */
  it('surfaces a nested write_file interrupt in the PARENT state, where the runner reads it', async () => {
    const { pending, model } = await runAndInspect(gated('write_file'), 'nested-only');

    // The delegation really happened and the child really tried to write — without this the
    // assertion below would pass on a run in which nothing was delegated at all.
    expect(model.parentCalls).toBeGreaterThan(0);
    expect(model.childCalls).toBeGreaterThan(0);

    expect(pending).toEqual(['write_file']);
  });

  /**
   * The other half, and the one a "yes it surfaces" answer would otherwise leave open: **the
   * decision must route back INTO the child.** A run that suspends where the runner can see it but
   * resumes somewhere else is a hang or a lost turn, which is a worse failure than an unprompted
   * write, not a better one.
   */
  it('routes the decision back into the child, so the delegation completes', async () => {
    const { graph, config, model } = await runAndInspect(gated('write_file'), 'nested-resume');
    const childCallsBeforeResume = model.childCalls;

    const { Command } = await import('@langchain/langgraph');
    const result = (await graph.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
      config
    )) as { messages?: { content?: unknown }[] };

    // Nothing is left pending, and the child was re-entered rather than restarted from the parent.
    const state = await graph.getState(config);
    expect(pendingInterruptNames(state)).toEqual([]);
    expect(model.parentCalls).toBe(1);
    expect(model.childCalls).toBeGreaterThanOrEqual(childCallsBeforeResume);
    // The parent finished its turn on the delegation's result.
    expect(result.messages?.length ?? 0).toBeGreaterThan(1);
  });
});
