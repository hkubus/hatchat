import type { DirEntry, Part, Plugin, Tool, ToolContext } from "@hat/core";
import { z } from "zod";

const MAX_LINE_CHARS = 2_000;
const DEFAULT_READ_LINES = 2_000;
const MAX_LIST_ENTRIES = 500;
const MAX_GLOB_RESULTS = 500;
/** Directories listed but never descended into; they drown out everything else. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next"]);

const text = (value: string): Part => ({ type: "text", text: value });

/** POSIX single-quote a value for a shell command line. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Prefix each line with its 1-based number, `cat -n` style. */
export function numberLines(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, index) => {
      const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
      return `${String(firstLine + index).padStart(width, " ")}\t${clipped}`;
    })
    .join("\n");
}

async function readText(ctx: ToolContext, path: string): Promise<string> {
  const data = await ctx.host.fs.read(ctx.sessionId, path);
  if (data.includes("\u0000")) {
    throw new Error(`${path} looks like a binary file; use shell_exec to inspect it`);
  }
  return data;
}

// ---- read_file --------------------------------------------------------------

const readSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line to start from (default 1)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe(`Maximum lines to return (default ${DEFAULT_READ_LINES}).`),
});

export function createReadFileTool(): Tool {
  return {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns numbered lines (cat -n style); page through " +
      "large files with offset/limit. Prefer this over shell_exec for reading files.",
    schema: readSchema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = readSchema.parse(raw);
      const data = await readText(ctx, args.path);
      if (data.length === 0) return [text(`${args.path} is empty.`)];
      const lines = data.replace(/\n$/, "").split("\n");
      const start = (args.offset ?? 1) - 1;
      if (start >= lines.length) {
        return [text(`${args.path} has ${lines.length} lines; offset ${args.offset} is past the end.`)];
      }
      const slice = lines.slice(start, start + (args.limit ?? DEFAULT_READ_LINES));
      const end = start + slice.length;
      const parts = [text(numberLines(slice, start + 1))];
      if (end < lines.length) {
        parts.push(text(`\n[lines ${start + 1}-${end} of ${lines.length}; continue with offset=${end + 1}]`));
      }
      return parts;
    },
  };
}

// ---- write_file -------------------------------------------------------------

const writeSchema = z.object({
  path: z.string().describe("File path relative to the workspace root. Parent directories are created."),
  content: z.string().describe("The complete new file contents."),
});

export function createWriteFileTool(requireApproval: boolean): Tool {
  return {
    name: "write_file",
    description:
      "Create or overwrite a text file in the workspace with the given contents. For changes to " +
      "an existing file prefer edit_file, which only sends the changed region.",
    schema: writeSchema,
    requiresApproval: requireApproval,
    async execute(raw, ctx): Promise<Part[]> {
      const args = writeSchema.parse(raw);
      await ctx.host.fs.write(ctx.sessionId, args.path, args.content);
      const lines = args.content.length === 0 ? 0 : args.content.replace(/\n$/, "").split("\n").length;
      return [text(`Wrote ${args.path} (${lines} lines, ${Buffer.byteLength(args.content)} bytes).`)];
    },
  };
}

// ---- edit_file --------------------------------------------------------------

const editSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  old_string: z
    .string()
    .min(1)
    .describe("Exact text to replace, including indentation. Must match exactly once unless replace_all."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

/** Apply an exact-string edit, or throw a message that tells the model how to fix its call. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { content: string; count: number; firstIndex: number } {
  if (oldString === newString) throw new Error("old_string and new_string are identical");
  const count = countOccurrences(content, oldString);
  if (count === 0) {
    throw new Error(
      "old_string was not found. Re-read the file and copy the text exactly, including whitespace.",
    );
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string matches ${count} places. Include more surrounding lines to make it unique, or set replace_all.`,
    );
  }
  const firstIndex = content.indexOf(oldString);
  const next = replaceAll
    ? content.split(oldString).join(newString)
    : content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
  return { content: next, count, firstIndex };
}

export function createEditFileTool(requireApproval: boolean): Tool {
  return {
    name: "edit_file",
    description:
      "Edit a workspace file by replacing an exact string. old_string must match the file exactly " +
      "(read the file first) and be unique unless replace_all is set. Returns the edited region.",
    schema: editSchema,
    requiresApproval: requireApproval,
    async execute(raw, ctx): Promise<Part[]> {
      const args = editSchema.parse(raw);
      const before = await readText(ctx, args.path);
      const result = applyEdit(before, args.old_string, args.new_string, args.replace_all);
      await ctx.host.fs.write(ctx.sessionId, args.path, result.content);

      // Show a few lines around the first edit so the model can verify it.
      const lines = result.content.split("\n");
      const firstLine = before.slice(0, result.firstIndex).split("\n").length;
      const editedLines = args.new_string.split("\n").length;
      const from = Math.max(1, firstLine - 3);
      const to = Math.min(lines.length, firstLine + editedLines + 2);
      return [
        text(
          `Edited ${args.path} (${result.count} replacement${result.count === 1 ? "" : "s"}):\n` +
            numberLines(lines.slice(from - 1, to), from),
        ),
      ];
    },
  };
}

// ---- list_dir ---------------------------------------------------------------

const listSchema = z.object({
  path: z.string().optional().describe("Directory relative to the workspace root (default: the root)."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("How many levels to descend (default 2)."),
});

export function createListDirTool(): Tool {
  return {
    name: "list_dir",
    description:
      "List a workspace directory as an indented tree with file sizes. Dependency and VCS " +
      "directories (node_modules, .git, ...) are shown but not expanded.",
    schema: listSchema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = listSchema.parse(raw);
      const root = args.path?.trim() || ".";
      const maxDepth = args.depth ?? 2;
      const lines: string[] = [];
      let truncated = false;

      const walk = async (dir: string, depth: number): Promise<void> => {
        let entries: DirEntry[];
        try {
          entries = await ctx.host.fs.list(ctx.sessionId, dir);
        } catch (error) {
          if (depth === 0) throw error;
          return;
        }
        entries.sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
        );
        for (const entry of entries) {
          if (lines.length >= MAX_LIST_ENTRIES) {
            truncated = true;
            return;
          }
          const indent = "  ".repeat(depth);
          if (entry.type === "dir") {
            const skipped = SKIP_DIRS.has(entry.name);
            lines.push(`${indent}${entry.name}/${skipped ? " (not expanded)" : ""}`);
            if (!skipped && depth + 1 < maxDepth) await walk(entry.path, depth + 1);
          } else {
            lines.push(`${indent}${entry.name}${entry.size !== undefined ? `  (${formatSize(entry.size)})` : ""}`);
          }
        }
      };

      await walk(root, 0);
      if (lines.length === 0) return [text(`${root} is empty.`)];
      if (truncated) lines.push(`… [stopped at ${MAX_LIST_ENTRIES} entries; list a subdirectory]`);
      return [text(lines.join("\n"))];
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- grep / glob (run on the host with ripgrep, falling back to grep/find) ---

async function runCommand(ctx: ToolContext, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  for await (const event of ctx.host.exec({ command, timeoutMs: 60_000 }, ctx.signal)) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else if (event.type === "exit") code = event.code;
    else if (event.type === "error") throw new Error(event.error.message);
  }
  return { stdout, stderr, code };
}

const grepSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for (ripgrep / extended grep syntax)."),
  path: z.string().optional().describe("File or directory to search, relative to the workspace root (default: root)."),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
  ignore_case: z.boolean().optional(),
  context: z.number().int().min(0).max(10).optional().describe("Lines of context around each match."),
  max_results: z.number().int().positive().max(1_000).optional().describe("Maximum matching lines (default 200)."),
});

export function buildGrepCommand(args: z.infer<typeof grepSchema>): string {
  const path = shq(args.path?.trim() || ".");
  const context = args.context ? ` -C ${args.context}` : "";
  const rg =
    `rg -n --no-heading --color never --max-columns 400${context}` +
    `${args.ignore_case ? " -i" : ""}${args.glob ? ` -g ${shq(args.glob)}` : ""} -e ${shq(args.pattern)} ${path}`;
  const grep =
    `grep -rnE${args.ignore_case ? "i" : ""}${context} --exclude-dir=.git --exclude-dir=node_modules` +
    `${args.glob ? ` --include=${shq(args.glob)}` : ""} -e ${shq(args.pattern)} ${path}`;
  return `if command -v rg >/dev/null 2>&1; then ${rg}; else ${grep}; fi`;
}

export function createGrepTool(): Tool {
  return {
    name: "grep",
    description:
      "Search file contents in the workspace with a regular expression. Returns file:line:text " +
      "matches. Faster and more precise than shelling out to grep.",
    schema: grepSchema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = grepSchema.parse(raw);
      const { stdout, stderr, code } = await runCommand(ctx, buildGrepCommand(args));
      if (code === 1 && !stdout) return [text("No matches.")];
      if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `search failed (exit ${code})`);
      const max = args.max_results ?? 200;
      const lines = stdout.replace(/\n$/, "").split("\n").map((line) => line.replace(/^\.\//, ""));
      const shown = lines.slice(0, max);
      if (lines.length > max) shown.push(`… [${lines.length - max} more lines; narrow the pattern or path]`);
      return [text(shown.join("\n"))];
    },
  };
}

const globSchema = z.object({
  pattern: z.string().min(1).describe('Glob to match file paths, e.g. "**/*.ts" or "src/**/test_*.py".'),
  path: z.string().optional().describe("Directory to search from, relative to the workspace root (default: root)."),
});

export function buildGlobCommand(args: z.infer<typeof globSchema>): string {
  const path = shq(args.path?.trim() || ".");
  // find's -path wildcard already spans "/", so "**/" collapses to "*".
  const findPattern = `*/${args.pattern.replace(/\*\*\/?/g, "*").replace(/^\.?\//, "")}`;
  const rg = `rg --files --color never --hidden -g '!.git' -g ${shq(args.pattern)} ${path}`;
  const find = `find ${path} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -path ${shq(findPattern)}`;
  return `if command -v rg >/dev/null 2>&1; then ${rg}; else ${find}; fi`;
}

export function createGlobTool(): Tool {
  return {
    name: "glob",
    description:
      "Find workspace files whose paths match a glob pattern (respects .gitignore when ripgrep is " +
      "available). Returns matching paths, sorted.",
    schema: globSchema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = globSchema.parse(raw);
      const { stdout, stderr, code } = await runCommand(ctx, buildGlobCommand(args));
      if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `glob failed (exit ${code})`);
      const files = stdout
        .split("\n")
        .map((line) => line.trim().replace(/^\.\//, ""))
        .filter(Boolean)
        .sort();
      if (files.length === 0) return [text("No files matched.")];
      const shown = files.slice(0, MAX_GLOB_RESULTS);
      if (files.length > MAX_GLOB_RESULTS) {
        shown.push(`… [${files.length - MAX_GLOB_RESULTS} more; use a narrower pattern]`);
      }
      return [text(shown.join("\n"))];
    },
  };
}

// ---- plugin -----------------------------------------------------------------

export const fsConfigSchema = z.object({
  requireApproval: z
    .boolean()
    .optional()
    .describe("Ask before write_file / edit_file change a file (reads never ask)."),
});

export function createFsPlugin(): Plugin {
  return {
    id: "fs",
    name: "Files",
    version: "0.1.0",
    description:
      "Read, write, edit, list and search files in the conversation's workspace on the runner.",
    permissions: ["runner:fs", "runner:exec"],
    configSchema: fsConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<z.infer<typeof fsConfigSchema>>();
      const requireApproval = config.requireApproval ?? true;
      ctx.register.tool(createReadFileTool());
      ctx.register.tool(createWriteFileTool(requireApproval));
      ctx.register.tool(createEditFileTool(requireApproval));
      ctx.register.tool(createListDirTool());
      ctx.register.tool(createGrepTool());
      ctx.register.tool(createGlobTool());
    },
  };
}
