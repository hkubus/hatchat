import type { ZodTypeAny } from "zod";
import type { ToolContext } from "./context.js";
import type { Part } from "./messages.js";

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** Zod schema for arguments (converted to JSON Schema for providers). */
  readonly schema?: ZodTypeAny;
  /** Raw JSON Schema for arguments, for tools that don't use zod (e.g. MCP). */
  readonly parameters?: unknown;
  requiresApproval?: boolean | ((args: unknown) => boolean);
  execute(args: unknown, ctx: ToolContext): Promise<Part[]>;
}

export function toolNeedsApproval(tool: Tool, args: unknown): boolean {
  if (typeof tool.requiresApproval === "function") {
    return tool.requiresApproval(args);
  }
  return tool.requiresApproval ?? false;
}
