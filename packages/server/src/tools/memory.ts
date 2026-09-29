import type { Part, Plugin } from "@hat/core";
import type { Store } from "@hat/store-sqlite";
import { z } from "zod";

const MAX_MEMORY_CHARS = 500;
const MAX_MEMORIES_IN_PROMPT = 100;

const text = (value: string): Part => ({ type: "text", text: value });

/**
 * The saved memories as a system-prompt section, or undefined when there are
 * none. Deterministic ordering keeps the prompt prefix cacheable between
 * turns; it only changes when a memory does.
 */
export function memoryPrompt(store: Store): string | undefined {
  const memories = store.listMemories().slice(-MAX_MEMORIES_IN_PROMPT);
  if (memories.length === 0) return undefined;
  return (
    "Saved memories about the user (from earlier conversations; ids in brackets for memory_update / memory_delete):\n" +
    memories.map((memory) => `- [${memory.id}] ${memory.text}`).join("\n")
  );
}

const saveSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_MEMORY_CHARS)
    .describe("One self-contained fact, written so it makes sense out of context."),
});
const updateSchema = z.object({
  id: z.string().describe("Memory id, as shown in the system prompt."),
  text: z.string().min(1).max(MAX_MEMORY_CHARS),
});
const deleteSchema = z.object({ id: z.string().describe("Memory id to forget.") });
const searchSchema = z.object({
  query: z.string().min(1).describe("Words to look for in past conversations."),
  limit: z.number().int().positive().max(30).optional().describe("Maximum hits (default 10)."),
});

export function createMemoryPlugin(store: Store): Plugin {
  return {
    id: "memory",
    name: "Memory",
    version: "0.1.0",
    description:
      "Remember durable facts about the user across conversations, and search past chats.",
    activate(ctx) {
      ctx.register.tool({
        name: "memory_save",
        description:
          "Remember a durable fact about the user for future conversations (preferences, " +
          "background, ongoing projects, people). Save when the user shares something that will " +
          "matter later or asks you to remember it; not for one-off task details. Saved memories " +
          "appear in your system prompt in every conversation.",
        schema: saveSchema,
        requiresApproval: false,
        async execute(raw): Promise<Part[]> {
          const args = saveSchema.parse(raw);
          const duplicate = store.listMemories().find((m) => m.text.trim() === args.text.trim());
          if (duplicate) return [text(`Already remembered as ${duplicate.id}.`)];
          const memory = store.addMemory(args.text.trim());
          return [text(`Saved memory ${memory.id}.`)];
        },
      });
      ctx.register.tool({
        name: "memory_update",
        description: "Correct or refine a saved memory when a fact about the user changes.",
        schema: updateSchema,
        requiresApproval: false,
        async execute(raw): Promise<Part[]> {
          const args = updateSchema.parse(raw);
          if (!store.updateMemory(args.id, args.text.trim())) throw new Error(`no memory with id ${args.id}`);
          return [text(`Updated memory ${args.id}.`)];
        },
      });
      ctx.register.tool({
        name: "memory_delete",
        description: "Forget a saved memory (when it's wrong, stale, or the user asks you to forget it).",
        schema: deleteSchema,
        requiresApproval: false,
        async execute(raw): Promise<Part[]> {
          const args = deleteSchema.parse(raw);
          if (!store.deleteMemory(args.id)) throw new Error(`no memory with id ${args.id}`);
          return [text(`Deleted memory ${args.id}.`)];
        },
      });
      ctx.register.tool({
        name: "search_chats",
        description:
          "Full-text search across the user's other conversations. Use it when the user refers " +
          "to something discussed before (\"like we did last week\", \"that recipe you gave me\").",
        schema: searchSchema,
        requiresApproval: false,
        async execute(raw, toolCtx): Promise<Part[]> {
          const args = searchSchema.parse(raw);
          const hits = store.searchMessages(args.query, {
            limit: args.limit ?? 10,
            excludeSessionId: toolCtx.sessionId,
          });
          if (hits.length === 0) return [text("No matching messages in other conversations.")];
          return [
            text(
              hits
                .map(
                  (hit) =>
                    `• "${hit.sessionTitle}" (${new Date(hit.createdAt).toISOString().slice(0, 10)}, ${hit.role}):\n  ${hit.snippet.replace(/\s+/g, " ")}`,
                )
                .join("\n"),
            ),
          ];
        },
      });
    },
  };
}
