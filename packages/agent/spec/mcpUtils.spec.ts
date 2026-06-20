import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { GthConfig } from '#src/config.js';

vi.mock('@langchain/google/node', () => ({
  ChatGoogle: class ChatGoogle {
    _platform: string | undefined;

    constructor(params: { vertexai?: boolean } = {}) {
      this._platform = params.vertexai ? 'gcp' : undefined;
    }
  },
}));

describe('prepareMcpTools', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should keep union schemas unchanged for non-Vertex LLMs', async () => {
    const schema = {
      type: 'object',
      properties: {
        ids: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }],
          description: 'Filter by ids',
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const config = { llm: {} } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const idsSchema = (result?.[0].schema as any).properties.ids;
    expect(idsSchema.anyOf).toBeDefined();
  });

  it('should convert anyOf union schemas to z.any for Vertex', async () => {
    const schema = {
      type: 'object',
      properties: {
        ids: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }],
          description: 'Filter by ids',
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const { ChatGoogle } = await import('@langchain/google/node');
    const config = {
      llm: new ChatGoogle({ model: 'gemini-2.5-pro', vertexai: true }),
    } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const idsSchema = (result?.[0].schema as any).properties.ids;
    expect(idsSchema.anyOf).toBeUndefined();
    expect(idsSchema.description).toContain('Filter by ids');
    expect(idsSchema.description).toContain('string');
  });

  it('should convert oneOf union schemas created via .or to z.any for Vertex', async () => {
    const schema = {
      type: 'object',
      properties: {
        keys: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Filter by keys',
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const { ChatGoogle } = await import('@langchain/google/node');
    const config = {
      llm: new ChatGoogle({ model: 'gemini-2.5-pro', vertexai: true }),
    } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const keysSchema = (result?.[0].schema as any).properties.keys;
    expect(keysSchema.oneOf).toBeUndefined();
    expect(keysSchema.description).toContain('Filter by keys');
    expect(keysSchema.description).toContain('array');
  });

  it('should convert discriminatedUnion schemas to z.any for Vertex', async () => {
    const schema = {
      type: 'object',
      properties: {
        payload: {
          description: 'Payload',
          discriminator: { propertyName: 'kind' },
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'a' },
                value: { type: 'string' },
              },
              required: ['kind', 'value'],
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'b' },
                count: { type: 'number' },
              },
              required: ['kind', 'count'],
            },
          ],
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const { ChatGoogle } = await import('@langchain/google/node');
    const config = {
      llm: new ChatGoogle({ model: 'gemini-2.5-pro', vertexai: true }),
    } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const payloadSchema = (result?.[0].schema as any).properties.payload;
    expect(payloadSchema.oneOf).toBeUndefined();
    expect(payloadSchema.description).toContain('Payload');
    expect(payloadSchema.description).toContain('kind');
    expect(payloadSchema.description).toContain('"a"');
  });

  it('should convert nested union schemas to z.any for Vertex', async () => {
    const schema = {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          items: {
            anyOf: [{ type: 'string' }, { type: 'number' }],
            description: 'Filter item',
          },
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const { ChatGoogle } = await import('@langchain/google/node');
    const config = {
      llm: new ChatGoogle({ model: 'gemini-2.5-pro', vertexai: true }),
    } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const filtersItemsSchema = (result?.[0].schema as any).properties.filters.items;
    expect(filtersItemsSchema.anyOf).toBeUndefined();
    expect(filtersItemsSchema.description).toContain('Filter item');
    expect(filtersItemsSchema.description).toContain('string');
    expect(filtersItemsSchema.description).toContain('number');
  });

  it('should convert tuple items union schemas to z.any for Vertex', async () => {
    const schema = {
      type: 'object',
      properties: {
        range: {
          type: 'array',
          items: [
            {
              anyOf: [{ type: 'string' }, { type: 'number' }],
              description: 'Range start',
            },
            { type: 'number' },
          ],
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const { ChatGoogle } = await import('@langchain/google/node');
    const config = {
      llm: new ChatGoogle({ model: 'gemini-2.5-pro', vertexai: true }),
    } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const rangeItemsSchema = (result?.[0].schema as any).properties.range.items;
    expect(rangeItemsSchema[0].anyOf).toBeUndefined();
    expect(rangeItemsSchema[0].description).toContain('Range start');
    expect(rangeItemsSchema[0].description).toContain('string');
    expect(rangeItemsSchema[0].description).toContain('number');
  });

  it('should convert nested union schemas in conditional branches for Vertex', async () => {
    const schema = {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          if: {
            properties: {
              kind: {
                anyOf: [{ const: 'a' }, { const: 'b' }],
                description: 'Payload kind',
              },
            },
          },
          then: {
            properties: {
              value: {
                oneOf: [{ type: 'string' }, { type: 'number' }],
                description: 'Payload value',
              },
            },
          },
        },
      },
    } as const;
    const tool = new DynamicStructuredTool({
      name: 'mcp__jira__getConfluenceSpaces',
      description: 'Test tool',
      schema,
      func: async () => 'ok',
    });
    const { ChatGoogle } = await import('@langchain/google/node');
    const config = {
      llm: new ChatGoogle({ model: 'gemini-2.5-pro', vertexai: true }),
    } as Partial<GthConfig>;

    const { prepareMcpTools } = await import('#src/utils/mcpUtils.js');
    const result = prepareMcpTools(vi.fn(), config as GthConfig, [tool]);

    const payloadSchema = (result?.[0].schema as any).properties.payload;
    expect(payloadSchema.if.properties.kind.anyOf).toBeUndefined();
    expect(payloadSchema.if.properties.kind.description).toContain('Payload kind');
    expect(payloadSchema.then.properties.value.oneOf).toBeUndefined();
    expect(payloadSchema.then.properties.value.description).toContain('Payload value');
  });
});
