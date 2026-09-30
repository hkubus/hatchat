import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger, Plugin, PluginContext, Provider, Tool } from "@hat/core";
import { DEFAULT_CAPABILITIES } from "@hat/core";
import { z } from "zod";
import { PluginHost } from "./plugin-host.js";
import { ProviderRegistry, ToolRegistry } from "./registries.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeProvider(id: string): Provider {
  return {
    id,
    label: id,
    capabilities: () => DEFAULT_CAPABILITIES,
    listModels: async () => [],
    async *chat() {
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: "test tool",
    schema: z.object({}),
    async execute() {
      return [];
    },
  };
}

function makeHost(secrets: Record<string, string> = {}) {
  const providers = new ProviderRegistry();
  const tools = new ToolRegistry();
  const persisted = new Map<string, { enabled: boolean; config: unknown }>();
  const host = new PluginHost({
    providers,
    tools,
    secrets: {
      async get(name) {
        return secrets[name];
      },
    },
    logger,
    persistence: {
      get: (id) => persisted.get(id),
      set: (id, state) => void persisted.set(id, state),
    },
  });
  return { host, providers, tools, secrets };
}

const basicPlugin: Plugin = {
  id: "test",
  name: "Test",
  version: "1.0.0",
  activate(ctx) {
    ctx.register.provider(makeProvider("test"));
    ctx.register.tool(makeTool("test_tool"));
  },
};

test("activates and registers contributions", async () => {
  const { host, providers, tools } = makeHost();
  host.register(basicPlugin);
  await host.activateAll();

  assert.equal(providers.get("test")?.id, "test");
  assert.equal(tools.get("test_tool")?.name, "test_tool");
  assert.equal(host.get("test")?.status, "active");
});

test("disabling removes contributions", async () => {
  const { host, providers, tools } = makeHost();
  host.register(basicPlugin);
  await host.activateAll();

  await host.setEnabled("test", false);
  assert.equal(providers.get("test"), undefined);
  assert.equal(tools.get("test_tool"), undefined);
  assert.equal(host.get("test")?.status, "disabled");

  await host.setEnabled("test", true);
  assert.equal(providers.get("test")?.id, "test");
  assert.equal(host.get("test")?.status, "active");
});

test("waits for required secrets", async () => {
  const secrets: Record<string, string> = {};
  const { host, providers } = makeHost(secrets);
  host.register({
    id: "needs",
    name: "Needs",
    version: "1.0.0",
    requiresSecrets: ["SOME_KEY"],
    activate(ctx) {
      ctx.register.provider(makeProvider("needs"));
    },
  });

  await host.activate("needs");
  assert.equal(host.get("needs")?.status, "needs-config");
  assert.equal(providers.get("needs"), undefined);

  secrets.SOME_KEY = "value";
  await host.reload();
  assert.equal(host.get("needs")?.status, "active");
  assert.equal(providers.get("needs")?.id, "needs");
});

test("rejects invalid config and rolls back", async () => {
  const { host, tools } = makeHost();
  host.register({
    id: "cfg",
    name: "Cfg",
    version: "1.0.0",
    configSchema: z.object({ n: z.number() }),
    activate(ctx) {
      ctx.register.tool(makeTool("cfg_tool"));
    },
  });

  await host.setConfig("cfg", { n: "not a number" });
  assert.equal(host.get("cfg")?.status, "error");
  assert.equal(tools.get("cfg_tool"), undefined);

  await host.setConfig("cfg", { n: 5 });
  assert.equal(host.get("cfg")?.status, "active");
  assert.equal(tools.get("cfg_tool")?.name, "cfg_tool");
});

test("rolls back partial registrations when activate throws", async () => {
  const { host, tools } = makeHost();
  host.register({
    id: "bad",
    name: "Bad",
    version: "1.0.0",
    activate(ctx) {
      ctx.register.tool(makeTool("bad_tool"));
      throw new Error("boom");
    },
  });

  await host.activate("bad");
  assert.equal(host.get("bad")?.status, "error");
  assert.equal(tools.get("bad_tool"), undefined);
});

test("describes config schema as JSON schema", () => {
  const { host } = makeHost();
  host.register({
    id: "desc",
    name: "Desc",
    version: "1.0.0",
    configSchema: z.object({ flag: z.boolean().describe("a flag") }),
    activate() {},
  });
  const schema = host.get("desc")?.configSchema as Record<string, any>;
  assert.equal(schema.properties.flag.type, "boolean");
  assert.equal(schema.$schema, undefined);
});

test("fail() after activation rolls back; stale reports are ignored", async () => {
  const { host, tools } = makeHost();
  const contexts: PluginContext[] = [];
  host.register({
    id: "flaky",
    name: "Flaky",
    version: "1.0.0",
    configJsonSchema: { type: "object", properties: {} },
    activate(ctx) {
      contexts.push(ctx);
      ctx.register.tool(makeTool("flaky_tool"));
    },
  });
  await host.activate("flaky");
  assert.deepEqual(host.get("flaky")?.configSchema, { type: "object", properties: {} });

  contexts[0].fail?.(new Error("process died"));
  assert.equal(host.get("flaky")?.status, "error");
  assert.equal(host.get("flaky")?.error, "process died");
  assert.equal(tools.get("flaky_tool"), undefined);

  await host.setEnabled("flaky", true);
  assert.equal(host.get("flaky")?.status, "active");
  contexts[0].fail?.(new Error("late report from the old activation"));
  assert.equal(host.get("flaky")?.status, "active");
  assert.equal(tools.get("flaky_tool")?.name, "flaky_tool");
});

test("lifecycle calls for one plugin run one at a time", async () => {
  const { host } = makeHost();
  let running = 0;
  let most = 0;
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  host.register({
    id: "slow",
    name: "Slow",
    version: "1.0.0",
    async activate() {
      running += 1;
      most = Math.max(most, running);
      starts += 1;
      await gate;
      running -= 1;
    },
  });

  // Saving settings twice and a secret change, from three requests at once.
  const calls = [host.setConfig("slow", { v: 1 }), host.setConfig("slow", { v: 2 }), host.reload()];
  release();
  await Promise.all(calls);

  assert.equal(most, 1, "never two activations at once");
  assert.equal(starts, 3);
  assert.deepEqual(host.get("slow")?.config, { v: 2 });
  assert.equal(host.get("slow")?.status, "active");
});

test("activating a plugin that is already running stops it first", async () => {
  const { host } = makeHost();
  let live = 0;
  host.register({
    id: "conn",
    name: "Connections",
    version: "1.0.0",
    activate() {
      live += 1;
    },
    deactivate() {
      live -= 1;
    },
  });
  await host.activate("conn");
  await host.activate("conn");
  await host.restart("conn");
  assert.equal(live, 1);
});

test("a deleted conversation is announced to running plugins only, and a failure is not fatal", async () => {
  const { host } = makeHost();
  const told: string[] = [];
  const plugin = (id: string, fail = false): Plugin => ({
    id,
    name: id,
    version: "1.0.0",
    activate() {},
    sessionDeleted(sessionId) {
      told.push(`${id}:${sessionId}`);
      if (fail) throw new Error("boom");
    },
  });
  host.register(plugin("first", true));
  host.register(plugin("second"));
  host.register(plugin("off"));
  await host.activateAll();
  await host.setEnabled("off", false);

  await host.sessionDeleted("s1");
  assert.deepEqual(told, ["first:s1", "second:s1"]);
});
