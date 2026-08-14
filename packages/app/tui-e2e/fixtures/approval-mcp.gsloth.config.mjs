/**
 * [[TUI-C88]] PTY e2e config: a REAL lean `code` session with a REAL MCP server attached, whose
 * scripted model calls that server's tool — so the `mcpTool` arm of the approval prompt can be read
 * off a real terminal.
 *
 * **The server is the point, not the config entry.** The approval interrupt is wired over the
 * **bound** tool names, so a tool only reaches the gate if an MCP client really registered it from a
 * real handshake. `mcpFixtureServer.mjs` beside this file is that server, spoken to over stdio; the
 * registered name it produces is `mcp__fixture__ping`, and `fixture` — the key below — is the
 * identity the prompt has to print.
 *
 * `manual` is the rung, for the same reason the sibling `write_file` fixture uses it: an MCP tool
 * carries no access class, so no rung grants it, and `manual` is the plain deterministic rung with
 * no rating call in the way. Nothing about the prompt is scripted — the model asks for the tool, the
 * gate decides, and the TUI renders whatever the gate handed it.
 *
 * **The call is always refused**, so the tool never executes. This is a test about the question, not
 * the answer.
 *
 * The server is launched with `process.execPath` and an absolute path derived from `import.meta.url`
 * rather than a bare `node` and a written-out path: no PATH lookup to differ across platforms, and
 * no path literal that could only be spelled the POSIX way.
 *
 * Imports resolve from this file's location up to packages/app's own @langchain/core dependency,
 * so no extra devDependency is needed.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { fileURLToPath } from 'node:url';

/** The registered name mcp-adapters composes for the fixture server's one tool. */
const MCP_TOOL = 'mcp__fixture__ping';

class ScriptedMcpCallingModel extends BaseChatModel {
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
    // One MCP request per user turn; conclude once a tool result (here always the HITL rejection
    // ToolMessage) has been observed, so the turn ends rather than looping.
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('approval-mcp-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [{ name: MCP_TOOL, args: {}, id: `call-${this.callCount}` }],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedMcpCallingModel({}),
    modelDisplayName: 'scripted-e2e',
    // Hermetic and quiet: no per-run md log in the fixtures dir, no history store writes.
    writeOutputToFile: false,
    // No rung grants a tool with no access class, and `manual` is the deterministic rung that asks
    // the human directly rather than routing through a rater.
    approvals: 'manual',
    mcpServers: {
      // The key IS the server identity the `mcpTool` prompt prints, and the one the registered tool
      // name is resolved against.
      fixture: {
        transport: 'stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('./mcpFixtureServer.mjs', import.meta.url))],
      },
    },
  };
}
