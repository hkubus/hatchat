import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "@hat/core";
import { toOpenAIMessages, toWireName } from "./messages.js";

test("maps tool call and tool result messages", () => {
  const messages: ChatMessage[] = [
    {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", text: "running" },
        { type: "tool_call", id: "call_1", name: "shell_exec", args: { command: "ls" } },
      ],
      createdAt: 0,
    },
    {
      id: "b",
      role: "tool",
      parts: [
        {
          type: "tool_result",
          id: "call_1",
          name: "shell_exec",
          content: [{ type: "text", text: "file.txt" }],
        },
      ],
      createdAt: 0,
    },
  ];

  const openai = toOpenAIMessages(messages);
  assert.deepEqual(openai[0], {
    role: "assistant",
    content: "running",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "shell_exec", arguments: '{"command":"ls"}' } },
    ],
  });
  assert.deepEqual(openai[1], {
    role: "tool",
    tool_call_id: "call_1",
    content: "file.txt",
  });
});

test("sanitizes non-conforming tool names on the wire", () => {
  assert.equal(toWireName("shell_exec"), "shell_exec");
  const wire = toWireName("shell.exec");
  assert.match(wire, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.notEqual(wire, "shell.exec");
  assert.equal(toWireName("shell.exec"), wire);

  const openai = toOpenAIMessages([
    {
      id: "a",
      role: "assistant",
      parts: [{ type: "tool_call", id: "c1", name: "mcp/github/create-issue", args: {} }],
      createdAt: 0,
    },
  ]);
  assert.match(openai[0].tool_calls![0].function.name, /^[a-zA-Z0-9_-]{1,64}$/);
});

test("maps image parts to content arrays", () => {
  const messages: ChatMessage[] = [
    {
      id: "u",
      role: "user",
      parts: [
        { type: "text", text: "what is this" },
        { type: "image", source: { kind: "url", url: "https://x/y.png", mime: "image/png" } },
      ],
      createdAt: 0,
    },
  ];
  const openai = toOpenAIMessages(messages);
  assert.deepEqual(openai[0], {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ],
  });
});

test("drops reasoning parts", () => {
  const messages: ChatMessage[] = [
    {
      id: "a",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "secret thoughts" },
        { type: "text", text: "answer" },
      ],
      createdAt: 0,
    },
  ];
  const openai = toOpenAIMessages(messages);
  assert.deepEqual(openai[0], { role: "assistant", content: "answer" });
});
