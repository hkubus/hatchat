import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecEvent, ExecutionHost, Part, Tool, ToolContext } from "@hat/core";
import {
  applyEdit,
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
  numberLines,
} from "./index.js";

/** A host backed by a temp directory and the local shell. */
function localHost(root: string): ExecutionHost {
  return {
    id: "local",
    capabilities: { os: "linux", arch: "x64", runtimes: [], tags: [] },
    async ensureWorkspace(sessionId) {
      return { sessionId, root };
    },
    async *exec(req): AsyncIterable<ExecEvent> {
      const child = spawn("sh", ["-c", req.command], { cwd: path.join(root, req.cwd ?? ".") });
      const events: ExecEvent[] = [];
      child.stdout.on("data", (d: Buffer) => events.push({ type: "stdout", data: d.toString() }));
      child.stderr.on("data", (d: Buffer) => events.push({ type: "stderr", data: d.toString() }));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      yield* events;
      yield { type: "exit", code, signal: null, durationMs: 0 };
    },
    fs: {
      read: async (_s, p) => fs.promises.readFile(path.join(root, p), "utf8"),
      write: async (_s, p, data) => {
        await fs.promises.mkdir(path.dirname(path.join(root, p)), { recursive: true });
        await fs.promises.writeFile(path.join(root, p), data);
      },
      list: async (_s, p) =>
        (await fs.promises.readdir(path.join(root, p), { withFileTypes: true })).map((e) => ({
          name: e.name,
          path: path.join(p, e.name),
          type: e.isDirectory() ? ("dir" as const) : ("file" as const),
          size: e.isFile() ? fs.statSync(path.join(root, p, e.name)).size : undefined,
        })),
    },
    net: { fetch: async () => ({ status: 200, headers: {}, body: "" }) },
  };
}

function setup(): { root: string; ctx: ToolContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hat-fs-"));
  const ctx = {
    sessionId: "s",
    host: localHost(root),
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as ToolContext;
  return { root, ctx };
}

const run = async (tool: Tool, args: unknown, ctx: ToolContext): Promise<string> =>
  (await tool.execute(args, ctx))
    .map((p: Part) => (p.type === "text" ? p.text : ""))
    .join("");

test("applyEdit requires a unique exact match unless replace_all", () => {
  assert.equal(applyEdit("a b a", "b", "c").content, "a c a");
  assert.throws(() => applyEdit("a b a", "a", "c"), /matches 2 places/);
  assert.equal(applyEdit("a b a", "a", "c", true).content, "c b c");
  assert.throws(() => applyEdit("abc", "x", "y"), /not found/);
  assert.throws(() => applyEdit("abc", "a", "a"), /identical/);
  assert.equal(applyEdit("$1 $&", "$&", "$$").content, "$1 $$", "replacement is literal");
});

test("numberLines pads to the widest line number", () => {
  assert.equal(numberLines(["x", "y"], 9), " 9\tx\n10\ty");
});

test("write, read (with paging), and edit a file", async () => {
  const { root, ctx } = setup();
  await run(createWriteFileTool(false), { path: "dir/a.txt", content: "one\ntwo\nthree\n" }, ctx);
  assert.equal(fs.readFileSync(path.join(root, "dir/a.txt"), "utf8"), "one\ntwo\nthree\n");

  assert.equal(await run(createReadFileTool(), { path: "dir/a.txt" }, ctx), "1\tone\n2\ttwo\n3\tthree");
  const paged = await run(createReadFileTool(), { path: "dir/a.txt", offset: 2, limit: 1 }, ctx);
  assert.match(paged, /^2\ttwo/);
  assert.match(paged, /offset=3/);

  const edited = await run(createEditFileTool(false), { path: "dir/a.txt", old_string: "two", new_string: "2" }, ctx);
  assert.match(edited, /1 replacement/);
  assert.equal(fs.readFileSync(path.join(root, "dir/a.txt"), "utf8"), "one\n2\nthree\n");
});

test("read_file refuses binary files", async () => {
  const { root, ctx } = setup();
  fs.writeFileSync(path.join(root, "bin"), Buffer.from([0, 1, 2]));
  await assert.rejects(() => run(createReadFileTool(), { path: "bin" }, ctx), /binary/);
});

test("list_dir renders a tree and does not expand node_modules", async () => {
  const { root, ctx } = setup();
  fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/lib/a.ts"), "x");
  fs.writeFileSync(path.join(root, "README.md"), "hello");
  const out = await run(createListDirTool(), { depth: 3 }, ctx);
  assert.equal(out, "node_modules/ (not expanded)\nsrc/\n  lib/\n    a.ts  (1 B)\nREADME.md  (5 B)");
});

test("grep and glob find content and paths, quoting hostile patterns", async () => {
  const { root, ctx } = setup();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), "const answer = 42;\n");
  fs.writeFileSync(path.join(root, "src/b.py"), "answer = 'it''s'\n");

  const hits = await run(createGrepTool(), { pattern: "answer", glob: "*.ts" }, ctx);
  assert.match(hits, /src\/a\.ts:1:const answer = 42;/);
  assert.doesNotMatch(hits, /b\.py/);
  assert.equal(await run(createGrepTool(), { pattern: "'; touch pwned; '" }, ctx), "No matches.");
  assert.equal(fs.existsSync(path.join(root, "pwned")), false);

  assert.equal(await run(createGlobTool(), { pattern: "**/*.py" }, ctx), "src/b.py");
  assert.equal(await run(createGlobTool(), { pattern: "*.rs" }, ctx), "No files matched.");
});
