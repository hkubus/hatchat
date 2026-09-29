import type { ChatMessage, Part } from "@hat/core";
import type { SessionExport, SessionRecord } from "@hat/store-sqlite";

/** An export as served by `GET /export`: the tree plus attachment bytes inline. */
export type SessionExportFile = SessionExport & {
  attachments?: Record<string, { mime: string; name?: string; text?: string; data: string }>;
};

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const PART_TYPES = new Set(["text", "image", "file", "reasoning", "tool_call", "tool_result"]);

/** Enough of a part's shape that every client can render it without crashing. */
function isPart(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (!PART_TYPES.has(part.type as string)) return false;
  switch (part.type) {
    case "text":
    case "reasoning":
      return typeof part.text === "string";
    case "image":
      return Boolean(part.source) && typeof part.source === "object";
    case "file":
      return typeof part.id === "string" && typeof part.name === "string" && typeof part.mime === "string";
    case "tool_call":
      return typeof part.id === "string" && typeof part.name === "string";
    case "tool_result":
      return typeof part.id === "string" && Array.isArray(part.content) && part.content.every(isPart);
  }
  return false;
}

/** Shape-check an uploaded export before trusting any of it. */
export function isSessionExport(value: unknown): value is SessionExportFile {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (data.format !== "hat.session" || data.version !== 1) return false;
  const session = data.session as Record<string, unknown> | undefined;
  if (!session || typeof session !== "object" || typeof session.model !== "string") return false;
  if (!Array.isArray(data.messages)) return false;
  for (const message of data.messages as Array<Record<string, unknown>>) {
    if (!message || typeof message !== "object") return false;
    if (typeof message.id !== "string" || !ROLES.has(message.role as string)) return false;
    if (message.parentId !== null && typeof message.parentId !== "string") return false;
    if (!Array.isArray(message.parts) || !message.parts.every(isPart)) return false;
    if (typeof message.createdAt !== "number") return false;
  }
  if (data.attachments !== undefined) {
    if (!data.attachments || typeof data.attachments !== "object") return false;
    for (const attachment of Object.values(data.attachments as Record<string, Record<string, unknown>>)) {
      if (typeof attachment?.mime !== "string" || typeof attachment.data !== "string") return false;
    }
  }
  return true;
}

function textParts(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

/** The active branch as a readable Markdown transcript. */
export function exportMarkdown(session: SessionRecord, path: ChatMessage[]): string {
  const lines: string[] = [`# ${session.title}`, ""];
  lines.push(`*Exported from hat on ${new Date().toISOString().slice(0, 10)} · model \`${session.model}\`*`, "");
  if (session.instructions) lines.push("> **Instructions:** " + session.instructions.replace(/\n/g, "\n> "), "");
  for (const message of path) {
    if (message.meta?.synthetic) continue;
    if (message.role === "user") {
      lines.push("## You", "");
      const text = textParts(message.parts);
      if (text) lines.push(text, "");
      for (const part of message.parts) {
        if (part.type === "image") lines.push("*[image attached]*", "");
        if (part.type === "file") lines.push(`*[attached ${part.name}]*`, "");
      }
    } else if (message.role === "assistant") {
      const text = textParts(message.parts);
      const calls = message.parts.filter((p) => p.type === "tool_call");
      if (!text && calls.length === 0) continue;
      lines.push("## Assistant", "");
      for (const call of calls) {
        if (call.type !== "tool_call") continue;
        lines.push(`*Called \`${call.name}\`*`, "", fence(JSON.stringify(call.args, null, 2)), "");
      }
      if (text) lines.push(text, "");
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue;
        const output = textParts(part.content).trim();
        if (!output) continue;
        const clipped = output.length > 4_000 ? `${output.slice(0, 4_000)}\n…` : output;
        lines.push(`<details><summary>${part.name} output${part.isError ? " (error)" : ""}</summary>`, "", fence(clipped), "", "</details>", "");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
