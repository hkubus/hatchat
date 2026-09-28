import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { inferNeeds, satisfies, unmetNeeds } from "./capabilities.js";
import { DEFAULT_TOOL_POLICY, decideTool } from "./policy.js";
import type { ChatMessage } from "./messages.js";
import type { ProviderCapabilities } from "./provider.js";
import type { Tool } from "./tool.js";

const tool: Tool = {
  name: "t",
  description: "",
  schema: z.object({}),
  requiresApproval: true,
  async execute() {
    return [];
  },
};

const openTool: Tool = { ...tool, name: "o", requiresApproval: false };

test("approval policy modes", () => {
  assert.equal(decideTool(tool, {}, { ...DEFAULT_TOOL_POLICY, mode: "ask" }), "ask");
  assert.equal(decideTool(openTool, {}, { ...DEFAULT_TOOL_POLICY, mode: "ask" }), "approve");
  assert.equal(decideTool(tool, {}, { ...DEFAULT_TOOL_POLICY, mode: "auto" }), "approve");
  assert.equal(decideTool(tool, {}, { ...DEFAULT_TOOL_POLICY, mode: "deny" }), "deny");
  assert.equal(
    decideTool(tool, {}, { ...DEFAULT_TOOL_POLICY, mode: "allowlist", allowlist: ["t"] }),
    "approve",
  );
  assert.equal(
    decideTool(tool, {}, { ...DEFAULT_TOOL_POLICY, mode: "allowlist", allowlist: [] }),
    "ask",
  );
});

function caps(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return {
    streaming: true,
    toolCalls: false,
    vision: false,
    imageGeneration: false,
    reasoning: false,
    jsonMode: false,
    systemPrompt: "native",
    ...overrides,
  };
}

test("infers vision and tool needs from messages", () => {
  const image: ChatMessage = {
    id: "1",
    role: "user",
    parts: [{ type: "image", source: { kind: "url", url: "x", mime: "image/png" } }],
    createdAt: 0,
  };
  assert.deepEqual(inferNeeds([image]), { vision: true, toolCalls: false });

  const toolCall: ChatMessage = {
    id: "2",
    role: "assistant",
    parts: [{ type: "tool_call", id: "c", name: "x", args: {} }],
    createdAt: 0,
  };
  assert.deepEqual(inferNeeds([toolCall]), { vision: false, toolCalls: true });
});

test("satisfies and unmetNeeds", () => {
  assert.deepEqual(unmetNeeds(caps({ vision: true }), { vision: true }), []);
  assert.deepEqual(unmetNeeds(caps({}), { vision: true, toolCalls: true }), [
    "vision",
    "tool calls",
  ]);
  assert.equal(satisfies(caps({ toolCalls: true }), { toolCalls: true }), true);
  assert.equal(satisfies(caps({}), { reasoning: true }), false);
});
