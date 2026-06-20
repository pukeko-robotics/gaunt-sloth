import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GthConfig } from '@gaunt-sloth/core/config.js';

// TODO figure out if there is a pre-built tool or at least description builder available in a2a-js
const toolDefinition = {
  name: 'show_a2ui_surface',
  description: `Display an interactive UI surface. Pass A2UI JSONL (two newline-separated JSON lines):
Line 1: {"surfaceUpdate":{"surfaceId":"ID","components":[{"id":"COMP_ID","component":{"TypeName":{...}}}]}}
Line 2: {"beginRendering":{"surfaceId":"ID","root":"ROOT_COMP_ID"}}
Supported types (PascalCase): Text {text:{literalString:"..."},usageHint?:"h1|h2|h3|body|caption"}, Button {label:{literalString:"..."},action:{name:"..."}}, TextField {label:{literalString:"..."}}, Column {children:{explicitList:["id1","id2"]}}, Row {children:{explicitList:["id1","id2"]}}.
Example email form surfaceJsonl (each line is one JSON object, no trailing comma between lines):
{"surfaceUpdate":{"surfaceId":"f1","components":[{"id":"lbl","component":{"Text":{"text":{"literalString":"Email"}}}},{"id":"fld","component":{"TextField":{"label":{"literalString":"Your email"}}}},{"id":"btn","component":{"Button":{"label":{"literalString":"Submit"},"action":{"name":"submit"}}}},{"id":"col","component":{"Column":{"children":{"explicitList":["lbl","fld","btn"]}}}}]}}
{"beginRendering":{"surfaceId":"f1","root":"col"}}`,
  schema: z.object({
    surfaceJsonl: z
      .string()
      .describe(
        'A2UI JSONL: newline-separated JSON objects. Line 1: surfaceUpdate with components array. Line 2: beginRendering with root component id.'
      ),
  }),
};

const toolImpl = ({ surfaceJsonl }: { surfaceJsonl: string }): string => {
  return surfaceJsonl;
};

export function get(_: GthConfig) {
  return tool(toolImpl, toolDefinition);
}
