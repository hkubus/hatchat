import assert from "node:assert/strict";
import { test } from "node:test";
import { SseFrameParser, decodeFrame, frameData } from "./sse.js";

/** Feed a whole SSE body and return every payload it produced. */
function parseAll(body: string): string[] {
  const parser = new SseFrameParser();
  return [...parser.push(body), ...parser.flush()];
}

/** Same, but split the body into chunks of `size` characters. */
function parseInChunks(body: string, size: number): string[] {
  const parser = new SseFrameParser();
  const out: string[] = [];
  for (let i = 0; i < body.length; i += size) {
    out.push(...parser.push(body.slice(i, i + size)));
  }
  out.push(...parser.flush());
  return out;
}

const frame = (payload: unknown): string => `event: kernel\ndata: ${JSON.stringify(payload)}\n\n`;

test("decodes complete frames and ignores keepalive comments", () => {
  const parser = new SseFrameParser();
  assert.deepEqual(
    parser.push(': keepalive\n\ndata: {"a":1}\n\n: keepalive\n\ndata: {"b":2}\n\n'),
    ['{"a":1}', '{"b":2}'],
  );
  assert.deepEqual(parser.flush(), []);
});

test("buffers a frame that arrives in pieces", () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push("data: {\"a\""), []);
  assert.deepEqual(parser.push(":1}\n"), []);
  assert.deepEqual(parser.push("\n"), ['{"a":1}']);
});

test("splits several frames delivered in one chunk", () => {
  const body = frame({ n: 1 }) + frame({ n: 2 }) + frame({ n: 3 });
  assert.deepEqual(parseAll(body), ['{"n":1}', '{"n":2}', '{"n":3}']);
});

test("reassembles a frame split at every possible offset", () => {
  const body = `: keepalive\n\nevent: kernel\ndata: ${JSON.stringify({ text: "héllo 🌍" })}\n\n`;
  const expected = [JSON.stringify({ text: "héllo 🌍" })];
  for (let size = 1; size <= body.length; size++) {
    assert.deepEqual(parseInChunks(body, size), expected, `chunk size ${size}`);
  }
});

test("flush() yields a frame that never got its terminator", () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push('data: {"done":true}'), []);
  assert.deepEqual(parser.flush(), ['{"done":true}']);
  assert.deepEqual(parser.flush(), [], "flush is not repeatable");
});

test("flush() drops a comment-only or whitespace tail", () => {
  const parser = new SseFrameParser();
  parser.push(': keepalive\n\n');
  assert.deepEqual(parser.flush(), []);
  assert.deepEqual(parseAll("   \n\n"), []);
});

test("joins multi-line data with newlines and drops one leading space", () => {
  assert.equal(frameData("data: {\ndata:   \"a\": 1\ndata: }"), '{\n  "a": 1\n}');
  assert.equal(frameData("data:no-space"), "no-space");
  assert.equal(frameData("event: kernel\nid: 7\nretry: 10\ndata: x"), "x");
  assert.equal(frameData("data"), "", "a bare field name carries an empty value");
});

test("handles CRLF terminators from a rewriting proxy", () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'), [
    '{"a":1}',
    '{"b":2}',
  ]);
});

test("handles CR-only terminators", () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push('data: {"a":1}\r\rdata: {"b":2}\r\r'), ['{"a":1}', '{"b":2}']);
});

test("finds a terminator split across chunks", () => {
  for (const terminator of ["\n\n", "\r\n\r\n", "\r\r"]) {
    const body = `data: one${terminator}data: two${terminator}`;
    for (let cut = 0; cut <= body.length; cut++) {
      const parser = new SseFrameParser();
      const out = [...parser.push(body.slice(0, cut)), ...parser.push(body.slice(cut))];
      assert.deepEqual(out, ["one", "two"], `${JSON.stringify(terminator)} cut at ${cut}`);
      assert.deepEqual(parser.flush(), []);
    }
  }
});

test("decodeFrame passes JSON through and swallows malformed frames", () => {
  assert.deepEqual(decodeFrame<{ a: number }>('{"a":1}'), { a: 1 });
  assert.equal(decodeFrame('{"a":'), null);
  assert.equal(decodeFrame("not json at all"), null);
});

test("survives a decoder flush that completes a multi-byte character", () => {
  const body = frame({ text: "🌍" });
  const bytes = new TextEncoder().encode(body);
  // Cut in the middle of the emoji's four UTF-8 bytes.
  const split = bytes.indexOf(0xf0) + 2;
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();

  const out = [
    ...parser.push(decoder.decode(bytes.slice(0, split), { stream: true })),
    ...parser.push(decoder.decode(bytes.slice(split), { stream: true })),
    ...parser.push(decoder.decode()),
    ...parser.flush(),
  ];
  assert.deepEqual(out, [JSON.stringify({ text: "🌍" })]);
});
