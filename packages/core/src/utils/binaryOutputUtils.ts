import { writeFileSync, existsSync } from 'node:fs';
import { GthCommand } from '#src/core/types.js';
import { fileSafeLocalDate, getGslothFilePath, toFileSafeString } from '#src/utils/fileUtils.js';

interface InlineBinaryBlock {
  index: number;
  mimeType: string;
  data: string;
}

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

function getMimeExtension(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (MIME_TYPE_EXTENSIONS[normalized]) {
    return MIME_TYPE_EXTENSIONS[normalized];
  }

  const subtype = normalized.split('/')[1]?.split(';')[0]?.trim();
  if (!subtype) {
    return 'bin';
  }

  if (subtype === 'jpeg') {
    return 'jpg';
  }

  if (subtype.includes('+xml')) {
    return subtype.split('+')[0];
  }

  if (/^[a-z0-9]+$/.test(subtype) && subtype.length <= 4) {
    return subtype;
  }

  return 'bin';
}

function getBinaryOutputFilePath(command: GthCommand | undefined, extension: string): string {
  const dateTimeStr = fileSafeLocalDate();
  const commandStr = toFileSafeString((command ?? 'output').toUpperCase());
  const normalizedExtension = extension.replace(/^\./, '') || 'bin';
  const filename = `gth_${dateTimeStr}_${commandStr}.${normalizedExtension}`;
  const initialPath = getGslothFilePath(filename);

  if (!existsSync(initialPath)) {
    return initialPath;
  }

  const suffixBase = initialPath.slice(0, -(normalizedExtension.length + 1));
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${suffixBase}_${suffix}.${normalizedExtension}`;
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  return `${suffixBase}_${Date.now()}.${normalizedExtension}`;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) {
    return null;
  }
  const commaPos = url.indexOf(',');
  if (commaPos === -1) {
    return null;
  }
  const meta = url.slice(5, commaPos);
  const data = url.slice(commaPos + 1);
  if (!data) {
    return null;
  }
  const parts = meta.split(';');
  const mimeType = parts[0]?.trim() || 'application/octet-stream';
  return { mimeType, data };
}

function tryExtractBinaryFromBlock(block: unknown): { mimeType: string; data: string } | null {
  if (block === null || block === undefined) {
    return null;
  }

  if (typeof block === 'string') {
    return parseDataUrl(block);
  }

  if (typeof block !== 'object') {
    return null;
  }

  const obj = block as Record<string, unknown>;

  // Check inlineData / inline_data (nested or flat)
  const inlineObj = (obj.inlineData ?? obj.inline_data) as Record<string, unknown> | undefined;
  if (inlineObj && typeof inlineObj === 'object') {
    const mimeType = (inlineObj.mimeType ?? inlineObj.mime_type ?? inlineObj.media_type) as
      string | undefined;
    const data = inlineObj.data as string | undefined;
    if (typeof mimeType === 'string' && typeof data === 'string') {
      return { mimeType, data };
    }
  }

  // Check image_url / imageUrl
  const imageUrl = obj.image_url ?? obj.imageUrl;
  if (imageUrl) {
    if (typeof imageUrl === 'string') {
      const parsed = parseDataUrl(imageUrl);
      if (parsed) return parsed;
    } else if (typeof imageUrl === 'object' && imageUrl !== null) {
      const url = (imageUrl as Record<string, unknown>).url;
      if (typeof url === 'string') {
        const parsed = parseDataUrl(url);
        if (parsed) return parsed;
      }
    }
  }

  // Check source property (Anthropic / LangChain image source)
  const source = obj.source as Record<string, unknown> | undefined;
  if (source && typeof source === 'object') {
    const mimeType = (source.media_type ?? source.mime_type ?? source.mimeType) as
      string | undefined;
    const data = source.data as string | undefined;
    if (typeof data === 'string') {
      if (typeof mimeType === 'string') {
        return { mimeType, data };
      }
      const parsed = parseDataUrl(data);
      if (parsed) return parsed;
    }
  }

  // Check flat properties (mimeType / mime_type / media_type and data)
  const mimeType = (obj.mimeType ?? obj.mime_type ?? obj.media_type) as string | undefined;
  const data = obj.data as string | undefined;
  if (typeof mimeType === 'string' && typeof data === 'string') {
    return { mimeType, data };
  }

  // Check flat url property
  if (typeof obj.url === 'string') {
    const parsed = parseDataUrl(obj.url);
    if (parsed) return parsed;
  }

  // Check flat data property if it's a data URL
  if (typeof data === 'string') {
    const parsed = parseDataUrl(data);
    if (parsed) return parsed;
  }

  return null;
}

export function extractInlineBinaryBlocks(content: unknown): InlineBinaryBlock[] {
  if (content === null || content === undefined) {
    return [];
  }

  const items = Array.isArray(content) ? content : [content];

  const results: InlineBinaryBlock[] = [];
  items.forEach((block, index) => {
    const extracted = tryExtractBinaryFromBlock(block);
    if (extracted) {
      results.push({
        index,
        mimeType: extracted.mimeType,
        data: extracted.data,
      });
    }
  });

  return results;
}

export function renderAssistantContent(
  content: unknown,
  binaryPlaceholders: Map<number, string> = new Map()
): string {
  if (content === undefined || content === null) {
    return '';
  }

  if (binaryPlaceholders.has(0) && (typeof content === 'string' || !Array.isArray(content))) {
    return binaryPlaceholders.get(0)!;
  }

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content);
  }

  return content
    .map((block, index) => {
      if (binaryPlaceholders.has(index)) {
        return binaryPlaceholders.get(index);
      }
      if (typeof block === 'string') {
        return block;
      }
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text') {
        if ('text' in block && typeof block.text === 'string') {
          return block.text;
        }
      }
      return JSON.stringify(block);
    })
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join('\n');
}

export function materializeBinaryOutputs(
  content: unknown,
  command: GthCommand | undefined
): { renderedContent: string; successMessages: string[] } {
  const binaryBlocks = extractInlineBinaryBlocks(content);

  if (binaryBlocks.length === 0) {
    return {
      renderedContent: renderAssistantContent(content),
      successMessages: [],
    };
  }

  const placeholderMap = new Map<number, string>();
  const successMessages: string[] = [];

  for (const binaryBlock of binaryBlocks) {
    const extension = getMimeExtension(binaryBlock.mimeType);
    const filePath = getBinaryOutputFilePath(command, extension);
    try {
      writeFileSync(filePath, Buffer.from(binaryBlock.data, 'base64'));
      const placeholder = `[Binary model output saved: ${binaryBlock.mimeType} -> ${filePath}]`;
      placeholderMap.set(binaryBlock.index, placeholder);
      successMessages.push(`Wrote model output (${binaryBlock.mimeType}) to ${filePath}`);
    } catch {
      const errorPlaceholder = `[Failed to save binary output: ${binaryBlock.mimeType}]`;
      placeholderMap.set(binaryBlock.index, errorPlaceholder);
    }
  }

  return {
    renderedContent: renderAssistantContent(content, placeholderMap),
    successMessages,
  };
}
