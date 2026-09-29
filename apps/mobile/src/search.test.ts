import assert from "node:assert/strict";
import { test } from "node:test";
import { snippetParts } from "./search";

test("snippetParts marks the terms the server wrapped in « »", () => {
  assert.deepEqual(snippetParts("…the «quick» brown «fox» jumps"), [
    { text: "…the ", hit: false },
    { text: "quick", hit: true },
    { text: " brown ", hit: false },
    { text: "fox", hit: true },
    { text: " jumps", hit: false },
  ]);
});

test("snippetParts handles a hit at either end and collapses whitespace", () => {
  assert.deepEqual(snippetParts("«alpha»\n\n  beta «gamma»"), [
    { text: "alpha", hit: true },
    { text: " beta ", hit: false },
    { text: "gamma", hit: true },
  ]);
});

test("snippetParts leaves an unbalanced marker as plain text", () => {
  assert.deepEqual(snippetParts("a « b"), [{ text: "a « b", hit: false }]);
  assert.deepEqual(snippetParts(""), []);
});
