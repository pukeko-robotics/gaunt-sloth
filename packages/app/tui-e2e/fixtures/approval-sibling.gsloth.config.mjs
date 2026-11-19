/**
 * [[TUI-C100]] PTY e2e config: a REAL lean `code` session whose scripted model asks for **two tool
 * calls in one assistant message** — a directory listing that is granted and runs, and a shell
 * command that stops at the approval gate.
 *
 * The pairing is what makes the round non-trivial: two calls, one of which the rung grants and one
 * of which it escalates. The gate suspends the whole round before either runs, so while the human
 * is being asked NEITHER has executed and neither row may claim to be done. After the decision the
 * granted listing runs whatever the answer. The shell command runs only if it is approved; if it
 * is refused, it ends as an error carrying the refusal.
 *
 * The cases both approve and refuse the shell command. Its printed marker
 * ('approval-sibling-out-marker') is deliberately not a substring of the command text, so a case
 * can tell "the pending command is DISPLAYED" from "the command RAN": the marker is absent while
 * the prompt is open and after a refusal, and present after an approval.
 *
 * Imports resolve from this file's location up to packages/app's own @langchain/core dependency,
 * so no extra devDependency is needed.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

class ScriptedSiblingCallingModel extends BaseChatModel {
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
    // The marker stays SPLIT inside the emitted command, so it is not a literal substring of the
    // command text the prompt displays.
    const command = `node -e "console.log('approval-sibling-'+'out-'+'marker')"`;
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('approval-sibling-final-answer-marker')
      : new AIMessage({
          content: '',
          // Order matters: the granted read runs first and its result is what flushes the round,
          // carrying the gated sibling below with it.
          tool_calls: [
            {
              name: 'list_directory',
              args: { path: '.' },
              id: `call-read-${this.callCount}`,
            },
            {
              name: 'run_shell_command',
              args: { command },
              id: `call-shell-${this.callCount}`,
            },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedSiblingCallingModel({}),
    modelDisplayName: 'scripted-e2e',
    // Hermetic and quiet: no per-run md log in the fixtures dir. History is NOT off here — GS2-20
    // made recording the default, so a session on this fixture writes `<HOME>/.gsloth/history.db`.
    // What keeps that out of the repo is the throwaway HOME the suite clamps, removed afterwards by
    // `fixtures/tmpHome.mjs`.
    writeOutputToFile: false,
    // `write` is the rung that gates the shell while consulting no model — it always escalates to
    // the human — and whose grant already covers the read built-ins, so the listing runs without a
    // prompt of its own. That asymmetry is exactly the shape under test.
    approvals: 'write',
  };
}
