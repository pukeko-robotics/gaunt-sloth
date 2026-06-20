/**
 * @packageDocumentation
 * Middleware to inject binary content (images, PDFs, audio) as HumanMessage.
 *
 * The gth_read_binary tool returns binary data as a special string format:
 * gth_read_binary;type:${type};path:${encodedPath};data:${media_type};base64,${data}
 * where path is URL-encoded to handle special characters like semicolons.
 *
 * This middleware:
 * 1. Detects the gth_read_binary tool calls
 * 2. Parses the special string format from ToolMessage content
 * 3. Injects HumanMessage with binary content blocks before next model call
 *
 * This works around LangChain's limitation where ToolMessage doesn't properly
 * support binary content blocks for most providers.
 */

import { createMiddleware, type AgentMiddleware } from 'langchain';
import path from 'node:path';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import { ToolMessage, HumanMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';

export interface BinaryContentInjectionMiddlewareSettings {
  name?: 'binary-content-injection';
}

interface ParsedBinaryContent {
  formatType: string;
  path: string;
  media_type: string;
  data: string;
}

/**
 * Parse the special binary format string returned by gth_read_binary tool.
 * Format: gth_read_binary;type:${type};path:${encodedPath};data:${media_type};base64,${data}
 * Path is URL-encoded to handle special characters.
 */
function parseBinaryContent(content: string): ParsedBinaryContent | null {
  if (!content.startsWith('gth_read_binary;')) {
    return null;
  }

  try {
    const parts = content.split(';');
    if (parts.length < 4) {
      return null;
    }

    const typeMatch = parts[1]?.match(/^type:(.+)$/);
    const pathMatch = parts[2]?.match(/^path:(.+)$/);
    const dataMatch = parts[3]?.match(/^data:(.+)$/);
    const base64Match = content.match(/;base64,(.+)$/);

    if (!typeMatch || !pathMatch || !dataMatch || !base64Match) {
      return null;
    }

    // Decode the URL-encoded path
    const decodedPath = decodeURIComponent(pathMatch[1]);

    return {
      formatType: typeMatch[1],
      path: decodedPath,
      media_type: dataMatch[1],
      data: base64Match[1],
    };
  } catch {
    return null;
  }
}

function createContentBlock(binaryData: ParsedBinaryContent): Record<string, unknown> {
  const { formatType, media_type, data } = binaryData;

  return {
    type: formatType,
    source_type: 'base64',
    mime_type: media_type,
    data,
    metadata: {
      filename: path.basename(binaryData.path),
    },
  };
}

function getFormatLabel(formatType: string): string {
  const labels: Record<string, string> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    file: 'file',
  };
  return labels[formatType] || 'file';
}

export function createBinaryContentInjectionMiddleware(
  _settings: BinaryContentInjectionMiddlewareSettings,
  _gthConfig: GthConfig
): Promise<AgentMiddleware> {
  debugLog('Creating binary content injection middleware');

  return Promise.resolve(
    createMiddleware({
      name: 'binary-content-injection',

      // Before next model call, detect and inject HumanMessage with binary content
      beforeModel: async (state) => {
        const messages = state.messages || [];

        // Find recent ToolMessages from gth_read_binary
        const binaryMessages: Array<{ message: ToolMessage; binaryData: ParsedBinaryContent }> = [];

        // Check last few messages (usually just need to check the most recent)
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
          const msg = messages[i];
          if (
            msg instanceof ToolMessage &&
            msg.name === 'gth_read_binary' &&
            typeof msg.content === 'string'
          ) {
            const parsedContent = parseBinaryContent(msg.content);
            if (parsedContent) {
              binaryMessages.push({ message: msg, binaryData: parsedContent });
            }
          }
        }

        // If we found binary content, inject HumanMessage(s)
        if (binaryMessages.length > 0) {
          debugLog(`Injecting ${binaryMessages.length} HumanMessage(s) with binary content`);

          const newMessages = [...messages];

          for (const { binaryData } of binaryMessages) {
            const formatLabel = getFormatLabel(binaryData.formatType);
            const contentBlock = createContentBlock(binaryData);

            const humanMessage = new HumanMessage({
              content: [
                {
                  type: 'text',
                  text: `Here is the ${formatLabel} content from the file:`,
                },
                contentBlock,
              ] as MessageContent,
            });

            newMessages.push(humanMessage);
          }

          // Return the modified state with new messages
          return {
            messages: newMessages,
          };
        }

        // No binary content, pass through
        return undefined;
      },
    })
  );
}
