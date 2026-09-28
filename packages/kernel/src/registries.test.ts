import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ToolRegistry } from "./registries.js";

test("tool specs produce OpenAI-compatible JSON Schema", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shell_exec",
    description: "run a command",
    schema: z.object({
      command: z.string().describe("the command"),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    async execute() {
      return [];
    },
  });

  const [spec] = registry.toToolSpecs();
  const params = spec.parameters as Record<string, any>;

  assert.equal(params.type, "object");
  assert.equal(params.$schema, undefined);
  assert.deepEqual(params.required, ["command"]);
  assert.equal(params.properties.timeoutMs.exclusiveMinimum, 0);
  assert.equal(params.properties.timeoutMs.maximum, 600_000);
  assert.equal(typeof params.properties.timeoutMs.exclusiveMinimum, "number");
  assert.equal(params.properties.command.description, "the command");
});
