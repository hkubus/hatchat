import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSandboxMode,
  probeRuntime,
  resolveSandbox,
  spawnPlan,
  type ProbeResult,
  type SandboxConfig,
  type SandboxSettings,
} from "./sandbox.js";

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

const settings: SandboxSettings = {
  mode: "auto",
  image: "node:22-slim",
  network: "none",
  memory: "512m",
  cpus: "1",
};

/** A fake probe that answers from a table and records what it was asked. */
function fakeProbe(results: Record<string, ProbeResult>) {
  const calls: string[] = [];
  const probe = async (runtime: string): Promise<ProbeResult> => {
    calls.push(runtime);
    return results[runtime] ?? { ok: false, reason: "not installed" };
  };
  return { probe, calls };
}

test("parseSandboxMode accepts the three tiers and rejects anything else", () => {
  assert.equal(parseSandboxMode("auto"), "auto");
  assert.equal(parseSandboxMode(" Container "), "container");
  assert.equal(parseSandboxMode("host"), "host");
  assert.throws(() => parseSandboxMode("docker"), /auto, host or container/);
});

test("auto picks docker when it answers", async () => {
  const { probe, calls } = fakeProbe({ docker: { ok: true, version: "27.1.1" } });
  const { sandbox, reason } = await resolveSandbox(settings, probe);
  assert.equal(sandbox.mode, "container");
  assert.equal(sandbox.runtime, "docker");
  assert.equal(sandbox.image, "node:22-slim");
  assert.deepEqual(calls, ["docker"]);
  assert.match(reason, /docker 27\.1\.1 is available/);
});

test("auto falls through to podman when docker is unusable", async () => {
  const { probe, calls } = fakeProbe({
    docker: { ok: false, reason: "Cannot connect to the Docker daemon" },
    podman: { ok: true, version: "5.2.0" },
  });
  const { sandbox } = await resolveSandbox(settings, probe);
  assert.equal(sandbox.mode, "container");
  assert.equal(sandbox.runtime, "podman");
  assert.deepEqual(calls, ["docker", "podman"]);
});

test("auto falls back to host when no runtime answers, and says why", async () => {
  const { probe } = fakeProbe({ docker: { ok: false, reason: "timed out" } });
  const { sandbox, reason } = await resolveSandbox(settings, probe);
  assert.equal(sandbox.mode, "host");
  assert.match(reason, /docker: timed out; podman: not installed/);
});

test("an explicit runtime is the only one probed", async () => {
  const { probe, calls } = fakeProbe({ docker: { ok: true, version: "27.1.1" } });
  const { sandbox } = await resolveSandbox({ ...settings, runtime: "podman" }, probe);
  assert.equal(sandbox.mode, "host");
  assert.deepEqual(calls, ["podman"]);
});

test("host mode never probes", async () => {
  const { probe, calls } = fakeProbe({ docker: { ok: true, version: "27.1.1" } });
  const { sandbox } = await resolveSandbox({ ...settings, mode: "host" }, probe);
  assert.equal(sandbox.mode, "host");
  assert.deepEqual(calls, []);
});

test("container mode uses a working runtime", async () => {
  const { probe } = fakeProbe({ podman: { ok: true, version: "5.2.0" } });
  const { sandbox } = await resolveSandbox({ ...settings, mode: "container" }, probe);
  assert.deepEqual(sandbox, { ...settings, mode: "container", runtime: "podman" });
});

test("container mode with no working runtime fails instead of falling back", async () => {
  const { probe } = fakeProbe({});
  await assert.rejects(
    resolveSandbox({ ...settings, mode: "container" }, probe),
    /HAT_EXEC_SANDBOX=container but no container runtime is usable \(docker: not installed; podman: not installed\)/,
  );
});

test("the real probe reports a missing binary as not installed", async () => {
  const result = await probeRuntime("hat-no-such-runtime");
  assert.deepEqual(result, { ok: false, reason: "not installed" });
});
