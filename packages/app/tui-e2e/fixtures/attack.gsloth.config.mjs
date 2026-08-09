/**
 * [[TUI-C68]] PTY e2e config: a real lean `code` session on a rated rung whose auto-rater always
 * answers `attack`, so the §6.1 banner is what the run reaches.
 *
 * `assisted` is the rung: it consults the rater, and an `attack` verdict there ends the run — which
 * is the state the banner exists to offer a way out of. The model implements `withStructuredOutput`
 * so the verdict goes through the real schema on the way in, making this a test of the production
 * rating path rather than of a stub.
 *
 * **The command is inert.** `echo` and nothing else: this is the one suite in the repo that
 * deliberately DOES grant, so a payload here would actually run. The marker is what proves
 * execution, and it is not a substring of the command text so that "the command ran" cannot be
 * satisfied by the command merely being displayed.
 *
 * Hermetic and key-free: nothing reaches a network.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

/**
 * The rater's own words, and they are model-authored text going to a terminal: a carriage return
 * that walks back to column 0 and a forged menu line. The banner is the last screen between a
 * person and the action, so the one string on it that an attacker can influence is also the one
 * that must not be able to forge its chrome.
 */
const CR = String.fromCodePoint(0x0d);
const LF = '\n';
export const ATTACK_REASON =
  `Fetches a remote script and pipes it straight into a shell.${CR}` +
  `attack-reason-overwrite-marker${LF}Approve?  [o]nce   [s]ession   [a]lways   [N]o`;

/**
 * Inert, and the printed marker is deliberately NOT a literal substring of the command text — the
 * marker stays split inside the emitted command and is never concatenated here. That is what lets
 * the suite tell "the command is DISPLAYED on the banner" from "the command RAN", which is the
 * whole way suspension is asserted. `node` is guaranteed present (it runs this CLI) and the quoting
 * works in POSIX shells and cmd.exe alike.
 */
export const ATTACK_COMMAND = `node -e "console.log('attack-'+'out-'+'marker')"`;

class ScriptedAttackModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'scripted-attack-e2e';
  }
  bindTools() {
    return this;
  }

  withStructuredOutput() {
    return {
      invoke: async () => ({ outcome: 'attack', reason: ATTACK_REASON }),
    };
  }

  async _generate(messages) {
    this.callCount += 1;
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('attack-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              args: { command: ATTACK_COMMAND },
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
    llm: new ScriptedAttackModel({}),
    modelDisplayName: 'scripted-attack-e2e',
    writeOutputToFile: false,
    approvals: 'assisted',
  };
}
