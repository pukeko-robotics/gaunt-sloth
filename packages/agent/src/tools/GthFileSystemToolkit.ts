import { BaseToolkit, StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import os from 'os';
import { createTwoFilesPatch } from 'diff';
import { displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { shouldIgnoreFile } from '@gaunt-sloth/core/utils/aiignoreUtils.js';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import type { BinaryFormatConfig, BinaryFormatType } from '@gaunt-sloth/core/config.js';
import { getFormatForExtension, getMimeType, readBinaryFile } from '#src/tools/binaryUtils.js';

/**
 * Filesystem toolkit
 * Inspired by https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
 */

// TODO make it configurable
const IGNORED_DIRS = ['node_modules', '.git', '.idea', 'dist'];

// Helper function to create a tool with filesystem type
function createGthTool<T extends z.ZodSchema>(
  fn: (args: z.infer<T>) => Promise<string>,
  config: {
    name: string;
    description: string;
    schema: T;
  },
  gthFileSystemType: 'read' | 'write'
): StructuredToolInterface {
  const toolInstance = tool(fn, config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (toolInstance as any).gthFileSystemType = gthFileSystemType;
  return toolInstance;
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
  tail: z
    .number()
    .optional()
    .describe(
      'If provided, returns only the last N lines of the file. May be combined with head ' +
        '(no longer mutually exclusive): head+tail returns the first head lines, a ' +
        '`... [N lines skipped] ...` marker, then the last tail lines.'
    ),
  head: z
    .number()
    .optional()
    .describe(
      'If provided, returns only the first N lines of the file. May be combined with tail ' +
        '(no longer mutually exclusive): head+tail returns the first head lines, a ' +
        '`... [N lines skipped] ...` marker, then the last tail lines.'
    ),
});

const ReadBinaryArgsSchema = z.object({
  path: z.string().describe('Path to the binary file to read'),
  formatHint: z
    .enum(['image', 'file', 'audio', 'video'])
    .optional()
    .describe(
      'Optional hint for the format type. If not provided, determined from file extension via config.'
    ),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with'),
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format'),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z
    .enum(['name', 'size'])
    .optional()
    .default('name')
    .describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const DeleteFileArgsSchema = z.object({
  path: z.string(),
});

const DeleteDirectoryArgsSchema = z.object({
  path: z.string(),
  recursive: z.boolean().default(false).describe('If true, delete directory and all its contents'),
});

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

export interface GthFileSystemToolkitOptions {
  allowedDirectories?: string[];
  aiignoreConfig?: {
    enabled?: boolean;
    patterns?: string[];
  };
  binaryFormats?: false | BinaryFormatConfig[];
}

export default class GthFileSystemToolkit extends BaseToolkit {
  tools: StructuredToolInterface[];
  private allowedDirectories: string[];
  private aiignoreConfig?: {
    enabled?: boolean;
    patterns?: string[];
  };
  private binaryFormats?: false | BinaryFormatConfig[];

  constructor(options: GthFileSystemToolkitOptions = {}) {
    super();
    const allowedDirectories = options.allowedDirectories ?? [getCurrentWorkDir()];
    this.allowedDirectories = allowedDirectories.map((dir) =>
      this.normalizePath(path.resolve(this.expandHome(dir)))
    );
    this.aiignoreConfig = options.aiignoreConfig;
    this.binaryFormats = options.binaryFormats;
    this.tools = this.createTools();
  }

  /**
   * Get tools filtered by operation type
   */
  getFilteredTools(allowedOperations: ('read' | 'write')[]): StructuredToolInterface[] {
    return this.tools.filter((tool) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolType = (tool as any).gthFileSystemType;
      return allowedOperations.includes(toolType);
    });
  }

  private normalizePath(p: string): string {
    return path.normalize(p);
  }

  private isProtectedDirectory(dirPath: string): boolean {
    const normalizedPath = this.normalizePath(path.resolve(dirPath));
    return this.allowedDirectories.some(
      (allowedDir) => this.normalizePath(allowedDir) === normalizedPath
    );
  }

  private expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
      return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
  }

  private sanitizeRequestedPath(requestedPath: string): string {
    const trimmedPath = requestedPath.trim();
    if (trimmedPath.length === 0) {
      throw new Error('Path cannot be empty');
    }

    const unquotedPath = trimmedPath.replace(/^(['"`])(.*)\1$/, '$2');
    if (path.isAbsolute(unquotedPath)) {
      return unquotedPath;
    }

    if (unquotedPath.startsWith('./') || unquotedPath.startsWith('../')) {
      return unquotedPath;
    }

    return `./${unquotedPath}`;
  }

  private async validatePath(requestedPath: string): Promise<string> {
    const sanitizedPath = this.sanitizeRequestedPath(requestedPath);
    const expandedPath = this.expandHome(sanitizedPath);
    const absolute = path.isAbsolute(expandedPath)
      ? path.resolve(expandedPath)
      : path.resolve(getCurrentWorkDir(), expandedPath);

    const normalizedRequested = this.normalizePath(absolute);

    // Helper function to check if a path is within allowed directories
    const isWithinAllowedDir = (checkPath: string): boolean => {
      return this.allowedDirectories.some((allowedDir) => checkPath.startsWith(allowedDir));
    };

    // Check if the requested path is within allowed directories
    if (!isWithinAllowedDir(normalizedRequested)) {
      throw new Error(
        `Access denied - path outside allowed directories: ${absolute} not in ${this.allowedDirectories.join(', ')}`
      );
    }

    try {
      // Try to get the real path for existing files/directories
      const realPath = await fs.realpath(absolute);
      const normalizedReal = this.normalizePath(realPath);

      // Verify the real path (after resolving symlinks) is still within allowed directories
      if (!isWithinAllowedDir(normalizedReal)) {
        throw new Error('Access denied - symlink target outside allowed directories');
      }
      return realPath;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Path doesn't exist - validate that its parent directory exists and is within allowed directories
        let currentDir = path.dirname(absolute);
        while (currentDir !== path.dirname(currentDir)) {
          try {
            const realParentPath = await fs.realpath(currentDir);
            const normalizedParent = this.normalizePath(realParentPath);

            if (!isWithinAllowedDir(normalizedParent)) {
              throw new Error('Access denied - parent directory outside allowed directories');
            }

            return absolute; // Valid parent exists, return the original absolute path
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (parentError: any) {
            if (parentError.code === 'ENOENT') {
              currentDir = path.dirname(currentDir); // Move up one level
            } else {
              throw parentError; // Some other error
            }
          }
        }

        // Could not find any existing parent in the path
        throw new Error(`Cannot determine valid parent directory for: ${absolute}`);
      }
      // Some other error
      throw error;
    }
  }

  private async getFileStats(filePath: string): Promise<FileInfo> {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      permissions: stats.mode.toString(8).slice(-3),
    };
  }

  private async searchFiles(
    rootPath: string,
    pattern: string,
    excludePatterns: string[] = []
  ): Promise<string[]> {
    const results: string[] = [];
    const aiignoreConfig = this.aiignoreConfig;
    const pendingDirs: string[] = [rootPath];

    while (pendingDirs.length > 0) {
      const currentPath = pendingDirs.pop();
      if (!currentPath) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = (await fs.readdir(currentPath, {
          withFileTypes: true,
          encoding: 'utf8',
        })) as Dirent[];
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryName = entry.name.toString();
        const fullPath = path.join(currentPath, entryName);

        try {
          await this.validatePath(fullPath);

          const relativePath = path.relative(rootPath, fullPath);
          const shouldExclude = excludePatterns.some((pattern) => {
            const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
            return path.matchesGlob(relativePath, globPattern);
          });

          if (shouldExclude) {
            continue;
          }

          const shouldIgnore = shouldIgnoreFile(
            fullPath,
            getCurrentWorkDir(),
            aiignoreConfig?.patterns,
            aiignoreConfig?.enabled
          );

          if (shouldIgnore) {
            continue;
          }

          if (entryName.toLowerCase().includes(pattern.toLowerCase())) {
            results.push(fullPath);
          }

          let isDirectory = entry.isDirectory();
          if (
            !isDirectory &&
            typeof entry.isSymbolicLink === 'function' &&
            entry.isSymbolicLink()
          ) {
            try {
              const stats = await fs.stat(fullPath);
              isDirectory = stats.isDirectory();
            } catch {
              isDirectory = false;
            }
          }

          if (isDirectory) {
            pendingDirs.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }

    return results;
  }

  private normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
  }

  private createUnifiedDiff(
    originalContent: string,
    newContent: string,
    filepath: string = 'file'
  ): string {
    const normalizedOriginal = this.normalizeLineEndings(originalContent);
    const normalizedNew = this.normalizeLineEndings(newContent);

    return createTwoFilesPatch(
      filepath,
      filepath,
      normalizedOriginal,
      normalizedNew,
      'original',
      'modified'
    );
  }

  private async applyFileEdits(
    filePath: string,
    edits: Array<{ oldText: string; newText: string }>,
    dryRun = false
  ): Promise<string> {
    const content = this.normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

    let modifiedContent = content;
    for (const edit of edits) {
      const normalizedOld = this.normalizeLineEndings(edit.oldText);
      const normalizedNew = this.normalizeLineEndings(edit.newText);

      if (modifiedContent.includes(normalizedOld)) {
        modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
        continue;
      }

      const oldLines = normalizedOld.split('\n');
      const contentLines = modifiedContent.split('\n');
      let matchFound = false;

      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        const potentialMatch = contentLines.slice(i, i + oldLines.length);

        const isMatch = oldLines.every((oldLine, j) => {
          const contentLine = potentialMatch[j];
          return oldLine.trim() === contentLine.trim();
        });

        if (isMatch) {
          const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
          const newLines = normalizedNew.split('\n').map((line, j) => {
            if (j === 0) return originalIndent + line.trimStart();
            const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
            const newIndent = line.match(/^\s*/)?.[0] || '';
            if (oldIndent && newIndent) {
              const relativeIndent = newIndent.length - oldIndent.length;
              return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
            }
            return line;
          });

          contentLines.splice(i, oldLines.length, ...newLines);
          modifiedContent = contentLines.join('\n');
          matchFound = true;
          break;
        }
      }

      if (!matchFound) {
        throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
      }
    }

    const diff = this.createUnifiedDiff(content, modifiedContent, filePath);

    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
      numBackticks++;
    }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

    if (!dryRun) {
      await fs.writeFile(filePath, modifiedContent, 'utf-8');
    }

    return formattedDiff;
  }

  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';

    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i === 0) return `${bytes} ${units[i]}`;

    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }

  private async tailFile(filePath: string, numLines: number): Promise<string> {
    const CHUNK_SIZE = 1024;
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    if (fileSize === 0) return '';

    const fileHandle = await fs.open(filePath, 'r');
    try {
      const lines: string[] = [];
      let position = fileSize;
      let chunk = Buffer.alloc(CHUNK_SIZE);
      let linesFound = 0;
      let remainingText = '';

      while (position > 0 && linesFound < numLines) {
        const size = Math.min(CHUNK_SIZE, position);
        position -= size;

        const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
        if (!bytesRead) break;

        const readData = chunk.slice(0, bytesRead).toString('utf-8');
        const chunkText = readData + remainingText;

        const chunkLines = this.normalizeLineEndings(chunkText).split('\n');

        if (position > 0) {
          remainingText = chunkLines[0];
          chunkLines.shift();
        }

        for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
          lines.unshift(chunkLines[i]);
          linesFound++;
        }
      }

      return lines.join('\n');
    } finally {
      await fileHandle.close();
    }
  }

  private async headFile(filePath: string, numLines: number): Promise<string> {
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const lines: string[] = [];
      let buffer = '';
      let bytesRead = 0;
      const chunk = Buffer.alloc(1024);

      while (lines.length < numLines) {
        const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
        buffer += chunk.slice(0, result.bytesRead).toString('utf-8');

        const newLineIndex = buffer.lastIndexOf('\n');
        if (newLineIndex !== -1) {
          const completeLines = buffer.slice(0, newLineIndex).split('\n');
          buffer = buffer.slice(newLineIndex + 1);
          for (const line of completeLines) {
            lines.push(line);
            if (lines.length >= numLines) break;
          }
        }
      }

      if (buffer.length > 0 && lines.length < numLines) {
        lines.push(buffer);
      }

      return lines.join('\n');
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Returns the first `head` lines and the last `tail` lines of a file, separated by a
   * `... [N lines skipped] ...` marker. When the two windows cover or overlap the whole
   * file (`head + tail >= total`) the entire file is returned unchanged (no marker, no
   * duplicated lines).
   */
  private async headAndTailFile(filePath: string, head: number, tail: number): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = this.normalizeLineEndings(content).split('\n');
    const total = lines.length;

    if (head + tail >= total) {
      return content;
    }

    const skipped = total - head - tail;
    const headContent = lines.slice(0, head).join('\n');
    const tailContent = lines.slice(total - tail).join('\n');
    return headContent + '\n... [' + skipped + ' lines skipped] ...\n' + tailContent;
  }

  private createReadBinaryTool(): StructuredToolInterface {
    return createGthTool(
      async (args: z.infer<typeof ReadBinaryArgsSchema>): Promise<string> => {
        if (!this.binaryFormats || !Array.isArray(this.binaryFormats)) {
          return 'Binary formats are not configured. Add binaryFormats to your config to enable this feature.';
        }

        displayInfo(`\n📁 Reading binary file: ${args.path}\n`);
        let validPath: string;
        try {
          validPath = await this.validatePath(args.path);
        } catch {
          return 'Path is not within allowed directories or is blocked by .aiignore';
        }

        const aiignoreConfig = this.aiignoreConfig;
        const shouldIgnore = shouldIgnoreFile(
          validPath,
          getCurrentWorkDir(),
          aiignoreConfig?.patterns,
          aiignoreConfig?.enabled
        );
        if (shouldIgnore) {
          return 'Path is not within allowed directories or is blocked by .aiignore';
        }

        const ext = path.extname(validPath).toLowerCase().slice(1);
        let formatType: BinaryFormatType | null = null;
        let formatConfig: BinaryFormatConfig | null = null;

        if (args.formatHint) {
          const hintedConfig = this.binaryFormats.find(
            (config) => config.type === args.formatHint && config.extensions.includes(ext)
          );
          if (hintedConfig) {
            formatType = hintedConfig.type;
            formatConfig = hintedConfig;
          }
        } else {
          const formatMatch = getFormatForExtension(validPath, this.binaryFormats);
          if (formatMatch) {
            formatType = formatMatch.type;
            formatConfig = formatMatch.config;
          }
        }

        if (!formatType || !formatConfig) {
          return `Extension '.${ext}' is not configured for any binary format type. Configure it in binaryFormats.`;
        }

        const maxSize = formatConfig.maxSize ?? 10 * 1024 * 1024;
        const mimeType = getMimeType(ext, formatConfig);

        try {
          const result = await readBinaryFile(validPath, maxSize, mimeType);

          // Return special format string that middleware will parse and process:
          // Format: gth_read_binary;type:${type};path:${encodedPath};data:${media_type};base64,${data}
          // Path is URL-encoded to handle special characters like semicolons
          const encodedPath = encodeURIComponent(validPath);
          return `gth_read_binary;type:${formatType};path:${encodedPath};data:${mimeType};base64,${result.data}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Error reading binary file: ${message}`;
        }
      },
      {
        name: 'gth_read_binary',
        description:
          'Read a binary file (image, file, audio, video) and return its base64-encoded content. ' +
          'Only works for file types configured in binaryFormats.',
        schema: ReadBinaryArgsSchema,
      },
      'read'
    );
  }

  private createTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
      createGthTool(
        async (args: z.infer<typeof ReadFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Reading file: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);

          if (args.head && args.tail) {
            return await this.headAndTailFile(validPath, args.head, args.tail);
          }

          if (args.tail) {
            return await this.tailFile(validPath, args.tail);
          }

          if (args.head) {
            return await this.headFile(validPath, args.head);
          }

          return await fs.readFile(validPath, 'utf-8');
        },
        {
          name: 'read_file',
          description:
            'Read the complete contents of a file from the file system. ' +
            'Handles various text encodings and provides detailed error messages ' +
            'if the file cannot be read. Use this tool when you need to examine ' +
            "the contents of a single file. Use the 'head' parameter to read only " +
            "the first N lines of a file, or the 'tail' parameter to read only " +
            "the last N lines of a file. The 'head' and 'tail' parameters may be " +
            'combined to get the first N lines, a `... [N lines skipped] ...` ' +
            'marker, and the last M lines in a single call. Only works within allowed directories.',
          schema: ReadFileArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof ReadMultipleFilesArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Reading ${args.paths.length} files\n`);
          const results = await Promise.all(
            args.paths.map(async (filePath: string) => {
              try {
                const validPath = await this.validatePath(filePath);
                const content = await fs.readFile(validPath, 'utf-8');
                return `${filePath}:\n${content}\n`;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return `${filePath}: Error - ${errorMessage}`;
              }
            })
          );
          return results.join('\n---\n');
        },
        {
          name: 'read_multiple_files',
          description:
            'Read the contents of multiple files simultaneously. This is more ' +
            'efficient than reading files one by one when you need to analyze ' +
            "or compare multiple files. Each file's content is returned with its " +
            "path as a reference. Failed reads for individual files won't stop " +
            'the entire operation. Only works within allowed directories.',
          schema: ReadMultipleFilesArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof WriteFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Writing file: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          await fs.writeFile(validPath, args.content, 'utf-8');
          return `Successfully wrote to ${args.path}`;
        },
        {
          name: 'write_file',
          description:
            'Create a new file or completely overwrite an existing file with new content. ' +
            'Use with caution as it will overwrite existing files without warning. ' +
            'Handles text content with proper encoding. Only works within allowed directories.',
          schema: WriteFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof EditFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Editing file: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          return await this.applyFileEdits(validPath, args.edits, args.dryRun);
        },
        {
          name: 'edit_file',
          description:
            'Make line-based edits to a text file. Each edit replaces exact line sequences ' +
            'with new content. Returns a git-style diff showing the changes made. ' +
            'Only works within allowed directories.' +
            'Always present diff returned by this tool back to the user.' +
            'Prefer applying small edits, eg. one function at a time, one block or one condition.' +
            'Fall back to using the "write_file" tool if you need to make large edits.' +
            'or of the "edit_file" fails for some reason.' +
            'Always read file before every edit to ensure that the file is not corrupted.',
          schema: EditFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof CreateDirectoryArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Creating directory: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          await fs.mkdir(validPath, { recursive: true });
          return `Successfully created directory ${args.path}`;
        },
        {
          name: 'create_directory',
          description:
            'Create a new directory or ensure a directory exists. Can create multiple ' +
            'nested directories in one operation. If the directory already exists, ' +
            'this operation will succeed silently. Perfect for setting up directory ' +
            'structures for projects or ensuring required paths exist. Only works within allowed directories.',
          schema: CreateDirectoryArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof ListDirectoryArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Listing directory: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const aiignoreConfig = this.aiignoreConfig;
          const filteredEntries = entries.filter((entry) => {
            const fullPath = path.join(validPath, entry.name);
            return !shouldIgnoreFile(
              fullPath,
              getCurrentWorkDir(),
              aiignoreConfig?.patterns,
              aiignoreConfig?.enabled
            );
          });
          return filteredEntries
            .map((entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`)
            .join('\n');
        },
        {
          name: 'list_directory',
          description:
            'Get a detailed listing of all files and directories in a specified path. ' +
            'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
            'prefixes. This tool is essential for understanding directory structure and ' +
            'finding specific files within a directory. Only works within allowed directories.',
          schema: ListDirectoryArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Listing directory with sizes: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const aiignoreConfig = this.aiignoreConfig;
          const filteredEntries = entries.filter((entry) => {
            const fullPath = path.join(validPath, entry.name);
            return !shouldIgnoreFile(
              fullPath,
              getCurrentWorkDir(),
              aiignoreConfig?.patterns,
              aiignoreConfig?.enabled
            );
          });

          const detailedEntries = await Promise.all(
            filteredEntries.map(async (entry) => {
              const entryPath = path.join(validPath, entry.name);
              try {
                const stats = await fs.stat(entryPath);
                return {
                  name: entry.name,
                  isDirectory: entry.isDirectory(),
                  size: stats.size,
                  mtime: stats.mtime,
                };
              } catch {
                return {
                  name: entry.name,
                  isDirectory: entry.isDirectory(),
                  size: 0,
                  mtime: new Date(0),
                };
              }
            })
          );

          const sortedEntries = [...detailedEntries].sort((a, b) => {
            if (args.sortBy === 'size') {
              return b.size - a.size;
            }
            return a.name.localeCompare(b.name);
          });

          const formattedEntries = sortedEntries.map(
            (entry) =>
              `${entry.isDirectory ? '[DIR]' : '[FILE]'} ${entry.name.padEnd(30)} ${
                entry.isDirectory ? '' : this.formatSize(entry.size).padStart(10)
              }`
          );

          const totalFiles = detailedEntries.filter((e) => !e.isDirectory).length;
          const totalDirs = detailedEntries.filter((e) => e.isDirectory).length;
          const totalSize = detailedEntries.reduce(
            (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
            0
          );

          const summary = [
            '',
            `Total: ${totalFiles} files, ${totalDirs} directories`,
            `Combined size: ${this.formatSize(totalSize)}`,
          ];

          return [...formattedEntries, ...summary].join('\n');
        },
        {
          name: 'list_directory_with_sizes',
          description:
            'Get a detailed listing of all files and directories in a specified path, including sizes. ' +
            'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
            'prefixes. This tool is useful for understanding directory structure and ' +
            'finding specific files within a directory. Only works within allowed directories.',
          schema: ListDirectoryWithSizesArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof DirectoryTreeArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Building directory tree: ${args.path}\n`);

          interface TreeEntry {
            name: string;
            type: 'file' | 'directory';
            children?: TreeEntry[];
            ignored?: boolean;
          }

          const buildTree = async (currentPath: string): Promise<TreeEntry[]> => {
            const validPath = await this.validatePath(currentPath);
            const entries = await fs.readdir(validPath, { withFileTypes: true });
            const result: TreeEntry[] = [];
            const aiignoreConfig = this.aiignoreConfig;

            for (const entry of entries) {
              const entryData: TreeEntry = {
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
              };
              if (IGNORED_DIRS.indexOf(entry.name) >= 0) {
                entryData.ignored = true;
              }

              // Check if file should be ignored by aiignore
              const fullPath = path.join(currentPath, entry.name);
              const shouldIgnore = shouldIgnoreFile(
                fullPath,
                getCurrentWorkDir(),
                aiignoreConfig?.patterns,
                aiignoreConfig?.enabled
              );

              if (shouldIgnore) {
                entryData.ignored = true;
              }

              if (entry.isDirectory() && !entryData.ignored) {
                const subPath = path.join(currentPath, entry.name);
                entryData.children = await buildTree(subPath);
              }

              result.push(entryData);
            }

            return result;
          };

          const treeData = await buildTree(args.path);
          return JSON.stringify(treeData, null, 2);
        },
        {
          name: 'directory_tree',
          description:
            'Get a recursive tree view of files and directories as a JSON structure. ' +
            "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
            'Files have no children array, while directories always have a children array (which may be empty). ' +
            'The output is formatted with 2-space indentation for readability. Only works within allowed directories.',
          schema: DirectoryTreeArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof MoveFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Moving ${args.source} to ${args.destination}\n`);
          const validSourcePath = await this.validatePath(args.source);
          const validDestPath = await this.validatePath(args.destination);
          await fs.rename(validSourcePath, validDestPath);
          return `Successfully moved ${args.source} to ${args.destination}`;
        },
        {
          name: 'move_file',
          description:
            'Move or rename files and directories. Can move files between directories ' +
            'and rename them in a single operation. If the destination exists, the ' +
            'operation will fail. Works across different directories and can be used ' +
            'for simple renaming within the same directory. Both source and destination must be within allowed directories.',
          schema: MoveFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof SearchFilesArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Searching for '${args.pattern}' in ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const results = await this.searchFiles(validPath, args.pattern, args.excludePatterns);
          return results.length > 0 ? results.join('\n') : 'No matches found';
        },
        {
          name: 'search_files',
          description:
            'Recursively search for files and directories matching a pattern. ' +
            'Searches through all subdirectories from the starting path. The search ' +
            'is case-insensitive and matches partial names. Returns full paths to all ' +
            "matching items. Great for finding files when you don't know their exact location. " +
            'Only searches within allowed directories.',
          schema: SearchFilesArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof GetFileInfoArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Getting file info: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const info = await this.getFileStats(validPath);
          return Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
        },
        {
          name: 'get_file_info',
          description:
            'Retrieve detailed metadata about a file or directory. Returns comprehensive ' +
            'information including size, creation time, last modified time, permissions, ' +
            'and type. This tool is perfect for understanding file characteristics ' +
            'without reading the actual content. Only works within allowed directories.',
          schema: GetFileInfoArgsSchema,
        },
        'read'
      ),

      createGthTool(
        async (args: z.infer<typeof DeleteFileArgsSchema>): Promise<string> => {
          displayInfo(`\n📁 Deleting file: ${args.path}\n`);
          const validPath = await this.validatePath(args.path);
          const stats = await fs.stat(validPath);
          if (stats.isDirectory()) {
            throw new Error(
              `Cannot delete directory: ${args.path}. Use rmdir or a recursive delete tool for directories.`
            );
          }
          await fs.unlink(validPath);
          return `Successfully deleted file: ${args.path}`;
        },
        {
          name: 'delete_file',
          description:
            'Delete a file from the filesystem. This operation cannot be undone. ' +
            'Only works for files, not directories. Use with caution. ' +
            'Only works within allowed directories.',
          schema: DeleteFileArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (args: z.infer<typeof DeleteDirectoryArgsSchema>): Promise<string> => {
          displayInfo(
            `\n📁 Deleting directory: ${args.path}${args.recursive ? ' (recursive)' : ''}\n`
          );
          const validPath = await this.validatePath(args.path);

          // Check if this is a protected directory
          if (this.isProtectedDirectory(validPath)) {
            throw new Error(
              `Cannot delete protected directory: ${args.path}. This is one of the allowed root directories.`
            );
          }

          const stats = await fs.stat(validPath);
          if (!stats.isDirectory()) {
            throw new Error(`Not a directory: ${args.path}. Use delete_file for files.`);
          }

          if (args.recursive) {
            await fs.rm(validPath, { recursive: true, force: true });
            return `Successfully deleted directory and all contents: ${args.path}`;
          } else {
            // For non-recursive delete, check if directory is empty
            const entries = await fs.readdir(validPath);
            if (entries.length > 0) {
              throw new Error(
                `Directory not empty: ${args.path}. Use recursive: true to delete non-empty directories.`
              );
            }
            await fs.rmdir(validPath);
            return `Successfully deleted empty directory: ${args.path}`;
          }
        },
        {
          name: 'delete_directory',
          description:
            'Delete a directory from the filesystem. Can delete empty directories or recursively delete ' +
            'directories with contents. Cannot delete protected directories (allowed root directories). ' +
            'This operation cannot be undone. Use with extreme caution. ' +
            'Only works within allowed directories.',
          schema: DeleteDirectoryArgsSchema,
        },
        'write'
      ),

      createGthTool(
        async (): Promise<string> => {
          return `Allowed directories:\n${this.allowedDirectories.join('\n')}`;
        },
        {
          name: 'list_allowed_directories',
          description:
            'Returns the list of directories that this server is allowed to access. ' +
            'Use this to understand which directories are available before trying to access files.',
          schema: z.object({}),
        },
        'read'
      ),
    ];

    if (this.binaryFormats && Array.isArray(this.binaryFormats) && this.binaryFormats.length > 0) {
      tools.push(this.createReadBinaryTool());
    }

    return tools;
  }
}
