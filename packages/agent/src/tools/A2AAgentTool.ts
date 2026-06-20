/**
 * @module A2AAgentTool
 * LangChain tool for interacting with A2A protocol agents.
 * @experimental A2A support is experimental and may change.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { A2AClientWrapper } from '#src/modules/a2a/A2AClientWrapper.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';

/**
 * Creates a LangChain tool for communicating with an A2A agent.
 * The tool will be named `a2a_agent_<agentId>`.
 * @param config - A2A agent configuration
 * @returns A DynamicStructuredTool for the agent
 * @experimental
 */
export const createA2AAgentTool = (config: { agentId: string; agentUrl: string }) => {
  const client = new A2AClientWrapper(config);

  return new DynamicStructuredTool({
    name: `a2a_agent_${config.agentId}`,
    description: `Interact with the external A2A agent '${config.agentId}'. Use this tool to delegate tasks or ask questions to the external agent.`,
    schema: z.object({
      message: z.string().describe('The message or task description to send to the agent.'),
    }),
    func: async ({ message }) => {
      debugLog(`Tool a2a_agent_${config.agentId} called with message: ${message}`);
      try {
        const response = await client.sendMessage(message);
        return response;
      } catch (error) {
        return `Error communicating with agent: ${(error as Error).message}`;
      }
    },
  });
};
