import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnPlan, type SandboxConfig } from "./sandbox.js";

const container: SandboxConfig = {
  mode: "container",
  runtime: "docker",
  image: "node:22-slim",
  network: "none",
  memory: "512m",
  cpus: "1",
};

test("host mode runs the command through a shell", () => {
  const plan = spawnPlan("echo hi", "/work", { ...container, mode: "host" });
  assert.deepEqual(plan, { bin: "echo hi", args: [], shell: true });
});

test("container mode wraps the command with isolation flags", () => {
  const plan = spawnPlan("echo hi", "/srv/work", container);
  assert.equal(plan.bin, "docker");
  assert.equal(plan.shell, false);
  const args = plan.args.join(" ");
  assert.match(args, /^run --rm -i/);
  assert.match(args, /--network none/);
  assert.match(args, /--memory 512m/);
  assert.match(args, /--cpus 1/);
  assert.match(args, /--pids-limit 512/);
  assert.match(args, /-v \/srv\/work:\/workspace/);
  assert.match(args, /node:22-slim sh -lc echo hi$/);
});
