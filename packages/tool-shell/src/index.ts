import type { Part, Plugin, Tool } from "@hat/core";
import { z } from "zod";

const schema = z.object({
  command: z.string().describe("Shell command to run on the execution host."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory relative to the session workspace root."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Kill the command after this many milliseconds (max 10 minutes)."),
});

export interface ShellToolOptions {
  requireApproval?: boolean;
}

export function createShellTool(options: ShellToolOptions = {}): Tool {
  return {
    name: "shell_exec",
    description:
      "Run a shell command on the execution host, inside the conversation's isolated workspace. " +
      "Returns stdout, stderr and the exit code. Use for git, build tools, tests and scripts.",
    schema,
    requiresApproval: options.requireApproval ?? true,
    async execute(raw, ctx): Promise<Part[]> {
      const args = schema.parse(raw);
      let stdout = "";
      let stderr = "";
      let summary = "[process ended without an exit event]";

      for await (const event of ctx.host.exec(
        { command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs },
        ctx.signal,
      )) {
        switch (event.type) {
          case "stdout":
            stdout += event.data;
            break;
          case "stderr":
            stderr += event.data;
            break;
          case "exit":
            summary = `[exit ${
              event.code ?? `signal ${event.signal ?? "unknown"}`
            } in ${event.durationMs}ms]`;
            break;
          case "error":
            stderr += `\n[exec error: ${event.error.message}]`;
            break;
        }
      }

      const parts: Part[] = [];
      if (stdout) parts.push({ type: "text", text: stdout });
      if (stderr) parts.push({ type: "text", text: `[stderr]\n${stderr}` });
      if (!stdout && !stderr) parts.push({ type: "text", text: "(no output)" });
      parts.push({ type: "text", text: summary });
      return parts;
    },
  };
}

export const shellConfigSchema = z.object({
  requireApproval: z
    .boolean()
    .optional()
    .describe("Ask the user to approve each command (recommended while the server is exposed)."),
});

export function createShellPlugin(): Plugin {
  return {
    id: "shell",
    name: "Shell execution",
    version: "0.1.0",
    description:
      "Run shell commands on the connected runner, inside a per-conversation workspace.",
    permissions: ["runner:exec"],
    configSchema: shellConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<{ requireApproval?: boolean }>();
      ctx.register.tool(createShellTool({ requireApproval: config.requireApproval ?? true }));
    },
  };
}
