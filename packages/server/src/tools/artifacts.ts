import type { Part, Plugin, ToolContext } from "@hat/core";
import type { Store } from "@hat/store-sqlite";
import { z } from "zod";

/** The runner caps exec output at ~1MB, so base64 transfers top out below that. */
const MAX_ARTIFACT_BYTES = 700_000;

const EXTENSION_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  sh: "text/x-shellscript",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || /json|xml|javascript|svg/.test(mime);
}

async function readWorkspaceFile(ctx: ToolContext, path: string, mime: string): Promise<Buffer> {
  if (isTextMime(mime)) return Buffer.from(await ctx.host.fs.read(ctx.sessionId, path), "utf8");
  // fs.read is utf8-only; move binaries through base64 instead.
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
  const command = `[ "$(wc -c < ${quoted})" -le ${MAX_ARTIFACT_BYTES} ] || { echo "file is larger than ${MAX_ARTIFACT_BYTES} bytes" >&2; exit 3; }; base64 < ${quoted} | tr -d '\\n'`;
  for await (const event of ctx.host.exec({ command, timeoutMs: 60_000 }, ctx.signal)) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else if (event.type === "exit") code = event.code;
    else if (event.type === "error") throw new Error(event.error.message);
  }
  if (code !== 0) throw new Error(stderr.trim() || `could not read ${path} (exit ${code})`);
  return Buffer.from(stdout, "base64");
}

const schema = z.object({
  name: z.string().min(1).max(200).describe('File name shown to the user, with extension, e.g. "report.md".'),
  content: z.string().optional().describe("File contents (text, or base64 when encoding is base64)."),
  encoding: z.enum(["utf8", "base64"]).optional().describe("How `content` is encoded (default utf8)."),
  path: z
    .string()
    .optional()
    .describe("Instead of content: a workspace file to publish (e.g. a chart or CSV you generated)."),
  mime: z.string().optional().describe("MIME type; inferred from the name when omitted."),
});

export function createArtifactsPlugin(store: Store): Plugin {
  return {
    id: "artifacts",
    name: "Artifacts",
    version: "0.1.0",
    description:
      "Let the assistant hand the user files (reports, CSVs, images, HTML pages) that render inline and download.",
    activate(ctx) {
      ctx.register.tool({
        name: "create_artifact",
        description:
          "Deliver a file to the user: it appears in the chat as a downloadable card (images and " +
          "HTML preview inline). Use it whenever the user asks for a file, report, export, chart " +
          "or page. Pass `content` directly, or `path` to publish a file from the workspace.",
        schema,
        requiresApproval: false,
        async execute(raw, toolCtx): Promise<Part[]> {
          const args = schema.parse(raw);
          if ((args.content === undefined) === (args.path === undefined)) {
            throw new Error("pass exactly one of content or path");
          }
          const name = args.name.split(/[\\/]/).pop()!.trim() || "artifact";
          const mime = args.mime?.trim() || mimeFor(name);
          const data =
            args.content !== undefined
              ? Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8")
              : await readWorkspaceFile(toolCtx, args.path!, mime);
          if (data.length === 0) throw new Error("the artifact is empty");
          if (data.length > 25 * 1024 * 1024) throw new Error("artifacts are limited to 25MB");
          const record = await store.putAttachment(data, mime);
          return [
            { type: "text", text: `Created artifact "${name}" (${mime}, ${data.length} bytes). The user can see and download it.` },
            { type: "file", id: record.id, name, mime, size: data.length },
          ];
        },
      });
    },
  };
}
