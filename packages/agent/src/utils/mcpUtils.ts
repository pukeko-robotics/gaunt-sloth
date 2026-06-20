import { GthConfig } from '@gaunt-sloth/core/config.js';
import { StatusLevel, StatusUpdateCallback } from '@gaunt-sloth/core/core/types.js';
import { isVertexGoogleLlm } from '@gaunt-sloth/core/utils/vertexaiUtils.js';
import { DynamicStructuredTool, ToolSchemaBase } from '@langchain/core/tools';

type JsonInputSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonInputSchema>;
  items?: JsonInputSchema | JsonInputSchema[];
  anyOf?: JsonInputSchema[];
  oneOf?: JsonInputSchema[];
  discriminator?: { propertyName?: string };
  additionalProperties?: boolean | JsonInputSchema;
  patternProperties?: Record<string, JsonInputSchema>;
  allOf?: JsonInputSchema[];
  not?: JsonInputSchema;
  if?: JsonInputSchema;
  then?: JsonInputSchema;
  else?: JsonInputSchema;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
};

type McpTool = DynamicStructuredTool<ToolSchemaBase, unknown, unknown, string>;

function isVertexLlm(config: GthConfig): boolean {
  return isVertexGoogleLlm(config.llm);
}

function mergeDescription(existing: string | undefined, extra: string): string {
  if (existing && existing.trim().length > 0) {
    const trimmed = existing.trim();
    const separator = trimmed.endsWith('.') || trimmed.endsWith(';') ? ' ' : '; ';
    return `${trimmed}${separator}${extra}`;
  }
  return extra;
}

function isJsonSchema(value: unknown): value is JsonInputSchema {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function describeJsonSchemaType(schema: JsonInputSchema | undefined): string {
  if (!schema) return 'value';
  if (schema.const !== undefined) return `literal(${JSON.stringify(schema.const)})`;
  if (schema.enum && schema.enum.length > 0) {
    return `enum(${schema.enum.map((value) => JSON.stringify(value)).join(' | ')})`;
  }
  if (schema.type) {
    if (Array.isArray(schema.type)) {
      return schema.type.join(' | ');
    }
    if (schema.type === 'array') {
      if (Array.isArray(schema.items)) {
        const itemTypes = schema.items.map((item) => describeJsonSchemaType(item)).join(', ');
        return `tuple<${itemTypes}>`;
      }
      return `array<${describeJsonSchemaType(schema.items)}>`;
    }
    return schema.type;
  }
  if (schema.properties) return 'object';
  return 'value';
}

function buildUnionDescriptionFromSchema(options: JsonInputSchema[]): string {
  const optionDescriptions = options.map((option) => describeJsonSchemaType(option));
  return `Expected one of: ${optionDescriptions.join(' | ')}.`;
}

function buildDiscriminatedUnionDescriptionFromSchema(
  schema: JsonInputSchema,
  options: JsonInputSchema[]
): string {
  const discriminator = schema.discriminator?.propertyName;
  if (discriminator) {
    const values = options
      .map((option) => option.properties?.[discriminator])
      .map((property) => {
        if (!property) return '';
        if (property.const !== undefined) return JSON.stringify(property.const);
        if (property.enum && property.enum.length > 0) {
          return property.enum.map((value) => JSON.stringify(value)).join(' | ');
        }
        return '';
      })
      .filter((value) => value);
    if (values.length > 0) {
      return `Expected "${discriminator}" to be one of: ${values.join(', ')}.`;
    }
  }
  return buildUnionDescriptionFromSchema(options);
}

interface ReplaceUnionSchemasContext {
  toolName: string;
  path: string[];
  log: (message: string) => void;
}

/**
 * Replace union schemas in JSON schema.
 * Gemini/Vertex AI cannot handle anyOf, oneOf, or discriminatedUnion schemas,
 * so this function converts them to a flat structure with descriptive text.
 */
function replaceUnionSchemas(schema: unknown, context: ReplaceUnionSchemasContext): unknown {
  if (!isJsonSchema(schema)) {
    return schema;
  }

  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf ?? [];
    const description = mergeDescription(
      schema.description,
      schema.discriminator
        ? buildDiscriminatedUnionDescriptionFromSchema(schema, options)
        : buildUnionDescriptionFromSchema(options)
    );
    // The unassignment below is for purpose of taking rest of parameters except unions.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { anyOf, oneOf, discriminator, ...rest } = schema;
    context.log(`${context.toolName}: converted schema union at ${context.path.join('.')}`);
    return {
      ...rest,
      description,
    };
  }

  let hasChanges = false;
  let updatedSchema = schema;
  const updateField = <Key extends keyof JsonInputSchema>(
    key: Key,
    value: JsonInputSchema[Key]
  ) => {
    if (schema[key] === value) return;
    if (!hasChanges) {
      updatedSchema = { ...schema };
    }
    updatedSchema[key] = value;
    hasChanges = true;
  };

  // Process properties and patternProperties (Record<string, JsonInputSchema>)
  const recordFields = [
    { key: 'properties', pathPrefix: '' },
    { key: 'patternProperties', pathPrefix: 'patternProperties.' },
  ] as const;
  for (const { key, pathPrefix } of recordFields) {
    const record = schema[key];
    if (record) {
      const updatedRecord: Record<string, JsonInputSchema> = {};
      let recordChanged = false;
      for (const [propKey, propValue] of Object.entries(record)) {
        const updatedValue = replaceUnionSchemas(propValue, {
          toolName: context.toolName,
          path: [...context.path, `${pathPrefix}${propKey}`],
          log: context.log,
        }) as JsonInputSchema;
        updatedRecord[propKey] = updatedValue;
        if (updatedValue !== propValue) {
          recordChanged = true;
        }
      }
      if (recordChanged) {
        updateField(key, updatedRecord);
      }
    }
  }

  if (isJsonSchema(schema.additionalProperties)) {
    const updatedAdditionalProperties = replaceUnionSchemas(schema.additionalProperties, {
      toolName: context.toolName,
      path: [...context.path, 'additionalProperties'],
      log: context.log,
    }) as JsonInputSchema;
    if (updatedAdditionalProperties !== schema.additionalProperties) {
      updateField('additionalProperties', updatedAdditionalProperties);
    }
  }

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      const itemsArray = schema.items;
      const updatedItems = itemsArray.map(
        (item, index) =>
          replaceUnionSchemas(item, {
            toolName: context.toolName,
            path: [...context.path, `items[${index}]`],
            log: context.log,
          }) as JsonInputSchema
      );
      const itemsChanged = updatedItems.some((item, index) => item !== itemsArray[index]);
      if (itemsChanged) {
        updateField('items', updatedItems);
      }
    } else {
      const updatedItems = replaceUnionSchemas(schema.items, {
        toolName: context.toolName,
        path: [...context.path, 'items'],
        log: context.log,
      }) as JsonInputSchema;
      if (updatedItems !== schema.items) {
        updateField('items', updatedItems);
      }
    }
  }

  if (schema.allOf) {
    const updatedAllOf = schema.allOf.map(
      (item, index) =>
        replaceUnionSchemas(item, {
          toolName: context.toolName,
          path: [...context.path, `allOf[${index}]`],
          log: context.log,
        }) as JsonInputSchema
    );
    const allOfChanged = updatedAllOf.some((item, index) => item !== schema.allOf?.[index]);
    if (allOfChanged) {
      updateField('allOf', updatedAllOf);
    }
  }

  // Process simple nested schema fields: not, if, then, else
  const nestedFields = ['not', 'if', 'then', 'else'] as const;
  for (const field of nestedFields) {
    if (schema[field]) {
      const updatedField = replaceUnionSchemas(schema[field], {
        toolName: context.toolName,
        path: [...context.path, field],
        log: context.log,
      }) as JsonInputSchema;
      if (updatedField !== schema[field]) {
        updateField(field, updatedField);
      }
    }
  }

  return updatedSchema;
}

function updateToolSchema(tool: McpTool, log: (message: string) => void): McpTool {
  const schema = tool.schema as unknown;
  if (!schema || typeof schema !== 'object') {
    return tool;
  }

  const updatedSchema = replaceUnionSchemas(schema, {
    toolName: tool.name ?? 'unknown',
    path: ['schema'],
    log,
  });
  if (updatedSchema === tool.schema) {
    return tool;
  }

  tool.schema = updatedSchema as ToolSchemaBase;
  return tool;
}

/**
 * Convert union types to flat types:
 * See https://github.com/langchain-ai/langchainjs/issues/9691
 * Since LangChain 1.2.1 Gemini explodes with the following error:
 * Error processing message: Agent processing failed:
 * Failed to convert tool 'mcp_tool_name' schema for Gemini: zod_to_gemini_parameters:
 * Gemini cannot handle union types (discriminatedUnion, anyOf, oneOf).
 * Consider using a flat object structure with optional fields instead.
 */
export function prepareMcpTools(
  statusUpdate: StatusUpdateCallback,
  config: GthConfig,
  tools: DynamicStructuredTool<ToolSchemaBase, unknown, unknown, string>[] | undefined
): DynamicStructuredTool<ToolSchemaBase, unknown, unknown, string>[] | undefined {
  if (!tools || tools.length === 0) {
    return tools;
  }

  if (!isVertexLlm(config)) {
    return tools;
  }
  const log = (msg: string): void => statusUpdate(StatusLevel.INFO, msg);
  log('converting tools for Vertex AI LLM to avoid schema issues.');
  return tools.map((tool) => updateToolSchema(tool, log));
}
