import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BinaryFormatConfig, BinaryFormatType } from '@gaunt-sloth/core/config.js';

export interface BinaryReadResult {
  data: string;
  size: number;
  mimeType: string;
}

export const DEFAULT_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function getMimeType(ext: string, config?: BinaryFormatConfig): string {
  if (config?.mimeTypes?.[ext]) {
    return config.mimeTypes[ext];
  }
  return DEFAULT_MIME_TYPES[ext] || 'application/octet-stream';
}

export function getFormatForExtension(
  filePath: string,
  configs: BinaryFormatConfig[]
): { type: BinaryFormatType; config: BinaryFormatConfig } | null {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (!ext) {
    return null;
  }

  let binaryConfig: BinaryFormatConfig | undefined;

  for (const config of configs) {
    if (config.type === 'binary') {
      binaryConfig = config;
      continue;
    }
    if (config.extensions.includes(ext)) {
      return { type: config.type, config };
    }
  }

  if (binaryConfig && binaryConfig.extensions.includes(ext)) {
    return { type: 'binary', config: binaryConfig };
  }

  return null;
}

export async function readBinaryFile(
  filePath: string,
  maxSize: number,
  mimeType: string
): Promise<BinaryReadResult> {
  const stats = await stat(filePath);

  if (stats.size > maxSize) {
    throw new Error(
      `File size (${stats.size} bytes) exceeds maximum allowed (${maxSize} bytes) for ${path.basename(filePath)}`
    );
  }

  const buffer = await readFile(filePath);
  return {
    data: buffer.toString('base64'),
    size: stats.size,
    mimeType,
  };
}
