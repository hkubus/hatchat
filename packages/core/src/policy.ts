import type { Tool } from "./tool.js";
import { toolNeedsApproval } from "./tool.js";

export type ApprovalMode = "ask" | "auto" | "allowlist" | "deny";

export interface ToolPolicy {
  mode: ApprovalMode;
  /** Tool names auto-approved in `allowlist` mode. */
  allowlist: string[];
  maxIterations: number;
  /** Stop after this many identical (name+args) tool calls in one turn. */
  maxDuplicateCalls: number;
  /** Stop after this many consecutive tool rounds in which every call failed. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  mode: "ask",
  allowlist: [],
  maxIterations: 5,
  maxDuplicateCalls: 3,
  maxConsecutiveFailures: 3,
};

export type ToolDecision = "approve" | "ask" | "deny";

/** Decide whether a tool call runs, needs the user, or is blocked. */
export function decideTool(tool: Tool, args: unknown, policy: ToolPolicy): ToolDecision {
  if (policy.mode === "deny") return "deny";
  if (policy.mode === "auto") return "approve";
  if (policy.mode === "allowlist") {
    return policy.allowlist.includes(tool.name) ? "approve" : "ask";
  }
  return toolNeedsApproval(tool, args) ? "ask" : "approve";
}
