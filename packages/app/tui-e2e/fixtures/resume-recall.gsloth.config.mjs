/**
 * [[GS2-20]] PTY e2e config: a REAL lean `code` session on the plain readline surface whose
 * scripted model **answers out of the graph state it is given**.
 *
 * The point is the resume, and the only honest evidence for it is a model that cannot fake the
 * answer: asked to look the code up it calls `run_shell_command`, and the value comes back from a
 * real `echo` — nothing else in the run knows it. Asked anything else it reports the most recent
 * tool result it can see, or `recall:NOTHING-IN-STATE` when the state holds none. So a second
 * session that prints the marker read it from the checkpoint the first session left, and one that
 * prints `NOTHING-IN-STATE` did not — which is exactly the distinction `--resume` has to make.
 *
 * `bypass` because approvals are not the subject here: the rung would put the shell call to a human
 * and there is nobody to ask. The command is an `echo` of a constant.
 *
 * Hermetic and key-free. History is NOT off — GS2-20 made recording the default, and the recorded
 * conversation is what this fixture exists to resume — so the suite clamps HOME to a throwaway
 * directory and removes it afterwards (`fixtures/tmpHome.mjs`).
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

/** The value only the tool produces. Kept here so the test imports it rather than transcribing it. */
export const RECALL_MARKER = 'GSLOTH-RESUME-ORBIT-4417';
/** What the model says when the state it was handed carries no tool result at all. */
export const NOTHING_MARKER = 'recall:NOTHING-IN-STATE';
/** The prompt that makes the model call the tool. */
export const LOOKUP_PROMPT = 'look up the code';

class RecallingModel extends BaseChatModel {
  _llmType() {
    return 'scripted-recall-e2e';
  }
  bindTools() {
    return this;
  }

  async _generate(messages) {
    const toolResult = [...messages].reverse().find((m) => ToolMessage.isInstance(m));
    const lastHuman = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
    const ask = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    let message;
    if (ask.includes(LOOKUP_PROMPT)) {
      message = toolResult
        ? new AIMessage('looked-it-up-marker')
        : new AIMessage({
            content: '',
            tool_calls: [
              {
                name: 'run_shell_command',
                args: { command: `echo ${RECALL_MARKER}` },
                id: 'call-lookup',
              },
            ],
          });
    } else {
      const seen = toolResult ? String(toolResult.content).trim() : null;
      message = new AIMessage(seen ? `recall:${seen}` : NOTHING_MARKER);
    }
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

export async function configure() {
  return {
    llm: new RecallingModel({}),
    modelDisplayName: 'scripted-recall-e2e',
    writeOutputToFile: false,
    // Not the subject: the rung would put the `echo` to a human, and there is nobody to ask.
    approvals: 'bypass',
    // The plain readline surface, which is the one a piped seeding run can drive.
    tui: false,
  };
}
