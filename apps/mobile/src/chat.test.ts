import type { KernelEvent, Part, Usage } from "@hat/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PathNode } from "./api";
import type { UiMessage } from "./chat";
import {
  applyEffect,
  buildMessages,
  emptyAssistant,
  formatBytes,
  joinAnswer,
  questionOf,
  readEvent,
  todosOf,
  toolResultOf,
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
      { kind: "append-text", messageId: "m1", text: "hi" },
    ],
    [
      { type: "reasoning.delta", messageId: "m1", text: "why" },
      { kind: "append-reasoning", messageId: "m1", text: "why" },
    ],
    [
      { type: "tool.call", messageId: "m1", callId: "c1", name: "shell_exec", args: { command: "ls" } },
      { kind: "tool-call", messageId: "m1", callId: "c1", name: "shell_exec", args: { command: "ls" } },
    ],
    [
      { type: "session.title", sessionId: "sess_1", title: "Fix the parser" },
      { kind: "session-title", sessionId: "sess_1", title: "Fix the parser" },
    ],
    [
      { type: "tool.approval", callId: "c1", status: "requested" },
      { kind: "tool-approval", callId: "c1", status: "requested" },
    ],
    [
      { type: "tool.result", callId: "c1", name: "shell_exec", parts: [text("done")], isError: false },
      { kind: "tool-result", callId: "c1", result: "done", images: [], files: [], isError: false },
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
  let inFlight: UiMessage[] = [];
  const events: KernelEvent[] = [
    { type: "message.start", messageId: "m1", role: "assistant" },
    { type: "text.delta", messageId: "m1", text: "Hello" },
    { type: "text.delta", messageId: "m1", text: " world" },
    {
      type: "tool.call",
      messageId: "m1",
      callId: "c1",
      name: "shell_exec",
      args: { command: "ls" },
    },
    { type: "tool.approval", callId: "c1", status: "requested" },
    { type: "tool.result", callId: "c1", name: "shell_exec", parts: [text("a.txt")], isError: false },
    { type: "message.done", messageId: "m1", finishReason: "tool_calls" },
  ];
  for (const event of events) inFlight = applyEffect(inFlight, readEvent(event));

  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0].text, "Hello world");
  assert.deepEqual(inFlight[0].tools, [
    {
      callId: "c1",
      name: "shell_exec",
      args: { command: "ls" },
      approval: "requested",
      result: "a.txt",
      images: [],
      files: [],
      isError: false,
      running: false,
    },
  ]);
});

test("a tool-using turn keeps every iteration's message on screen", () => {
  // The agent emits message.start once per *model iteration*, not once per
  // turn. Each is a distinct assistant message holding the tool calls made in
  // it, so the earlier ones must survive — they are the only record of what
  // ran while the model was still working.
  let inFlight: UiMessage[] = [];
  const events: KernelEvent[] = [
    { type: "message.start", messageId: "m1", role: "assistant" },
    { type: "tool.call", messageId: "m1", callId: "c1", name: "shell_exec", args: {} },
    { type: "tool.result", callId: "c1", name: "shell_exec", parts: [text("a")], isError: false },
    { type: "message.done", messageId: "m1", finishReason: "tool_calls" },
    // Second iteration: the model sees the result and answers.
    { type: "message.start", messageId: "m2", role: "assistant" },
    { type: "text.delta", messageId: "m2", text: "found a" },
    { type: "message.done", messageId: "m2", finishReason: "stop" },
  ];
  for (const event of events) inFlight = applyEffect(inFlight, readEvent(event));

  assert.deepEqual(
    inFlight.map((m) => m.id),
    ["m1", "m2"],
  );
  assert.equal(inFlight[0].tools[0].result, "a", "the first iteration's tool is still shown");
  assert.equal(inFlight[1].text, "found a");
  assert.deepEqual(inFlight[1].tools, [], "tool cards stay with the message that made them");
});

test("tool events with no message id attach to the message that called them", () => {
  // tool.approval and tool.result carry no messageId, so the callId is the only
  // handle — and a call must never leak onto a later iteration's card.
  let inFlight: UiMessage[] = [];
  const events: KernelEvent[] = [
    { type: "message.start", messageId: "m1", role: "assistant" },
    { type: "tool.call", messageId: "m1", callId: "c1", name: "shell_exec", args: {} },
    { type: "message.start", messageId: "m2", role: "assistant" },
    { type: "tool.call", messageId: "m2", callId: "c2", name: "shell_exec", args: {} },
  ];
  for (const event of events) inFlight = applyEffect(inFlight, readEvent(event));

  inFlight = applyEffect(inFlight, readEvent({ type: "tool.result", callId: "c1", name: "shell_exec", parts: [text("only c1")], isError: false }));

  assert.equal(inFlight[0].tools[0].result, "only c1");
  assert.equal(inFlight[0].tools[0].running, false);
  assert.equal(inFlight[1].tools[0].result, undefined, "c2 is untouched");
  assert.equal(inFlight[1].tools[0].running, true);
});

test("a delta for an unknown message id lands on the newest one", () => {
  // Better than dropping the text: a reattached stream can replay a tail that
  // starts mid-message, with no message.start in sight.
  let inFlight: UiMessage[] = [emptyAssistant("m1")];
  inFlight = applyEffect(inFlight, { kind: "append-text", messageId: "m_unknown", text: "tail" });
  assert.equal(inFlight[0].text, "tail");
});

test("events before any message.start are ignored rather than crashing", () => {
  assert.deepEqual(applyEffect([], { kind: "append-text", messageId: "m1", text: "x" }), []);
  assert.deepEqual(
    applyEffect([], { kind: "tool-call", messageId: "m1", callId: "c", name: "n", args: {} }),
    [],
  );
  assert.deepEqual(applyEffect([], { kind: "append-text", messageId: "m1", text: "x" }), []);
});

test("an approval for an unknown callId leaves the cards alone", () => {
  let inFlight: UiMessage[] = [];
  const events: KernelEvent[] = [
    { type: "message.start", messageId: "m1", role: "assistant" },
    { type: "tool.call", messageId: "m1", callId: "c1", name: "n", args: {} },
  ];
  for (const event of events) inFlight = applyEffect(inFlight, readEvent(event));
  inFlight = applyEffect(inFlight, { kind: "tool-approval", callId: "other", status: "approved" });
  assert.equal(inFlight[0].tools[0].approval, null);
});

test("session.title is surfaced so a new conversation names itself live", () => {
  assert.deepEqual(
    readEvent({ type: "session.title", sessionId: "sess_1", title: "Fix the parser" }),
    { kind: "session-title", sessionId: "sess_1", title: "Fix the parser" },
  );
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

test("toolSummary uses the key argument of known tools", () => {
  const base = { callId: "c", approval: null, running: false } as const;
  assert.equal(toolSummary({ ...base, name: "read_file", args: { path: "a.ts", limit: 5 } }), "a.ts");
  assert.equal(toolSummary({ ...base, name: "web_fetch", args: { url: "https://x.y" } }), "https://x.y");
  assert.equal(
    toolSummary({ ...base, name: "python", args: { code: "\nimport os\nprint(1)" } }),
    "import os",
  );
  assert.equal(toolSummary({ ...base, name: "ask_user", args: { question: "Why?" } }), "Why?");
  assert.equal(toolSummary({ ...base, name: "spawn_subagent", args: { task: "Do A\nthen B" } }), "Do A");
  assert.equal(toolSummary({ ...base, name: "schedule_create", args: { title: "Daily" } }), "Daily");
  assert.equal(toolSummary({ ...base, name: "todo_write", args: { todos: [] } }), "");
});

// --- tool results with artifacts ------------------------------------------

test("toolResultOf splits text, images and files", () => {
  const out = toolResultOf([
    text("saved"),
    { type: "image", source: { kind: "data", mime: "image/png", data: "AAA" } },
    { type: "file", id: "att_9", name: "report.csv", mime: "text/csv", size: 2048 },
  ]);
  assert.equal(out.result, "saved");
  assert.deepEqual(out.images, [{ src: "data:image/png;base64,AAA" }]);
  assert.deepEqual(out.files, [{ id: "att_9", name: "report.csv", mime: "text/csv", size: 2048 }]);
});

test("buildMessages and tool.result both carry result artifacts", () => {
  const file: Part = { type: "file", id: "att_1", name: "a.txt", mime: "text/plain", size: 3 };
  const stored = buildMessages([
    message("assistant", [toolCall("c1", "create_artifact", { name: "a.txt" })]),
    message("tool", [toolResult("c1", "create_artifact", [text("ok"), file])]),
  ]);
  assert.equal(stored[0].tools[0].files?.[0].id, "att_1");

  let live = applyEffect([emptyAssistant("m")], {
    kind: "tool-call",
    messageId: "m",
    callId: "c1",
    name: "python",
    args: {},
  });
  live = applyEffect(
    live,
    readEvent({ type: "tool.result", callId: "c1", name: "t", parts: [file], isError: false } as KernelEvent),
  );
  assert.equal(live[0].tools[0].files?.[0].name, "a.txt");
  assert.equal(live[0].tools[0].running, false);
});

test("a result for an unknown callId (e.g. a subagent's) is ignored", () => {
  const list = [emptyAssistant("m")];
  const next = applyEffect(
    list,
    readEvent({ type: "tool.result", callId: "nope", name: "t", parts: [], isError: false } as KernelEvent),
  );
  assert.equal(next, list);
});

// --- todo_write / ask_user -------------------------------------------------

test("todosOf keeps well-formed items and defaults unknown statuses", () => {
  assert.deepEqual(
    todosOf({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "weird" },
        { status: "pending" },
      ],
    }),
    [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ],
  );
  assert.deepEqual(todosOf(null), []);
  assert.deepEqual(todosOf({ todos: "x" }), []);
});

test("questionOf reads the prompt and joinAnswer joins choices", () => {
  assert.deepEqual(questionOf({ question: "Pick", options: ["a", 1, "b"], multi_select: true }), {
    question: "Pick",
    options: ["a", "b"],
    multiSelect: true,
  });
  assert.deepEqual(questionOf({ question: "Why?" }), { question: "Why?", options: [], multiSelect: false });
  assert.equal(questionOf({}), undefined);
  assert.equal(joinAnswer(["a", "b"], "  c "), "a, b, c");
  assert.equal(joinAnswer([], "  "), "");
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(20 * 1024 * 1024), "20 MB");
});
