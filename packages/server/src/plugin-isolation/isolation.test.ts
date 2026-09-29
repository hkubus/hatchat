import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExecutionHost, Logger, Part, ProviderEvent, ToolContext } from "@hat/core";
import { PluginHost, ProviderRegistry, ToolRegistry } from "@hat/kernel";
import { loadExternalPlugins } from "../plugin-loader.js";
import { loadIsolatedPlugin, sandboxSupported } from "./host.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "plugin.mjs");
const BROKEN = path.join(here, "fixtures", "broken.mjs");
const EXAMPLES = path.resolve(here, "../../../../plugins");

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (msg: string): void => void lines.push(msg);
  return { lines, debug: record, info: record, warn: record, error: record };
}

async function setup(t: TestContext, file = FIXTURE) {
  const logger = recordingLogger();
  const providers = new ProviderRegistry();
  const tools = new ToolRegistry();
  const secrets: Record<string, string> = { FIXTURE_TOKEN: "tok", OTHER_KEY: "not-yours" };
  const host = new PluginHost({
    providers,
    tools,
    secrets: { get: async (name) => secrets[name] },
    logger,
    persistence: { get: () => undefined, set: () => {} },
  });
  const plugin = await loadIsolatedPlugin(file, { logger });
  host.register(plugin, "external");
  t.after(() => host.deactivate(plugin.id));
  await host.activateAll();
  return { host, providers, tools, logger, plugin };
}

function toolContext(signal = new AbortController().signal): ToolContext {
  const host: ExecutionHost = {
    id: "fake-runner",
    capabilities: { os: "linux", arch: "x64", runtimes: [], tags: [] },
    ensureWorkspace: async (sessionId) => ({ sessionId, root: "/workspace" }),
    async *exec() {},
    fs: {
      read: async (sessionId, file) => `${sessionId}:${file}`,
      write: async () => {},
      list: async () => [],
    },
    net: { fetch: async () => ({ status: 200, headers: {}, body: "" }) },
  };
  return {
    sessionId: "s1",
    host,
    secrets: { get: async () => "unscoped" },
    approval: { request: async () => "deny" },
    audit: { record() {} },
    logger: recordingLogger(),
    signal,
  };
}

async function run(tools: ToolRegistry, name: string, args: unknown, ctx = toolContext()): Promise<string> {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} is registered`);
  const parts: Part[] = await tool.execute(args, ctx);
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("reports the manifest and round-trips tool calls through the child", async (t) => {
  const { host, tools, logger, plugin } = await setup(t);

  assert.equal(plugin.id, "fixture");
  assert.deepEqual(plugin.requiresSecrets, ["FIXTURE_TOKEN"]);
  assert.equal(host.get("fixture")?.status, "active");
  const configSchema = host.get("fixture")?.configSchema as { properties: Record<string, unknown> };
  assert.ok(configSchema.properties.greeting, "zod config schema arrives as JSON Schema");
  assert.ok(logger.lines.some((line) => line.includes("fixture activated")), "logger is forwarded");

  const echo = tools.get("fixture_echo");
  const parameters = echo?.parameters as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(parameters.required, ["text"]);
  assert.equal(echo?.schema, undefined, "zod stays in the child");

  assert.equal(await run(tools, "fixture_echo", { text: "hi" }), "hello hi (s1)");
  await assert.rejects(run(tools, "fixture_echo", { text: 5 }), /Expected string/);

  await host.setConfig("fixture", { greeting: 5 });
  assert.equal(host.get("fixture")?.status, "error");
  assert.match(host.get("fixture")?.error ?? "", /invalid config/);
  assert.equal(tools.get("fixture_echo"), undefined);

  await host.setConfig("fixture", { greeting: "hey" });
  assert.equal(await run(tools, "fixture_echo", { text: "hi" }), "hey hi (s1)");
});

test("serves only declared secrets and scrubs the environment", async (t) => {
  process.env.HAT_MASTER_KEY_TEST_LEAK = "leak";
  t.after(() => delete process.env.HAT_MASTER_KEY_TEST_LEAK);
  const { tools } = await setup(t);

  assert.equal(await run(tools, "fixture_secret", { name: "FIXTURE_TOKEN" }), "value:tok");
  assert.match(
    await run(tools, "fixture_secret", { name: "OTHER_KEY" }),
    /^denied:secret "OTHER_KEY" is not declared in requiresSecrets$/,
  );

  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hat-iso-")), "secret.txt");
  fs.writeFileSync(outside, "top secret");
  t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  const probe = JSON.parse(await run(tools, "fixture_probe", { path: outside })) as {
    env: string[];
    read: string;
  };
  assert.ok(!probe.env.includes("HAT_MASTER_KEY_TEST_LEAK"), "server env is not inherited");
  if (sandboxSupported) assert.equal(probe.read, "ERR_ACCESS_DENIED");
});

test("forwards the execution host, pinned to the call and its permissions", async (t) => {
  const { tools } = await setup(t);
  // The plugin asks for another session; the call's own session is used.
  assert.equal(await run(tools, "fixture_fs", { path: "notes.txt" }), "s1:notes.txt");
  // `runner:exec` was not declared.
  await assert.rejects(run(tools, "fixture_exec", {}), /host\.exec requires the runner:exec permission/);
});

test("propagates aborts to the child", async (t) => {
  const { tools, logger } = await setup(t);
  const controller = new AbortController();
  const pending = run(tools, "fixture_wait", {}, toolContext(controller.signal));
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /aborted/);
  await until(() => logger.lines.some((line) => line.includes("wait aborted")), "the child to see the abort");
});

test("streams provider events and caches reported capabilities", async (t) => {
  const { providers } = await setup(t);
  const provider = providers.get("fixture");
  assert.ok(provider);

  const events: ProviderEvent[] = [];
  for await (const event of provider.chat({ model: "smart", messages: [] }, new AbortController().signal)) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "text.delta", text: "model:" },
    { type: "text.delta", text: "smart" },
    { type: "error", error: { code: "x", message: "soft" } },
    { type: "done", finishReason: "stop" },
  ]);

  assert.equal(provider.capabilities("smart").toolCalls, false);
  const models = await provider.listModels();
  assert.deepEqual(models.map((m) => m.id), ["fixture/smart"]);
  assert.equal(provider.capabilities("smart").toolCalls, true);
});

test("a crash marks the plugin errored and unregisters its contributions", async (t) => {
  const { host, tools, providers } = await setup(t);

  await assert.rejects(run(tools, "fixture_crash", {}), /boom/);
  await until(() => host.get("fixture")?.status === "error", "the error status");
  assert.match(host.get("fixture")?.error ?? "", /uncaught exception: boom/);
  assert.equal(tools.get("fixture_echo"), undefined);
  assert.equal(providers.get("fixture"), undefined);

  // Re-enabling starts a fresh process.
  await host.setEnabled("fixture", true);
  assert.equal(host.get("fixture")?.status, "active");
  assert.equal(await run(tools, "fixture_echo", { text: "again" }), "hello again (s1)");
});

test("disabling the plugin kills its process", async (t) => {
  const { host, tools } = await setup(t);
  const { pid } = JSON.parse(await run(tools, "fixture_probe", { path: FIXTURE })) as { pid: number };
  assert.doesNotThrow(() => process.kill(pid, 0));

  await host.setEnabled("fixture", false);
  assert.equal(host.get("fixture")?.status, "disabled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("rejects a plugin that fails to load", async () => {
  await assert.rejects(
    loadIsolatedPlugin(BROKEN, { logger: recordingLogger() }),
    /import failed: kaboom/,
  );
});

test("runs plugins/example.mjs unchanged", async (t) => {
  const logger = recordingLogger();
  const [example] = await loadExternalPlugins(EXAMPLES, logger);
  assert.equal(example?.id, "example-echo");

  const tools = new ToolRegistry();
  const host = new PluginHost({
    providers: new ProviderRegistry(),
    tools,
    secrets: { get: async () => undefined },
    logger,
    persistence: { get: () => undefined, set: () => {} },
  });
  host.register(example, "external");
  t.after(() => host.deactivate(example.id));
  await host.activateAll();

  assert.equal(host.get("example-echo")?.status, "active");
  assert.equal(await run(tools, "example_echo", { text: "hi" }), "echo: hi");
});

test("HAT_PLUGINS_ISOLATION=off loads plugins in-process", async () => {
  const [example] = await loadExternalPlugins(EXAMPLES, recordingLogger(), { isolate: false });
  assert.equal(example?.id, "example-echo");
  // The module's own object, not an isolation proxy (which adds `deactivate`).
  assert.equal(example?.deactivate, undefined);
});
