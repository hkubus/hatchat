import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseProcessTier,
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

const runner = { uid: 1000, gid: 1001 };
const hostEnv = { PATH: "/usr/bin", HOME: "/home/runner", DOCKER_HOST: "unix:///run/docker.sock" };

test("host mode runs the command through a shell", () => {
  const plan = spawnPlan("echo hi", "/work", { ...container, mode: "host" }, { hostEnv });
  assert.deepEqual(plan, {
    bin: "echo hi",
    args: [],
    shell: true,
    env: { PATH: "/usr/bin", HOME: "/work" },
  });
});

test("container mode wraps the command with isolation flags", () => {
  const plan = spawnPlan("echo hi", "/srv/work", container, { identity: runner, hostEnv });
  assert.equal(plan.bin, "docker");
  assert.equal(plan.shell, false);
  const args = plan.args.join(" ");
  assert.match(args, /^run --rm -i/);
  assert.match(args, /--network none/);
  assert.match(args, /--memory 512m/);
  assert.match(args, /--cpus 1/);
  assert.match(args, /--pids-limit 512/);
  assert.match(args, /--cap-drop=ALL --security-opt no-new-privileges --read-only/);
  assert.match(args, /-e HOME=\/workspace/);
  assert.match(args, /-v \/srv\/work:\/workspace/);
  assert.match(args, /node:22-slim sh -lc echo hi$/);
});

test("rootful docker runs the container as the runner's uid:gid", () => {
  const { args } = spawnPlan("id", "/w", container, { identity: runner, hostEnv });
  assert.match(args.join(" "), /--user 1000:1001/);
  assert.ok(!args.some((arg) => arg.startsWith("--userns")));
});

test("rootless podman keeps the runner's uid with keep-id", () => {
  const podman = { ...container, runtime: "/usr/bin/podman", rootless: true };
  const { args } = spawnPlan("id", "/w", podman, { identity: runner, hostEnv });
  assert.match(args.join(" "), /--userns=keep-id --user 1000:1001/);
});

test("rootful podman uses the runner's uid:gid without keep-id", () => {
  const podman = { ...container, runtime: "podman", rootless: false };
  const { args } = spawnPlan("id", "/w", podman, { identity: runner, hostEnv });
  assert.match(args.join(" "), /--user 1000:1001/);
  assert.ok(!args.includes("--userns=keep-id"));
});

test("rootless docker runs as container root, which maps to the runner's uid", () => {
  const { args } = spawnPlan("id", "/w", { ...container, rootless: true }, { identity: runner, hostEnv });
  assert.match(args.join(" "), /--user 0:0/);
});

test("without a host identity the container falls back to a fixed non-root user", () => {
  const { args } = spawnPlan("id", "/w", container, { identity: undefined, hostEnv });
  assert.match(args.join(" "), /--user 65532:65532/);
});

test("container env is forwarded by name, with values only in the CLI env", () => {
  const plan = spawnPlan("env", "/w", container, {
    identity: runner,
    hostEnv,
    env: { API_TOKEN: "s3cret", MODE: "ci" },
  });
  const args = plan.args.join(" ");
  assert.match(args, /-e API_TOKEN -e MODE -v/);
  assert.ok(!args.includes("s3cret"));
  assert.equal(plan.env.API_TOKEN, "s3cret");
  assert.equal(plan.env.MODE, "ci");
  // The runtime CLI keeps the runner's own env so it can reach its engine.
  assert.equal(plan.env.DOCKER_HOST, "unix:///run/docker.sock");
  assert.equal(plan.env.HOME, "/home/runner");
});

test("container env rejects invalid names and runtime/loader knobs", () => {
  const plan = spawnPlan("env", "/w", container, {
    identity: runner,
    hostEnv,
    env: {
      "BAD-NAME": "x",
      "A=B": "x",
      LD_PRELOAD: "/evil.so",
      HOME: "/root",
      PATH: "/evil",
      DOCKER_HOST: "tcp://evil:2375",
      CONTAINER_HOST: "tcp://evil",
      XDG_RUNTIME_DIR: "/tmp/evil",
      HTTPS_PROXY: "http://evil",
      OK_KEY: "1",
    },
  });
  const forwarded = plan.args.flatMap((arg, i) => (plan.args[i - 1] === "-e" ? [arg] : []));
  assert.deepEqual(forwarded, ["HOME=/workspace", "OK_KEY"]);
  assert.equal(plan.env.DOCKER_HOST, "unix:///run/docker.sock");
  assert.equal(plan.env.PATH, "/usr/bin");
  assert.equal(plan.env.LD_PRELOAD, undefined);
});

test("host env filtering blocks loader variables such as LD_PRELOAD", () => {
  const plan = spawnPlan("true", "/w", { ...container, mode: "host" }, {
    hostEnv,
    env: { LD_PRELOAD: "/evil.so", DYLD_INSERT_LIBRARIES: "x", NODE_OPTIONS: "-r x", KEEP: "1" },
  });
  assert.deepEqual(plan.env, { PATH: "/usr/bin", HOME: "/w", KEEP: "1" });
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

const up = (version: string, rootless = false): ProbeResult => ({ ok: true, version, rootless });

test("parseSandboxMode accepts the three tiers and rejects anything else", () => {
  assert.equal(parseSandboxMode("auto"), "auto");
  assert.equal(parseSandboxMode(" Container "), "container");
  assert.equal(parseSandboxMode("host"), "host");
  assert.throws(() => parseSandboxMode("docker"), /auto, host or container/);
});

test("auto picks docker when it answers", async () => {
  const { probe, calls } = fakeProbe({ docker: up("27.1.1") });
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
    podman: up("5.2.0"),
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
  const { probe, calls } = fakeProbe({ docker: up("27.1.1") });
  const { sandbox } = await resolveSandbox({ ...settings, runtime: "podman" }, probe);
  assert.equal(sandbox.mode, "host");
  assert.deepEqual(calls, ["podman"]);
});

test("host mode never probes", async () => {
  const { probe, calls } = fakeProbe({ docker: up("27.1.1") });
  const { sandbox } = await resolveSandbox({ ...settings, mode: "host" }, probe);
  assert.equal(sandbox.mode, "host");
  assert.deepEqual(calls, []);
});

test("container mode uses a working runtime", async () => {
  const { probe } = fakeProbe({ podman: up("5.2.0", true) });
  const { sandbox, reason } = await resolveSandbox({ ...settings, mode: "container" }, probe);
  assert.deepEqual(sandbox, { ...settings, mode: "container", runtime: "podman", rootless: true });
  assert.match(reason, /podman 5\.2\.0 \(rootless\) is available/);
});

test("container mode with no working runtime fails instead of falling back", async () => {
  const { probe } = fakeProbe({});
  await assert.rejects(
    resolveSandbox({ ...settings, mode: "container" }, probe),
    /HAT_EXEC_SANDBOX=container but no container runtime is usable \(docker: not installed; podman: not installed\)/,
  );
});

test("parseProcessTier accepts host, container or blank", () => {
  assert.equal(parseProcessTier(undefined), undefined);
  assert.equal(parseProcessTier(" "), undefined);
  assert.equal(parseProcessTier("Container"), "container");
  assert.throws(() => parseProcessTier("auto"), /host or container/);
});

test("auto keeps shell-mode processes on the host by default", async () => {
  const { probe } = fakeProbe({ docker: up("27.1.1") });
  const { sandbox, processes, processReason } = await resolveSandbox(settings, probe);
  assert.equal(sandbox.mode, "container");
  assert.equal(processes.mode, "host");
  assert.match(processReason, /HAT_SANDBOX_PROCESSES is unset and HAT_EXEC_SANDBOX=auto/);
});

test("processes opt into the container tier with HAT_SANDBOX_PROCESSES", async () => {
  const { probe } = fakeProbe({ docker: up("27.1.1") });
  const { sandbox, processes } = await resolveSandbox({ ...settings, processes: "container" }, probe);
  assert.equal(processes, sandbox);
});

test("processes stay on the host when auto found no runtime, even if opted in", async () => {
  const { probe } = fakeProbe({});
  const { processes, processReason } = await resolveSandbox(
    { ...settings, processes: "container" },
    probe,
  );
  assert.equal(processes.mode, "host");
  assert.match(processReason, /no container runtime is in use/);
});

test("explicit container mode sandboxes processes too, unless overridden", async () => {
  const { probe } = fakeProbe({ docker: up("27.1.1") });
  const strict = await resolveSandbox({ ...settings, mode: "container" }, probe);
  assert.equal(strict.processes.mode, "container");
  const split = await resolveSandbox({ ...settings, mode: "container", processes: "host" }, probe);
  assert.equal(split.sandbox.mode, "container");
  assert.equal(split.processes.mode, "host");
});

/** Write an executable stand-in for a runtime CLI that prints a fixed answer. */
async function fakeRuntime(name: string, script: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hat-probe-"));
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test("the real probe parses docker version and rootless security option", async () => {
  const bin = await fakeRuntime("docker", `echo "27.1.1|name=seccomp,profile=builtin name=rootless "`);
  assert.deepEqual(await probeRuntime(bin), { ok: true, version: "27.1.1", rootless: true });
});

test("the real probe parses podman version and rootless flag", async () => {
  const bin = await fakeRuntime("podman", `echo "5.2.0|false"`);
  assert.deepEqual(await probeRuntime(bin), { ok: true, version: "5.2.0", rootless: false });
});

test("the real probe reports an unreachable engine with its first stderr line", async () => {
  const bin = await fakeRuntime("docker", `echo "|"; echo "Cannot connect to the Docker daemon" >&2; exit 1`);
  assert.deepEqual(await probeRuntime(bin), {
    ok: false,
    reason: "Cannot connect to the Docker daemon",
  });
});

test("the real probe reports a missing binary as not installed", async () => {
  const result = await probeRuntime("hat-no-such-runtime");
  assert.deepEqual(result, { ok: false, reason: "not installed" });
});
