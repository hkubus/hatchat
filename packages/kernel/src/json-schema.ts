import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Convert a zod schema to the JSON Schema we hand to providers and clients.
 *
 * OpenAI-compatible providers expect JSON Schema (numeric exclusiveMinimum),
 * not OpenAPI 3.0's boolean form, and inline refs. Also imported by isolated
 * plugin processes (via `@hat/kernel/json-schema`), so it must stay free of
 * non-erasable TypeScript syntax.
 */
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
