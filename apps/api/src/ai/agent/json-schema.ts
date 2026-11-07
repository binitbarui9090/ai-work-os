/**
 * Minimal Zod → JSON Schema conversion for tool definitions.
 *
 * Tool inputs need a JSON Schema for the provider and a Zod schema for runtime
 * validation. Deriving one from the other keeps them from drifting, which
 * matters because eager tool-input streaming means the server does not
 * validate inputs for us.
 *
 * Supports exactly the constructs the tool schemas use; anything else throws
 * at startup rather than silently producing a permissive schema.
 */
import { z, type ZodTypeAny } from "zod";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  const?: unknown;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const result = convert(schema);
  if (result.type !== "object") {
    throw new Error("A tool input schema must be an object");
  }
  return result;
}

function convert(schema: ZodTypeAny): JsonSchema {
  const description = schema.description;
  const base = convertInner(schema);
  return description ? { ...base, description } : base;
}

function convertInner(schema: ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return convert(schema._def.innerType as ZodTypeAny);
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema._def.innerType as ZodTypeAny);
    const type = inner.type;
    return {
      ...inner,
      type:
        typeof type === "string"
          ? [type, "null"]
          : Array.isArray(type)
            ? [...type, "null"]
            : undefined,
    };
  }
  if (schema instanceof z.ZodEffects) {
    return convert(schema._def.schema as ZodTypeAny);
  }
  if (schema instanceof z.ZodPipeline) {
    return convert(schema._def.in as ZodTypeAny);
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!isOptional(value)) required.push(key);
    }
    return {
      type: "object",
      properties,
      required,
      // Required by strict tool use, and stops the model inventing fields.
      additionalProperties: false,
    };
  }

  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = { type: "array", items: convert(schema._def.type as ZodTypeAny) };
    const def = schema._def as { minLength?: { value: number }; maxLength?: { value: number } };
    if (def.minLength) out.minItems = def.minLength.value;
    if (def.maxLength) out.maxItems = def.maxLength.value;
    return out;
  }

  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: "string" };
    for (const check of schema._def.checks ?? []) {
      if (check.kind === "min") out.minLength = check.value;
      if (check.kind === "max") out.maxLength = check.value;
      if (check.kind === "uuid") out.format = "uuid";
      if (check.kind === "email") out.format = "email";
    }
    return out;
  }

  if (schema instanceof z.ZodNumber) {
    const checks = schema._def.checks ?? [];
    const isInt = checks.some((c) => c.kind === "int");
    const out: JsonSchema = { type: isInt ? "integer" : "number" };
    for (const check of checks) {
      if (check.kind === "min") out.minimum = check.value;
      if (check.kind === "max") out.maximum = check.value;
    }
    return out;
  }

  if (schema instanceof z.ZodBoolean) return { type: "boolean" };

  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...(schema._def.values as string[])] };
  }

  if (schema instanceof z.ZodLiteral) {
    const value = schema._def.value;
    return { type: typeof value === "number" ? "number" : "string", const: value };
  }

  if (schema instanceof z.ZodUnion) {
    // Only unions of literals are supported, which become an enum.
    const options = schema._def.options as ZodTypeAny[];
    if (options.every((o) => o instanceof z.ZodLiteral)) {
      return {
        type: "string",
        enum: options.map((o) => (o as z.ZodLiteral<string>)._def.value),
      };
    }
    throw new Error("Only unions of literals are supported in tool schemas");
  }

  throw new Error(`Unsupported Zod type in tool schema: ${schema.constructor.name}`);
}

function isOptional(schema: ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return true;
  if (schema instanceof z.ZodEffects) return isOptional(schema._def.schema as ZodTypeAny);
  return false;
}
