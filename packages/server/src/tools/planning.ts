import type { Part, Plugin } from "@hat/core";
import { z } from "zod";

const text = (value: string): Part => ({ type: "text", text: value });

/**
 * Blocks an `ask_user` call until the client answers. The question itself
 * travels to the client as the tool call's arguments, so a client that
 * reconnects mid-question can re-render it from the conversation alone.
 */
export class QuestionManager {
  private readonly pending = new Map<string, { sessionId: string; answer: (value: string) => void }>();

  /** @param timeoutMs 0 waits until answered or cancelled, like tool approvals. */
  constructor(private readonly timeoutMs = 30 * 60_000) {}

  /** Whether a conversation is blocked on the user answering a question. */
  isWaiting(sessionId: string): boolean {
    for (const entry of this.pending.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  ask(sessionId: string, callId: string, signal: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const finish = (value: string | undefined): void => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(callId);
        resolve(value);
      };
      const onAbort = (): void => {
        if (timer) clearTimeout(timer);
        this.pending.delete(callId);
        reject(new Error("question cancelled"));
      };
      const timer = this.timeoutMs > 0 ? setTimeout(() => finish(undefined), this.timeoutMs) : undefined;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(callId, { sessionId, answer: finish });
    });
  }

  answer(callId: string, sessionId: string, value: string): boolean {
    const entry = this.pending.get(callId);
    if (!entry || entry.sessionId !== sessionId) return false;
    entry.answer(value);
    return true;
  }
}

const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("What needs doing, as a short imperative."),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .max(30)
    .describe("The complete, updated list. Replaces the previous one."),
});

const askSchema = z.object({
  question: z.string().min(1).describe("The question, phrased so it stands alone."),
  options: z
    .array(z.string().min(1).max(120))
    .min(2)
    .max(6)
    .optional()
    .describe("Choices shown as buttons. The user can always type a different answer."),
  multi_select: z.boolean().optional().describe("Allow picking several options."),
});

export function createPlanningPlugin(questions: QuestionManager): Plugin {
  return {
    id: "planning",
    name: "Planning",
    version: "0.1.0",
    description:
      "A live task checklist for multi-step work, and multiple-choice questions to the user.",
    activate(ctx) {
      ctx.register.tool({
        name: "todo_write",
        description:
          "Maintain a visible checklist for multi-step tasks (3+ steps). Send the whole list each " +
          "time: mark one item in_progress before starting it and completed as soon as it's done. " +
          "Skip it for simple one-step requests.",
        schema: todoSchema,
        requiresApproval: false,
        async execute(raw): Promise<Part[]> {
          const args = todoSchema.parse(raw);
          const done = args.todos.filter((t) => t.status === "completed").length;
          const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
          return [
            text(
              `Checklist updated (${done}/${args.todos.length} done):\n` +
                args.todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n"),
            ),
          ];
        },
      });
      ctx.register.tool({
        name: "ask_user",
        description:
          "Ask the user a question and wait for the answer, optionally with multiple-choice " +
          "options rendered as buttons. Use it when you are blocked on a decision that is " +
          "genuinely theirs (preferences, which of several valid approaches), not for things you " +
          "can find out yourself.",
        schema: askSchema,
        requiresApproval: false,
        async execute(raw, toolCtx): Promise<Part[]> {
          askSchema.parse(raw);
          if (!toolCtx.callId) throw new Error("ask_user needs a call id");
          const answer = await questions.ask(toolCtx.sessionId, toolCtx.callId, toolCtx.signal);
          if (answer === undefined) return [text("The user did not answer in time. Continue with your best judgment and state your assumption.")];
          return [text(`User answered: ${answer}`)];
        },
      });
    },
  };
}
