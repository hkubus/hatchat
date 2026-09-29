// Test fixture for plugin-isolation.test.ts: one tool per bridge feature.
import fs from "node:fs";
import { DEFAULT_CAPABILITIES, definePlugin, z } from "@hat/plugin-sdk";

const text = (value) => [{ type: "text", text: value }];

export default definePlugin({
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  permissions: ["runner:fs"],
  requiresSecrets: ["FIXTURE_TOKEN"],
  configSchema: z.object({ greeting: z.string().default("hello") }),
  activate(ctx) {
    const { greeting } = ctx.getConfig();

    ctx.register.tool({
      name: "fixture_echo",
      description: "Greet the given text.",
      schema: z.object({ text: z.string() }),
      async execute(args, tool) {
        return text(`${greeting} ${args.text} (${tool.sessionId})`);
      },
    });

    ctx.register.tool({
      name: "fixture_secret",
      description: "Read a secret by name.",
      schema: z.object({ name: z.string() }),
      async execute(args) {
        try {
          return text(`value:${await ctx.secrets.get(args.name)}`);
        } catch (error) {
          return text(`denied:${error.message}`);
        }
      },
    });

    ctx.register.tool({
      name: "fixture_probe",
      description: "Report what the process can see.",
      schema: z.object({ path: z.string() }),
      async execute(args) {
        let read = "readable";
        try {
          fs.readFileSync(args.path, "utf8");
        } catch (error) {
          read = error.code ?? error.message;
        }
        return text(JSON.stringify({ env: Object.keys(process.env), read, pid: process.pid }));
      },
    });

    ctx.register.tool({
      name: "fixture_fs",
      description: "Read a workspace file through the execution host.",
      schema: z.object({ path: z.string() }),
      async execute(args, tool) {
        return text(await tool.host.fs.read("someone-elses-session", args.path));
      },
    });

    ctx.register.tool({
      name: "fixture_exec",
      description: "Run a command through the execution host.",
      async execute(_args, tool) {
        for await (const event of tool.host.exec({ command: "true" }, tool.signal)) void event;
        return text("ran");
      },
    });

    ctx.register.tool({
      name: "fixture_wait",
      description: "Wait until the call is aborted.",
      execute(_args, tool) {
        return new Promise((resolve) => {
          tool.signal.addEventListener("abort", () => {
            ctx.logger.info("wait aborted");
            resolve(text("aborted"));
          });
        });
      },
    });

    ctx.register.tool({
      name: "fixture_crash",
      description: "Crash the plugin process.",
      execute() {
        setImmediate(() => {
          throw new Error("boom");
        });
        return new Promise(() => {});
      },
    });

    ctx.register.provider({
      id: "fixture",
      label: "Fixture",
      capabilities: () => DEFAULT_CAPABILITIES,
      async listModels() {
        return [
          {
            id: "fixture/smart",
            label: "Smart",
            provider: "fixture",
            capabilities: { ...DEFAULT_CAPABILITIES, toolCalls: true },
          },
        ];
      },
      async *chat(req) {
        yield { type: "text.delta", text: "model:" };
        yield { type: "text.delta", text: req.model };
        yield { type: "error", error: { code: "x", message: "soft", cause: new Error("dropped") } };
        yield { type: "done", finishReason: "stop" };
      },
    });

    ctx.logger.info("fixture activated");
  },
});
