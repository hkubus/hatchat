import type { Plugin, ProcessHost } from "@hat/core";
import { z } from "zod";
import { ProcessManager, createProcessTools } from "./processes.js";
import { PythonKernels, createPythonTool } from "./python.js";

export { ProcessManager, createProcessTools } from "./processes.js";
export { PYTHON_DRIVER, PythonKernels, createPythonTool } from "./python.js";

export const processConfigSchema = z.object({
  requireApproval: z
    .boolean()
    .optional()
    .describe("Ask before starting a background process (reading output and stopping never ask)."),
});

export function createProcessPlugin(): Plugin {
  let manager: ProcessManager | undefined;
  return {
    id: "processes",
    name: "Background processes",
    version: "0.1.0",
    description:
      "Start long-running commands (dev servers, watchers) in the workspace and poll their output.",
    permissions: ["runner:exec"],
    configSchema: processConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<z.infer<typeof processConfigSchema>>();
      manager = new ProcessManager(() => ctx.processHost);
      for (const tool of createProcessTools(manager, config.requireApproval ?? true)) {
        ctx.register.tool(tool);
      }
    },
    deactivate() {
      manager?.killAll();
      manager = undefined;
    },
    sessionDeleted(sessionId) {
      manager?.killSession(sessionId);
    },
  };
}

export const pythonConfigSchema = z.object({
  requireApproval: z.boolean().optional().describe("Ask before running each Python cell."),
  pythonPath: z.string().optional().describe('Interpreter to launch on the runner (default "python3").'),
});

export function createPythonPlugin(): Plugin {
  let kernels: PythonKernels | undefined;
  return {
    id: "python",
    name: "Python interpreter",
    version: "0.1.0",
    description:
      "A stateful Python interpreter per conversation for analysis and charts; matplotlib figures render inline.",
    permissions: ["runner:exec"],
    configSchema: pythonConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<z.infer<typeof pythonConfigSchema>>();
      const host = (): ProcessHost | undefined => ctx.processHost;
      kernels = new PythonKernels(host, config.pythonPath?.trim() || "python3");
      ctx.register.tool(createPythonTool(kernels, config.requireApproval ?? true));
    },
    deactivate() {
      kernels?.killAll();
      kernels = undefined;
    },
    sessionDeleted(sessionId) {
      kernels?.reset(sessionId);
    },
  };
}
