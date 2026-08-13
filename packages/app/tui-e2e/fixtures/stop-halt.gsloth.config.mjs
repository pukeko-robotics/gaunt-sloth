/**
 * [[TUI-C71]] PTY e2e config: a real lean `code` session on a rated rung whose auto-rater always
 * answers `attack`, proposing a command built to forge terminal chrome.
 *
 * `assisted` consults the rater, and an `attack` verdict there offers [[TUI-C68]]'s §6.1 banner and
 * then ENDS the run when the banner is not answered with the phrase. The message that ending
 * carries is this node's subject.
 *
 * Deliberately distinct from `attack.gsloth.config.mjs`, which shares the always-`attack` rater and
 * nothing else: that suite is the one place in the repo that DOES grant, so its command must stay
 * inert and unremarkable. This one's command is the payload, and no test here answers the banner
 * with the phrase.
 *
 * Hermetic and key-free: nothing reaches a network, and the payload is an `echo` besides.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { STOP_COMMAND, STOP_REASON } from './stopFixtures.mjs';

class ScriptedStopModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'scripted-stop-e2e';
  }
  bindTools() {
    return this;
  }

  withStructuredOutput() {
    return {
      invoke: async () => ({ outcome: 'attack', reason: STOP_REASON }),
    };
  }

  async _generate(messages) {
    this.callCount += 1;
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('stop-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              args: { command: STOP_COMMAND },
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
    llm: new ScriptedStopModel({}),
    modelDisplayName: 'scripted-stop-e2e',
    writeOutputToFile: false,
    approvals: 'assisted',
  };
}
