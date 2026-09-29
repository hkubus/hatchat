import type { Part, ProcessHost, SpawnedProcess, Tool } from "@hat/core";
import { newId } from "@hat/core";
import { z } from "zod";

/** Output kept per process; older output is dropped from the front. */
const MAX_BUFFER_CHARS = 256_000;
const MAX_RUNNING_PER_SESSION = 8;
const MAX_WAIT_MS = 60_000;
const MAX_READ_CHARS = 16_000;

interface ManagedProcess {
  id: string;
  sessionId: string;
  name: string;
  command: string;
  startedAt: number;
  proc: SpawnedProcess;
  /** Retained output (stdout and stderr interleaved as they arrived). */
  buffer: string;
  /** Absolute offset of `buffer[0]` in the full output stream. */
  dropped: number;
  status: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
  error?: string;
  /** Woken whenever output arrives or the process exits. */
  waiters: Set<() => void>;
}

const text = (value: string): Part => ({ type: "text", text: value });

/**
 * Long-running processes (dev servers, watchers, builds) that outlive a
 * single tool call. Each is scoped to the session that started it; the model
 * polls output with a cursor so repeated reads only return what is new.
 */
export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly host: () => ProcessHost | undefined) {}

  async start(sessionId: string, command: string, name?: string, cwd?: string): Promise<ManagedProcess> {
    const host = this.host();
    if (!host) throw new Error("No runner connected; cannot start a process.");
    const running = this.list(sessionId).filter((p) => p.status === "running");
    if (running.length >= MAX_RUNNING_PER_SESSION) {
      throw new Error(
        `${running.length} processes are already running in this conversation; stop one with process_kill first.`,
      );
    }
    const proc = await host.spawn({ command, cwd, sessionId, shell: true });
    const managed: ManagedProcess = {
      id: `bg_${newId().slice(0, 8)}`,
      sessionId,
      name: name?.trim() || command.slice(0, 60),
      command,
      startedAt: Date.now(),
      proc,
      buffer: "",
      dropped: 0,
      status: "running",
      exitCode: null,
      signal: null,
      waiters: new Set(),
    };
    this.processes.set(managed.id, managed);
    // Nothing reads stdin for a background process; close it so tools that
    // wait on EOF (or prompt) don't hang forever.
    proc.endStdin();
    void this.pump(managed);
    return managed;
  }

  private async pump(managed: ManagedProcess): Promise<void> {
    const append = (chunk: string): void => {
      managed.buffer += chunk;
      if (managed.buffer.length > MAX_BUFFER_CHARS) {
        const cut = managed.buffer.length - MAX_BUFFER_CHARS;
        managed.buffer = managed.buffer.slice(cut);
        managed.dropped += cut;
      }
      this.wake(managed);
    };
    try {
      for await (const event of managed.proc.events) {
        if (event.type === "stdout" || event.type === "stderr") append(event.data);
        else if (event.type === "exit") {
          managed.exitCode = event.code;
          managed.signal = event.signal;
        } else if (event.type === "error") managed.error = event.error.message;
      }
    } catch (error) {
      managed.error = error instanceof Error ? error.message : String(error);
    }
    managed.status = "exited";
    this.wake(managed);
  }

  private wake(managed: ManagedProcess): void {
    for (const waiter of managed.waiters) waiter();
  }

  get(sessionId: string, id: string): ManagedProcess {
    const managed = this.processes.get(id);
    if (!managed || managed.sessionId !== sessionId) throw new Error(`No process with id "${id}".`);
    return managed;
  }

  list(sessionId: string): ManagedProcess[] {
    return [...this.processes.values()].filter((p) => p.sessionId === sessionId);
  }

  /**
   * Wait until output past `cursor` matches `pattern` (or any new output, when
   * no pattern), the process exits, or the timeout passes.
   */
  async wait(managed: ManagedProcess, cursor: number, waitMs: number, pattern: RegExp | undefined, signal: AbortSignal): Promise<void> {
    const satisfied = (): boolean => {
      if (managed.status === "exited") return true;
      const fresh = this.readFrom(managed, cursor).output;
      return pattern ? pattern.test(fresh) : fresh.length > 0;
    };
    if (waitMs <= 0 || satisfied()) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        managed.waiters.delete(check);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const check = (): void => {
        if (satisfied()) done();
      };
      const timer = setTimeout(done, waitMs);
      managed.waiters.add(check);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  readFrom(managed: ManagedProcess, cursor: number): { output: string; skipped: number; next: number } {
    const start = Math.max(cursor, managed.dropped);
    const output = managed.buffer.slice(start - managed.dropped);
    return { output, skipped: start - cursor, next: managed.dropped + managed.buffer.length };
  }

  kill(managed: ManagedProcess): void {
    if (managed.status === "running") managed.proc.kill();
  }

  killAll(): void {
    for (const managed of this.processes.values()) this.kill(managed);
    this.processes.clear();
  }

  killSession(sessionId: string): void {
    for (const managed of this.list(sessionId)) {
      this.kill(managed);
      this.processes.delete(managed.id);
    }
  }
}

function describe(managed: ManagedProcess): string {
  const state =
    managed.status === "running"
      ? `running for ${Math.round((Date.now() - managed.startedAt) / 1000)}s`
      : managed.error
        ? `failed: ${managed.error}`
        : `exited with ${managed.exitCode ?? `signal ${managed.signal ?? "unknown"}`}`;
  return `${managed.id}  ${managed.name}  [${state}]`;
}

const startSchema = z.object({
  command: z.string().min(1).describe("Shell command to run in the background, e.g. \"npm run dev\"."),
  name: z.string().optional().describe("Short label for the process."),
  cwd: z.string().optional().describe("Working directory relative to the workspace root."),
  wait_for: z
    .string()
    .optional()
    .describe('Regex to wait for in the output before returning, e.g. "listening on|ready".'),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_MS)
    .optional()
    .describe("How long to wait for initial output / wait_for (default 3000)."),
});

const outputSchema = z.object({
  id: z.string().describe("Process id from process_start."),
  cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Return output after this cursor (from the previous call); omit to read from the start."),
  wait_for: z.string().optional().describe("Regex to wait for in new output before returning."),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_MS)
    .optional()
    .describe("Wait up to this long for new output (default 0: return immediately)."),
});

const killSchema = z.object({ id: z.string().describe("Process id to stop.") });

function compilePattern(source: string | undefined): RegExp | undefined {
  if (!source) return undefined;
  try {
    return new RegExp(source, "i");
  } catch (error) {
    throw new Error(`invalid wait_for regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatOutput(manager: ProcessManager, managed: ManagedProcess, cursor: number): Part[] {
  const { output, skipped, next } = manager.readFrom(managed, cursor);
  // Show the newest output when there is more than one result's worth.
  const clipped = output.length > MAX_READ_CHARS ? output.slice(-MAX_READ_CHARS) : output;
  const omitted = skipped + (output.length - clipped.length);
  const lines = [describe(managed)];
  if (omitted > 0) lines.push(`[${omitted} earlier chars not shown]`);
  lines.push(clipped || "(no new output)");
  lines.push(`[cursor=${next}; pass it to process_output to read only newer output]`);
  return [text(lines.join("\n"))];
}

export function createProcessTools(manager: ProcessManager, requireApproval: boolean): Tool[] {
  return [
    {
      name: "process_start",
      description:
        "Start a long-running shell command in the background (dev server, watcher, long build) in " +
        "the conversation's workspace. Returns its id and initial output; poll later with " +
        "process_output and stop it with process_kill. For commands that finish quickly use shell_exec.",
      schema: startSchema,
      requiresApproval: requireApproval,
      async execute(raw, ctx): Promise<Part[]> {
        const args = startSchema.parse(raw);
        const pattern = compilePattern(args.wait_for);
        const managed = await manager.start(ctx.sessionId, args.command, args.name, args.cwd);
        await manager.wait(managed, 0, args.wait_ms ?? 3_000, pattern, ctx.signal);
        const [output] = formatOutput(manager, managed, 0);
        return [text(`Started process ${managed.id}.\n${output.type === "text" ? output.text : ""}`)];
      },
    },
    {
      name: "process_output",
      description:
        "Read output from a background process started with process_start. Pass the cursor from " +
        "the previous read to get only new output; optionally wait for new output or a regex.",
      schema: outputSchema,
      requiresApproval: false,
      async execute(raw, ctx): Promise<Part[]> {
        const args = outputSchema.parse(raw);
        const managed = manager.get(ctx.sessionId, args.id);
        const cursor = args.cursor ?? 0;
        await manager.wait(managed, cursor, args.wait_ms ?? 0, compilePattern(args.wait_for), ctx.signal);
        return formatOutput(manager, managed, cursor);
      },
    },
    {
      name: "process_list",
      description: "List background processes in this conversation with their status.",
      schema: z.object({}),
      requiresApproval: false,
      async execute(_raw, ctx): Promise<Part[]> {
        const list = manager.list(ctx.sessionId);
        return [text(list.length ? list.map(describe).join("\n") : "No background processes.")];
      },
    },
    {
      name: "process_kill",
      description: "Stop a background process started with process_start.",
      schema: killSchema,
      requiresApproval: false,
      async execute(raw, ctx): Promise<Part[]> {
        const args = killSchema.parse(raw);
        const managed = manager.get(ctx.sessionId, args.id);
        if (managed.status !== "running") return [text(`${describe(managed)} — already stopped.`)];
        manager.kill(managed);
        await manager.wait(managed, Number.MAX_SAFE_INTEGER, 5_000, undefined, ctx.signal);
        return [text(`Stopped. ${describe(managed)}`)];
      },
    },
  ];
}
