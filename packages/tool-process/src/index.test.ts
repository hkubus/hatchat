import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecEvent, Part, ProcessHost, SpawnedProcess, ToolContext } from "@hat/core";
import { AsyncQueue } from "@hat/core";
import { ProcessManager, createProcessTools } from "./processes.js";
import { PythonKernels, createPythonTool } from "./python.js";

/** Runs shell processes locally in a per-session temp dir, like the runner does. */
function localProcessHost(root: string): ProcessHost {
  return {
    async spawn(request): Promise<SpawnedProcess> {
      const cwd = path.join(root, request.sessionId ?? "_processes");
      fs.mkdirSync(cwd, { recursive: true });
      const child = spawn(request.command, request.args ?? [], { cwd, shell: request.shell, detached: true });
      const events = new AsyncQueue<ExecEvent>();
      child.stdout.on("data", (d: Buffer) => events.push({ type: "stdout", data: d.toString() }));
      child.stderr.on("data", (d: Buffer) => events.push({ type: "stderr", data: d.toString() }));
      child.on("close", (code, signal) => {
        events.push({ type: "exit", code, signal, durationMs: 0 });
        events.end();
      });
      return {
        id: String(child.pid),
        events,
        write: (data) => child.stdin.write(data),
        endStdin: () => child.stdin.end(),
        kill: () => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
        },
      };
    },
  };
}

function context(sessionId = "s1"): ToolContext {
  return { sessionId, signal: new AbortController().signal } as unknown as ToolContext;
}

const textOf = (parts: Part[]): string => parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");

test("background processes stream output with a cursor and can be killed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hat-proc-"));
  const manager = new ProcessManager(() => localProcessHost(root));
  const [start, output, list, kill] = createProcessTools(manager, false);
  const ctx = context();

  const started = textOf(
    await start.execute({ command: "echo booting; sleep 0.2; echo ready; sleep 30", wait_for: "ready", wait_ms: 5_000 }, ctx),
  );
  assert.match(started, /booting\nready/);
  const id = /Started process (\S+)\./.exec(started)![1];
  const cursor = Number(/cursor=(\d+)/.exec(started)![1]);

  const nothingNew = textOf(await output.execute({ id, cursor }, ctx));
  assert.match(nothingNew, /\(no new output\)/);
  assert.match(textOf(await list.execute({}, ctx)), new RegExp(`${id}.*running`));

  // Other sessions can't see or touch it.
  await assert.rejects(() => output.execute({ id }, context("s2")), /No process/);

  assert.match(textOf(await kill.execute({ id }, ctx)), /Stopped\..*signal|exited/);
  manager.killAll();
});

test("processes run in the session workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hat-proc-"));
  const manager = new ProcessManager(() => localProcessHost(root));
  const [start] = createProcessTools(manager, false);
  const out = textOf(await start.execute({ command: "pwd", wait_ms: 2_000 }, context("sess-a")));
  assert.match(out, /sess-a/);
  manager.killAll();
});

test("python keeps state between cells, echoes values and renders errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hat-py-"));
  const kernels = new PythonKernels(() => localProcessHost(root));
  const tool = createPythonTool(kernels, false);
  const ctx = context();
  try {
    assert.equal(textOf(await tool.execute({ code: "x = 20\nprint('hi')" }, ctx)), "hi\n");
    assert.equal(textOf(await tool.execute({ code: "x * 2 + 2" }, ctx)), "42");
    const failed = textOf(await tool.execute({ code: "1/0" }, ctx));
    assert.match(failed, /ZeroDivisionError/);
    assert.doesNotMatch(failed, /_hat_run/, "driver frames are hidden");
    // input() must not eat the protocol stream.
    assert.match(textOf(await tool.execute({ code: "input()" }, ctx)), /EOFError/);
    assert.equal(textOf(await tool.execute({ code: "x" }, ctx)), "20", "state survives errors");
    assert.match(textOf(await tool.execute({ code: "x", reset: true }, ctx)), /NameError/);
  } finally {
    kernels.killAll();
  }
});

test("python timeouts restart the interpreter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hat-py-"));
  const kernels = new PythonKernels(() => localProcessHost(root));
  const tool = createPythonTool(kernels, false);
  const ctx = context();
  try {
    await tool.execute({ code: "y = 1" }, ctx);
    await assert.rejects(() => tool.execute({ code: "import time; time.sleep(10)", timeout_ms: 300 }, ctx), /timed out/);
    assert.match(textOf(await tool.execute({ code: "y" }, ctx)), /NameError/);
  } finally {
    kernels.killAll();
  }
});

test("python returns matplotlib figures as images when available", async (t) => {
  const probe = spawn("python3", ["-c", "import matplotlib"]);
  const available = await new Promise<boolean>((resolve) => probe.on("close", (code) => resolve(code === 0)));
  if (!available) {
    t.skip("matplotlib not installed");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hat-py-"));
  const kernels = new PythonKernels(() => localProcessHost(root));
  try {
    const parts = await createPythonTool(kernels, false).execute(
      { code: "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])" },
      context(),
    );
    const images = parts.filter((p) => p.type === "image");
    assert.equal(images.length, 1);
    assert.match(textOf(parts), /1 figure shown/);
  } finally {
    kernels.killAll();
  }
});
