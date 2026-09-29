import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RunnerToServer } from "@hat/runner-protocol";
import { startJob } from "./exec.js";
import { startProcess } from "./processes.js";
import type { SandboxConfig } from "./sandbox.js";

/**
 * A stand-in runtime CLI: `run` logs the container name and then behaves like
 * a long-running container (`quick` exits, `flood` spews output first); `rm`
 * logs its arguments.
 */
async function fakeRuntime(): Promise<{ sandbox: SandboxConfig; calls: () => Promise<string[]> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hat-runtime-"));
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "docker");
  await writeFile(
    bin,
    `#!/bin/sh
if [ "$1" = rm ]; then echo "$*" >> "${log}"; exit 0; fi
echo "run $5" >> "${log}"
for last; do :; done
if [ "$last" = quick ]; then exit 0; fi
if [ "$last" = flood ]; then head -c 100000 /dev/zero | tr '\\0' x; fi
exec sleep 30
`,
    { mode: 0o755 },
  );
  const calls = async (): Promise<string[]> =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const sandbox: SandboxConfig = {
    mode: "container",
    runtime: bin,
    image: "img",
    network: "none",
    memory: "64m",
    cpus: "1",
  };
  return { sandbox, calls };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function job(sandbox: SandboxConfig, command: string, timeoutMs = 30_000, maxOutputBytes = 1_000_000) {
  const messages: RunnerToServer[] = [];
  let finished = false;
  const handle = startJob(
    { jobId: "job_1", command, cwd: os.tmpdir(), timeoutMs, maxOutputBytes },
    sandbox,
    (message) => messages.push(message),
    () => (finished = true),
  );
  return { handle, messages, done: () => waitFor(async () => finished) };
}

/** The container name `run` was given, and the `rm -f` calls made for it. */
async function removals(calls: () => Promise<string[]>): Promise<{ name: string; rms: string[] }> {
  const lines = await calls();
  const name = lines.find((line) => line.startsWith("run "))?.slice(4) ?? "";
  return { name, rms: lines.filter((line) => line.startsWith("rm ")) };
}

test("cancelling a container job force-removes its container", async () => {
  const { sandbox, calls } = await fakeRuntime();
  const { handle, done } = job(sandbox, "sleep");
  await waitFor(async () => (await calls()).length > 0);
  await handle.abort();
  await done();
  const { name, rms } = await removals(calls);
  assert.match(name, /^hat-job_1-[0-9a-f]{8}$/);
  assert.deepEqual(rms, [`rm -f ${name}`]);
});

test("a timed-out container job force-removes its container", async () => {
  const { sandbox, calls } = await fakeRuntime();
  const { messages, done } = job(sandbox, "sleep", 300);
  await done();
  await waitFor(async () => (await removals(calls)).rms.length > 0);
  const { name, rms } = await removals(calls);
  assert.deepEqual(rms, [`rm -f ${name}`]);
  assert.ok(messages.some((m) => m.t === "exec.stderr" && m.chunk.includes("[timeout after 300ms")));
});

test("hitting the output cap force-removes the container", async () => {
  const { sandbox, calls } = await fakeRuntime();
  const { done } = job(sandbox, "flood", 30_000, 1_000);
  await done();
  await waitFor(async () => (await removals(calls)).rms.length > 0);
  const { name, rms } = await removals(calls);
  assert.deepEqual(rms, [`rm -f ${name}`]);
});

test("a container job that exits on its own is not removed again", async () => {
  const { sandbox, calls } = await fakeRuntime();
  const { handle, done } = job(sandbox, "quick");
  await done();
  await handle.abort();
  assert.deepEqual((await removals(calls)).rms, []);
});

test("killing a shell-mode process in a container force-removes it", async () => {
  const { sandbox, calls } = await fakeRuntime();
  let finished = false;
  const proc = startProcess(
    { procId: "proc_1", command: "sleep", cwd: os.tmpdir(), shell: sandbox },
    () => undefined,
    () => (finished = true),
  );
  await waitFor(async () => (await calls()).length > 0);
  await proc.kill();
  await waitFor(async () => finished);
  const { name, rms } = await removals(calls);
  assert.match(name, /^hat-proc_1-[0-9a-f]{8}$/);
  assert.deepEqual(rms, [`rm -f ${name}`]);
});
