import type { Part, ProcessHost, SpawnedProcess, Tool } from "@hat/core";
import { newId } from "@hat/core";
import { z } from "zod";

const RESULT_MARKER = "\u001eHATRESULT ";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * The in-process side of the interpreter: reads one JSON request per line,
 * runs it in a persistent namespace, and answers on the real stdout behind a
 * marker. Cell stdout/stderr are captured; a trailing expression is echoed
 * like a REPL; open matplotlib figures come back as PNGs.
 */
export const PYTHON_DRIVER = String.raw`
import ast, base64, contextlib, io, json, os, sys, traceback
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/hat-matplotlib")
_hat_out = sys.stdout
_hat_in = sys.stdin
sys.stdin = io.StringIO("")
_hat_ns = {"__name__": "__main__"}

def _hat_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    images = []
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=100, bbox_inches="tight")
        images.append(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return images

def _hat_run(code):
    out, err = io.StringIO(), io.StringIO()
    value = error = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            tree = ast.parse(code, "<cell>", "exec")
            last = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(tree.body.pop().value)
            exec(compile(tree, "<cell>", "exec"), _hat_ns)
            if last is not None:
                result = eval(compile(last, "<cell>", "eval"), _hat_ns)
                if result is not None:
                    value = repr(result)
        except BaseException as exc:
            tb = exc.__traceback__
            while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
                tb = tb.tb_next
            error = "".join(traceback.format_exception(type(exc), exc, tb))
    try:
        images = _hat_figures()
    except Exception as exc:
        images = []
        error = (error or "") + "\n[could not render figures: %r]" % (exc,)
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "value": value, "error": error, "images": images}

for _hat_line in _hat_in:
    try:
        _hat_req = json.loads(_hat_line)
    except Exception:
        continue
    _hat_res = _hat_run(_hat_req.get("code", ""))
    _hat_res["id"] = _hat_req.get("id")
    _hat_out.write("\x1eHATRESULT " + json.dumps(_hat_res) + "\n")
    _hat_out.flush()
`;

interface CellResult {
  id: string;
  stdout: string;
  stderr: string;
  value: string | null;
  error: string | null;
  images: string[];
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One live interpreter process bound to a session. Cells run one at a time. */
class PythonKernel {
  private pending?: { id: string; resolve: (r: CellResult) => void; reject: (e: Error) => void };
  private stdoutBuffer = "";
  /** Output that arrived outside a result frame (subprocesses, C extensions). */
  private stray = "";
  private chain: Promise<unknown> = Promise.resolve();
  dead = false;

  constructor(private readonly proc: SpawnedProcess) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    let reason = "Python process exited";
    try {
      for await (const event of this.proc.events) {
        if (event.type === "stdout") this.onStdout(event.data);
        else if (event.type === "stderr") this.stray += event.data;
        else if (event.type === "exit") reason = `Python process exited (${event.code ?? event.signal})`;
        else if (event.type === "error") reason = event.error.message;
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    this.dead = true;
    const detail = this.stray.trim() ? `${reason}:\n${this.stray.trim().slice(-2_000)}` : reason;
    this.pending?.reject(new Error(detail));
    this.pending = undefined;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.startsWith(RESULT_MARKER)) {
        try {
          const result = JSON.parse(line.slice(RESULT_MARKER.length)) as CellResult;
          if (this.pending && result.id === this.pending.id) {
            if (this.stray) result.stdout = this.stray + result.stdout;
            this.stray = "";
            this.pending.resolve(result);
            this.pending = undefined;
          }
        } catch {
          this.stray += `${line}\n`;
        }
      } else {
        this.stray += `${line}\n`;
      }
    }
  }

  run(code: string, timeoutMs: number, signal: AbortSignal): Promise<CellResult> {
    const next = this.chain.then(
      () =>
        new Promise<CellResult>((resolve, reject) => {
          if (this.dead) {
            reject(new Error("Python process is not running"));
            return;
          }
          const id = newId();
          const cleanup = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          };
          const onTimeout = (): void => {
            this.kill();
            reject(new Error(`Cell timed out after ${timeoutMs}ms; the interpreter was restarted and its state lost.`));
          };
          const onAbort = (): void => {
            this.kill();
            reject(new Error("Cancelled; the interpreter was restarted and its state lost."));
          };
          const timer = setTimeout(onTimeout, timeoutMs);
          signal.addEventListener("abort", onAbort, { once: true });
          this.pending = {
            id,
            resolve: (result) => {
              cleanup();
              resolve(result);
            },
            reject: (error) => {
              cleanup();
              reject(error);
            },
          };
          this.proc.write(`${JSON.stringify({ id, code })}\n`);
        }),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  kill(): void {
    this.dead = true;
    this.proc.kill();
  }
}

/** Per-session interpreters, started lazily on first use. */
export class PythonKernels {
  private readonly kernels = new Map<string, Promise<PythonKernel>>();

  constructor(
    private readonly host: () => ProcessHost | undefined,
    private readonly pythonBin = "python3",
  ) {}

  async get(sessionId: string): Promise<PythonKernel> {
    const existing = this.kernels.get(sessionId);
    if (existing) {
      const kernel = await existing.catch(() => undefined);
      if (kernel && !kernel.dead) return kernel;
      this.kernels.delete(sessionId);
    }
    const host = this.host();
    if (!host) throw new Error("No runner connected; cannot start Python.");
    const starting = host
      .spawn({
        command: `${this.pythonBin} -u -c ${shq(PYTHON_DRIVER)}`,
        sessionId,
        shell: true,
      })
      .then((proc) => new PythonKernel(proc));
    this.kernels.set(sessionId, starting);
    starting.catch(() => this.kernels.delete(sessionId));
    return starting;
  }

  reset(sessionId: string): void {
    const existing = this.kernels.get(sessionId);
    this.kernels.delete(sessionId);
    void existing?.then((kernel) => kernel.kill()).catch(() => undefined);
  }

  killAll(): void {
    for (const sessionId of [...this.kernels.keys()]) this.reset(sessionId);
  }
}

const schema = z.object({
  code: z.string().describe("Python source to run. The last expression's value is echoed, as in a REPL."),
  reset: z
    .boolean()
    .optional()
    .describe("Restart the interpreter (clearing all variables) before running."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Abort the cell after this long (default ${DEFAULT_TIMEOUT_MS / 1000}s). A timeout restarts the interpreter.`),
});

export function createPythonTool(kernels: PythonKernels, requireApproval: boolean): Tool {
  return {
    name: "python",
    description:
      "Run Python in a stateful interpreter that persists between calls for this conversation " +
      "(variables, imports and loaded data survive). Runs in the workspace directory, so it can " +
      "read and write workspace files. Use it for calculations, data analysis and charts: " +
      "matplotlib figures are rendered to the user as images automatically. Install missing " +
      "packages with shell_exec (pip install --user ...).",
    schema,
    requiresApproval: requireApproval,
    async execute(raw, ctx): Promise<Part[]> {
      const args = schema.parse(raw);
      if (args.reset) kernels.reset(ctx.sessionId);
      const kernel = await kernels.get(ctx.sessionId);
      let result: CellResult;
      try {
        result = await kernel.run(args.code, args.timeout_ms ?? DEFAULT_TIMEOUT_MS, ctx.signal);
      } catch (error) {
        kernels.reset(ctx.sessionId);
        throw error;
      }

      const parts: Part[] = [];
      if (result.stdout) parts.push({ type: "text", text: result.stdout });
      if (result.stderr) parts.push({ type: "text", text: `[stderr]\n${result.stderr}` });
      if (result.value !== null) parts.push({ type: "text", text: result.value });
      if (result.error) parts.push({ type: "text", text: `[error]\n${result.error}` });
      if (result.images.length > 0) {
        parts.push({
          type: "text",
          text: `[${result.images.length} figure${result.images.length === 1 ? "" : "s"} shown to the user]`,
        });
        for (const data of result.images) {
          parts.push({ type: "image", source: { kind: "data", data, mime: "image/png" } });
        }
      }
      if (parts.length === 0) parts.push({ type: "text", text: "(no output)" });
      return parts;
    },
  };
}
