/**
 * [[TUI-C71]] PTY e2e config: the §6.2 path — an escalation with **nobody to ask**.
 *
 * Reached through `gth exec`, and that is the only way it can be reached at all: both interactive
 * surfaces wire a tool-approval callback, and `NonInteractiveEscalationError` is thrown precisely
 * where none is wired. `exec` runs the single-shot runtime, so its stderr is the whole of what a
 * person sees on this path — which is why that message carries so much untrusted text.
 *
 * The rung is `auto` and the rater always answers `destructive`, which is the one pairing that
 * yields §5's `reject` — so the agent is refused, re-proposes with a justification, and the third
 * refusal spends §5.3's consecutive cap and escalates. The message that comes out therefore carries
 * the command, the rating, the rater's reason **and the whole negotiation transcript**, which is
 * the field this node names as the one most likely to be forgotten.
 *
 * `run_shell_command` is off by default in `exec` and is switched on here: without it the agent has
 * no gated call to make and there is nothing to escalate.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { STOP_COMMAND, STOP_JUSTIFICATION, STOP_REASON } from './stopFixtures.mjs';

class ScriptedEscalationModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'scripted-escalation-e2e';
  }
  bindTools() {
    return this;
  }

  withStructuredOutput() {
    return {
      invoke: async () => ({ outcome: 'destructive', reason: STOP_REASON }),
    };
  }

  /**
   * The same command every time, with a justification from the second attempt on — the shape §5.6
   * is written about, and the one that makes a transcript worth showing: what matters is that the
   * agent proposed it three times against two refusals that each said what to fix.
   */
  async _generate() {
    this.callCount += 1;
    const message = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'run_shell_command',
          args: {
            command: STOP_COMMAND,
            ...(this.callCount > 1 ? { justification: STOP_JUSTIFICATION } : {}),
          },
          id: `call-${this.callCount}`,
        },
      ],
    });
    return { generations: [{ message, text: '' }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedEscalationModel({}),
    modelDisplayName: 'scripted-escalation-e2e',
    writeOutputToFile: false,
    approvals: 'auto',
    builtInTools: { run_shell_command: true },
  };
}
