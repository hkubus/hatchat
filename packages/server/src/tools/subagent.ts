import type { KernelEvent, Part, Plugin, ReasoningEffort, ToolPolicy } from "@hat/core";
import type { Agent } from "@hat/kernel";
import { z } from "zod";

/** Tools a sub-agent never gets: no recursion, and no UI-only affordances. */
export const SUBAGENT_EXCLUDED_TOOLS = ["spawn_subagent", "todo_write", "ask_user", "schedule_create"];

export interface SubagentDeps {
  /** Resolved lazily: the agent is built after plugins are registered. */
  agent(): Agent;
  /** The session's model and tool policy, resolved per call. */
  sessionSettings(sessionId: string): {
    model: string;
    toolPolicy?: ToolPolicy;
    reasoningEffort?: ReasoningEffort;
  };
}

const schema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      "Complete instructions for the sub-agent. It sees nothing of this conversation, so include " +
        "all context, constraints and what to report back.",
    ),
  model: z.string().optional().describe("Model id to run it on (defaults to this conversation's model)."),
});

export function createSubagentPlugin(deps: SubagentDeps): Plugin {
  return {
    id: "subagents",
    name: "Sub-agents",
    version: "0.1.0",
    description:
      "Delegate a self-contained task to a fresh agent with its own context; only its final report comes back.",
    activate(ctx) {
      ctx.register.tool({
        name: "spawn_subagent",
        description:
          "Delegate a self-contained task (broad research, reading many files, a side investigation) " +
          "to a sub-agent with a fresh context and the same tools. Only its final answer returns, " +
          "which keeps this conversation's context small. Several calls in one reply run one after another.",
        schema,
        requiresApproval: false,
        async execute(raw, toolCtx): Promise<Part[]> {
          const args = schema.parse(raw);
          const settings = deps.sessionSettings(toolCtx.sessionId);
          // Child tool calls surface in the parent message so approvals and
          // progress stay visible; everything else about the run is private.
          const forward = (event: KernelEvent): void => {
            if (!toolCtx.emit) return;
            if (event.type === "tool.call") {
              toolCtx.emit({ ...event, messageId: toolCtx.messageId ?? event.messageId });
            } else if (event.type === "tool.result") {
              toolCtx.emit(event);
            }
          };

          let finalText = "";
          let lastText = "";
          const errors: string[] = [];
          let toolCalls = 0;
          for await (const event of deps.agent().run({
            sessionId: toolCtx.sessionId,
            history: [],
            userText: args.task,
            model: args.model?.trim() || settings.model,
            toolPolicy: settings.toolPolicy,
            reasoningEffort: settings.reasoningEffort,
            signal: toolCtx.signal,
            excludeTools: SUBAGENT_EXCLUDED_TOOLS,
            persist: false,
            emit: toolCtx.emit,
          })) {
            forward(event);
            if (event.type === "message.start") lastText = "";
            else if (event.type === "text.delta") lastText += event.text;
            else if (event.type === "message.done" && lastText.trim()) finalText = lastText;
            else if (event.type === "tool.call") toolCalls++;
            else if (event.type === "error") errors.push(event.error.message);
          }

          if (!finalText.trim()) {
            throw new Error(`the sub-agent produced no answer${errors.length ? `: ${errors.join("; ")}` : ""}`);
          }
          return [
            {
              type: "text",
              text: `${finalText.trim()}\n\n[sub-agent used ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}]`,
            },
          ];
        },
      });
    },
  };
}
