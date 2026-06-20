import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { GthConfig } from '@gaunt-sloth/core/config.js';

const toolDefinition = {
  name: 'gth_status_update',
  description: `Gaunt Sloth Status Update Tool. Use this tool to update status in the console. Example: gth_status_update "Working on something important", be brief, feel free to use emojis. Update after using tools.`,
  schema: z.string(),
};
const toolImpl = (s: string): void => {
  displayInfo(s);
};

export function get(_: GthConfig) {
  return tool(toolImpl, toolDefinition);
}
