import type { KernelEvent, Part, Usage } from "@hat/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PathNode } from "./api";
import type { UiMessage } from "./chat";
import {
  applyEffect,
  buildMessages,
  emptyAssistant,
  readEvent,
  toolSummary,
} from "./chat.js";

// --- fixtures --------------------------------------------------------------

let seq = 0;
const message = (
  role: "user" | "assistant" | "tool",
  parts: Part[],
  meta?: { usage?: Usage },
): PathNode => {
  seq += 1;
  return {
    message: { id: `m${seq}`, role, parts, createdAt: seq, meta },
    parentId: null,
    siblingIndex: 0,
    siblingCount: 1,
    siblingIds: [`m${seq}`],
  };
};

const text = (t: string): Part => ({ type: "text", text: t });
const toolCall = (id: string, name: string, args: unknown): Part => ({
  type: "tool_call",
  id,
  name,
  args,
});
const toolResult = (id: string, name: string, content: Part[], isError = false): Part => ({
  type: "tool_result",
  id,
  name,
  content,
  isError,
});

// --- buildMessages ---------------------------------------------------------

test("buildMessages flattens the active path into user/assistant rows", () => {
  const out = buildMessages([
    message("user", [text("hello")]),
    message("assistant", [text("hi")]),
  ]);
  assert.deepEqual(
    out.map((m) => [m.role, m.text]),
    [
      ["user", "hello"],
      ["assistant", "hi"],
    ],
  );
});

test("buildMessages folds a tool result back into its caller's card", () => {
  const out = buildMessages([
    message("user", [text("run it")]),
    message("assistant", [toolCall("call_1", "shell_exec", { command: "ls" })]),
    message("tool", [toolResult("call_1", "shell_exec", [text("a.txt")])]),
  ]);

  // The tool message itself must not appear as a row.
  assert.equal(out.length, 2);
  const tool = out[1].tools[0];
  assert.equal(tool.callId, "call_1");
  assert.equal(tool.name, "shell_exec");
  assert.equal(tool.result, "a.txt");
  assert.equal(tool.isError, false);
  assert.equal(tool.running, false, "a result must clear the running flag");
});

test("buildMessages keeps a still-running call marked running", () => {
  const out = buildMessages([message("assistant", [toolCall("call_1", "shell_exec", {})])]);
  assert.equal(out[0].tools[0].running, true);
  assert.equal(out[0].tools[0].result, undefined);
});

test("buildMessages carries the branch controls and per-message usage", () => {
  const node = message("user", [text("q")]);
  node.siblingIndex = 1;
  node.siblingCount = 3;
  node.siblingIds = ["a", "b", "c"];
  const out = buildMessages([
    node,
    message("assistant", [text("a")], { usage: { inputTokens: 5, outputTokens: 7 } }),
  ]);
  assert.deepEqual(out[0].branch, { index: 1, count: 3, ids: ["a", "b", "c"] });
  assert.deepEqual(out[1].usage, { inputTokens: 5, outputTokens: 7 });
});

test("buildMessages resolves each image source kind", () => {
  const out = buildMessages([
    message("user", [
      { type: "image", source: { kind: "attachment", id: "att_1", mime: "image/png" } },
      { type: "image", source: { kind: "url", url: "https://x/y.png", mime: "image/png" } },
      { type: "image", source: { kind: "data", data: "AAA", mime: "image/jpeg" } },
    ]),
  ]);
  assert.deepEqual(out[0].images, [
    { src: "", attachmentId: "att_1" },
    { src: "https://x/y.png" },
    { src: "data:image/jpeg;base64,AAA" },
  ]);
});

test("buildMessages concatenates several text parts in order", () => {
  const out = buildMessages([message("assistant", [text("a"), text("b"), text("c")])]);
  assert.equal(out[0].text, "abc");
});

test("buildMessages collects reasoning separately from the answer", () => {
  const out = buildMessages([
    message("assistant", [
      { type: "reasoning", text: "think " },
      text("answer"),
      { type: "reasoning", text: "more" },
    ]),
  ]);
  assert.equal(out[0].text, "answer");
  assert.equal(out[0].reasoning, "think more");
});

// --- readEvent / applyEffect ----------------------------------------------

test("readEvent maps every event the turn stream emits", () => {
  const cases: [KernelEvent, unknown][] = [
    [{ type: "turn.start", turnId: "turn_1" }, { kind: "reset-usage" }],
    [
      { type: "message.start", messageId: "m1", role: "assistant" },
      { kind: "start-message", id: "m1" },
    ],
    [
      { type: "text.delta", messageId: "m1", text: "hi" },
      { kind: "append-text", text: "hi" },
    ],
    [
      { type: "reasoning.delta", messageId: "m1", text: "why" },
      { kind: "append-reasoning", text: "why" },
    ],
    [
      { type: "tool.call", messageId: "m1", callId: "c1", name: "shell_exec", args: { command: "ls" } },
      { kind: "tool-call", callId: "c1", name: "shell_exec", args: { command: "ls" } },
    ],
    [
      { type: "tool.approval", callId: "c1", status: "requested" },
      { kind: "tool-approval", callId: "c1", status: "requested" },
    ],
    [
      { type: "tool.result", callId: "c1", name: "shell_exec", parts: [text("done")], isError: false },
      { kind: "tool-result", callId: "c1", result: "done", isError: false },
    ],
    [
      { type: "error", error: { code: "boom", message: "it broke" } },
      { kind: "error", message: "it broke" },
    ],
    [{ type: "warning", message: "no vision" }, { kind: "warning", message: "no vision" }],
  ];
  for (const [event, expected] of cases) {
    assert.deepEqual(readEvent(event), expected, event.type);
  }
});

test("readEvent treats the non-visual events as no-ops", () => {
  assert.deepEqual(readEvent({ type: "message.done", messageId: "m1", finishReason: "stop" }), {
    kind: "none",
  });
  assert.deepEqual(readEvent({ type: "turn.done", turnId: "turn_1" }), { kind: "none" });
  assert.deepEqual(readEvent({ type: "usage", usage: { totalTokens: 5 } }), { kind: "none" });
});

test("a full turn folds into one assistant message", () => {
  let streaming: UiMessage | null = emptyAssistant("m1");
  const events: KernelEvent[] = [
    { type: "text.delta", messageId: "m1", text: "Hello" },
    { type: "text.delta", messageId: "m1", text: " world" },
    { type: "tool.call", messageId: "m1", callId: "c1", name: "shell_exec", args: { command: "ls" } },
    { type: "tool.approval", callId: "c1", status: "requested" },
    { type: "tool.result", callId: "c1", name: "shell_exec", parts: [text("a.txt")], isError: false },
    { type: "message.done", messageId: "m1", finishReason: "tool_calls" },
  ];
  for (const event of events) streaming = applyEffect(streaming, readEvent(event));

  assert.equal(streaming?.text, "Hello world");
  assert.deepEqual(streaming?.tools, [
    {
      callId: "c1",
      name: "shell_exec",
      args: { command: "ls" },
      approval: "requested",
      result: "a.txt",
      isError: false,
      running: false,
    },
  ]);
});

test("a second tool iteration replaces the live message", () => {
  // The agent emits message.start once per iteration, so an earlier
  // tool-only message is superseded rather than appended to.
  let streaming: UiMessage | null = emptyAssistant("m1");
  streaming = applyEffect(streaming, {
    kind: "tool-call",
    callId: "c1",
    name: "shell_exec",
    args: {},
  });
  streaming = applyEffect(streaming, { kind: "start-message", id: "m2" });
  streaming = applyEffect(streaming, { kind: "append-text", text: "done" });

  assert.equal(streaming?.id, "m2");
  assert.equal(streaming?.text, "done");
  assert.deepEqual(streaming?.tools, [], "the superseded iteration's tools are dropped");
});

test("deltas before any message.start are ignored rather than crashing", () => {
  assert.equal(applyEffect(null, { kind: "append-text", text: "x" }), null);
  assert.equal(applyEffect(null, { kind: "tool-call", callId: "c", name: "n", args: {} }), null);
});

test("an approval for an unknown callId leaves the cards alone", () => {
  let streaming: UiMessage | null = emptyAssistant("m1");
  streaming = applyEffect(streaming, { kind: "tool-call", callId: "c1", name: "n", args: {} });
  streaming = applyEffect(streaming, {
    kind: "tool-approval",
    callId: "other",
    status: "approved",
  });
  assert.equal(streaming?.tools[0].approval, null);
});

// --- toolSummary -----------------------------------------------------------

test("toolSummary prefers the command and falls back to the first argument", () => {
  const base = { callId: "c", approval: null, running: false } as const;
  assert.equal(toolSummary({ ...base, name: "shell_exec", args: { command: "ls -la" } }), "ls -la");
  assert.equal(toolSummary({ ...base, name: "shell_exec", args: { cmd: "pwd" } }), "pwd");
  assert.equal(toolSummary({ ...base, name: "read", args: { path: "/tmp/x" } }), 'path: "/tmp/x"');
  assert.equal(toolSummary({ ...base, name: "n", args: "raw string" }), "raw string");
  assert.equal(toolSummary({ ...base, name: "n", args: {} }), "");
  assert.equal(toolSummary({ ...base, name: "n", args: null }), "");
});
