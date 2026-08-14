/**
 * [[TUI-C67]] PTY e2e config: a REAL lean `code` session whose scripted model calls a **non-shell**
 * gated tool, so the approval prompt's opening sentence can be read off a real terminal for a call
 * that is not a shell command.
 *
 * `write_file` and the `manual` rung are the pair that makes this the honest case. §2.2 grants the
 * write access class from `write` up, so at `write` this call would never be gated at all; `manual`
 * is the rung whose grant stops at the read built-ins, which is exactly where a file write reaches
 * a human. Nothing about the prompt is scripted — the model asks for the tool, the gate decides,
 * and the TUI renders whatever the gate handed it.
 *
 * **The write never happens, by design.** Every case in the suite answers the prompt with a
 * refusal, so the tool is not executed and no file is created next to these fixtures. The prompt is
 * the whole subject here; executing the write would only add a way for the suite to dirty a tracked
 * directory.
 *
 * Imports resolve from this file's location up to packages/app's own @langchain/core dependency,
 * so no extra devDependency is needed.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

class ScriptedWriteCallingModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'scripted-e2e';
  }
  // The ReAct graph binds tools to the model; responses are scripted, so binding is a no-op.
  bindTools() {
    return this;
  }

  async _generate(messages) {
    this.callCount += 1;
    const last = messages[messages.length - 1];
    // One write request per user turn; conclude once a tool result (here always the HITL rejection
    // ToolMessage) has been observed, so the turn ends rather than looping.
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('approval-tool-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'write_file',
              args: {
                // Relative to the session's project dir. It is never created — every case refuses.
                path: 'approval-tool-e2e-never-written.txt',
                content: 'approval-tool-write-marker',
              },
              id: `call-${this.callCount}`,
            },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedWriteCallingModel({}),
    modelDisplayName: 'scripted-e2e',
    // Hermetic and quiet: no per-run md log in the fixtures dir, no history store writes.
    writeOutputToFile: false,
    // The rung is the point, not a default: `manual` is the only one whose grant does not cover the
    // write access class, so it is the rung at which a file write is put to a human at all.
    approvals: 'manual',
  };
}
