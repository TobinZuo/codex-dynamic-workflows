import type { JsonSchema } from "./types.ts";

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateJsonSchema(value: unknown, schema: JsonSchema | undefined): SchemaValidationResult {
  if (!schema) return { ok: true, errors: [] };
  const errors: string[] = [];
  validateValue(value, schema, "$", errors);
  return { ok: errors.length === 0, errors };
}

function validateValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.enum && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
    return;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || (schema.properties && isPlainObject(value))) {
    if (!isPlainObject(value)) {
      errors.push(`${path} must be object`);
      return;
    }
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in objectValue)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) validateValue(objectValue[key], childSchema, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(objectValue)) {
        if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  if (type === "array" || (schema.items && Array.isArray(value))) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be array`);
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => validateValue(item, schema.items as JsonSchema, `${path}[${index}]`, errors));
    }
  }
}

function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => {
    switch (item) {
      case "array":
        return Array.isArray(value);
      case "object":
        return isPlainObject(value);
      case "null":
        return value === null;
      case "integer":
        return Number.isInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "string":
      case "boolean":
        return typeof value === item;
      default:
        return true;
    }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
