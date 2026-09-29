import assert from "node:assert/strict";
import { test } from "node:test";
import { exportMarkdown, isSessionExport } from "./transfer.js";

const base = {
  format: "hat.session",
  version: 1,
  exportedAt: 0,
  session: { title: "t", model: "fake/fake-agent" },
  activeLeafId: null,
  messages: [{ id: "a", parentId: null, role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 1 }],
};

test("isSessionExport accepts a well-formed export", () => {
  assert.equal(isSessionExport(base), true);
});

test("isSessionExport rejects the wrong format, roles and malformed parts", () => {
  assert.equal(isSessionExport({ ...base, format: "other" }), false);
  assert.equal(isSessionExport({ ...base, version: 2 }), false);
  const withRole = (role: string) => ({ ...base, messages: [{ ...base.messages[0], role }] });
  assert.equal(isSessionExport(withRole("admin")), false);
  const withParts = (parts: unknown[]) => ({ ...base, messages: [{ ...base.messages[0], parts }] });
  assert.equal(isSessionExport(withParts([{ type: "text" }])), false);
  assert.equal(isSessionExport(withParts(["text"])), false);
  assert.equal(isSessionExport(withParts([{ type: "tool_result", id: "c", content: [{ type: "nope" }] }])), false);
  assert.equal(isSessionExport({ ...base, attachments: { x: { mime: "text/plain" } } }), false);
});

test("exportMarkdown renders the transcript and skips the Continue nudge", () => {
  const md = exportMarkdown(
    {
      id: "s",
      title: "My chat",
      titleSource: "user",
      model: "fake/fake-agent",
      activeLeafId: null,
      approvalMode: "auto",
      allowedTools: [],
      reasoningEffort: "low",
      instructions: "Be brief.",
      temperature: null,
      maxTokens: null,
      createdAt: 0,
      updatedAt: 0,
    },
    [
      { id: "1", role: "user", parts: [{ type: "text", text: "question" }], createdAt: 0 },
      { id: "2", role: "assistant", parts: [{ type: "text", text: "partial" }], createdAt: 0 },
      { id: "3", role: "user", parts: [{ type: "text", text: "nudge" }], createdAt: 0, meta: { synthetic: "continue" } },
      { id: "4", role: "assistant", parts: [{ type: "text", text: " rest" }], createdAt: 0 },
    ],
  );
  assert.match(md, /^# My chat/);
  assert.match(md, /Be brief\./);
  assert.ok(md.includes("question") && md.includes("partial") && md.includes(" rest"));
  assert.ok(!md.includes("nudge"));
});
