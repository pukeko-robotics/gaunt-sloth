/**
 * [[TUI-C100]] PTY e2e config: a REAL lean `code` session whose scripted model asks for **two tool
 * calls in one assistant message** — a directory listing that is granted and runs, and a shell
 * command that stops at the approval gate.
 *
 * The pairing is what makes the round non-trivial: two calls, one of which the rung grants and one
 * of which it escalates. The gate suspends the whole round before either runs, so while the human
 * is being asked NEITHER has executed — and the defect this config reproduces is the *ended* signal
 * that used to be emitted for both anyway, drawn as a success tick and the word *done* one row
 * above the question asking whether the command may run at all.
 *
 * The shell command is never approved in these cases, so nothing is executed: the printed marker
 * ('approval-sibling-out-marker') is deliberately not a substring of the command text, so the case
 * can tell "the pending command is DISPLAYED" from "the command RAN".
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
