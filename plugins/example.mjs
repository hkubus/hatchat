// Example external plugin. Files in HAT_PLUGINS_DIR (default ./plugins) that
// default-export a Plugin are loaded on startup. Plugins run in-process and are
// trusted: they can register providers and tools.
import { definePlugin, z } from "@hat/plugin-sdk";

export default definePlugin({
  id: "example-echo",
  name: "Example echo tool",
  version: "0.1.0",
  description: "Adds an example_echo tool to demonstrate external plugin loading.",
  permissions: [],
  activate(ctx) {
    ctx.register.tool({
      name: "example_echo",
      description: "Echo the provided text back to the model.",
      schema: z.object({
        text: z.string().describe("Text to echo back"),
      }),
      async execute(args) {
        return [{ type: "text", text: `echo: ${args.text}` }];
      },
    });
    ctx.logger.info("example_echo tool registered");
  },
});
