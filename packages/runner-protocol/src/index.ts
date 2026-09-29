import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const normalizedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  cause: z.unknown().optional(),
});

export const hostCapabilitiesSchema = z.object({
  os: z.string(),
  arch: z.string(),
  runtimes: z.array(z.string()),
  tags: z.array(z.string()),
});

export const dirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir", "other"]),
  size: z.number().optional(),
});

export const fetchResponseSchema = z.object({
  status: z.number(),
  headers: z.record(z.string()),
  body: z.string(),
});

export const helloOkSchema = z.object({
  t: z.literal("hello.ok"),
  runnerId: z.string(),
  credential: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Server -> Runner
// ---------------------------------------------------------------------------

export const workspaceEnsureSchema = z.object({
  t: z.literal("workspace.ensure"),
  reqId: z.string(),
  sessionId: z.string(),
});

export const execStartSchema = z.object({
  t: z.literal("exec.start"),
  jobId: z.string(),
  sessionId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().optional(),
  stdin: z.string().optional(),
});

export const execStdinSchema = z.object({
  t: z.literal("exec.stdin"),
  jobId: z.string(),
  chunk: z.string(),
});

export const execCancelSchema = z.object({
  t: z.literal("exec.cancel"),
  jobId: z.string(),
});

export const procStartSchema = z.object({
  t: z.literal("proc.start"),
  procId: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  /** Scope the process to this session's workspace (cwd is then relative to it). */
  sessionId: z.string().optional(),
  /** Run `command` as a shell line through the runner's sandbox plan. */
  shell: z.boolean().optional(),
});

export const procStdinSchema = z.object({
  t: z.literal("proc.stdin"),
  procId: z.string(),
  chunk: z.string(),
});

export const procStdinEndSchema = z.object({
  t: z.literal("proc.stdin.end"),
  procId: z.string(),
});

export const procCancelSchema = z.object({
  t: z.literal("proc.cancel"),
  procId: z.string(),
});

export const fsReadSchema = z.object({
  t: z.literal("fs.read"),
  reqId: z.string(),
  sessionId: z.string(),
  path: z.string(),
});

export const fsWriteSchema = z.object({
  t: z.literal("fs.write"),
  reqId: z.string(),
  sessionId: z.string(),
  path: z.string(),
  data: z.string(),
});

export const fsListSchema = z.object({
  t: z.literal("fs.list"),
  reqId: z.string(),
  sessionId: z.string(),
  path: z.string(),
});

export const netFetchSchema = z.object({
  t: z.literal("net.fetch"),
  reqId: z.string(),
  sessionId: z.string(),
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
});

export const serverToRunnerSchema = z.discriminatedUnion("t", [
  helloOkSchema,
  workspaceEnsureSchema,
  execStartSchema,
  execStdinSchema,
  execCancelSchema,
  procStartSchema,
  procStdinSchema,
  procStdinEndSchema,
  procCancelSchema,
  fsReadSchema,
  fsWriteSchema,
  fsListSchema,
  netFetchSchema,
]);
export type ServerToRunner = z.infer<typeof serverToRunnerSchema>;

// ---------------------------------------------------------------------------
// Runner -> Server
// ---------------------------------------------------------------------------

export const helloSchema = z.object({
  t: z.literal("hello"),
  v: z.number(),
  runnerId: z.string(),
  enrollToken: z.string().optional(),
  credential: z.string().optional(),
  caps: hostCapabilitiesSchema,
});

export const heartbeatSchema = z.object({
  t: z.literal("heartbeat"),
  load: z.object({ jobs: z.number(), uptimeMs: z.number() }),
});

export const workspaceOkSchema = z.object({
  t: z.literal("workspace.ok"),
  reqId: z.string(),
  sessionId: z.string(),
  root: z.string(),
});

export const execStdoutSchema = z.object({
  t: z.literal("exec.stdout"),
  jobId: z.string(),
  chunk: z.string(),
});

export const execStderrSchema = z.object({
  t: z.literal("exec.stderr"),
  jobId: z.string(),
  chunk: z.string(),
});

export const execExitSchema = z.object({
  t: z.literal("exec.exit"),
  jobId: z.string(),
  code: z.number().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number(),
});

export const procStdoutSchema = z.object({
  t: z.literal("proc.stdout"),
  procId: z.string(),
  chunk: z.string(),
});

export const procStderrSchema = z.object({
  t: z.literal("proc.stderr"),
  procId: z.string(),
  chunk: z.string(),
});

export const procExitSchema = z.object({
  t: z.literal("proc.exit"),
  procId: z.string(),
  code: z.number().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number(),
});

export const fsReadResultSchema = z.object({
  t: z.literal("fs.read.result"),
  reqId: z.string(),
  data: z.string(),
});

export const fsWriteResultSchema = z.object({
  t: z.literal("fs.write.result"),
  reqId: z.string(),
});

export const fsListResultSchema = z.object({
  t: z.literal("fs.list.result"),
  reqId: z.string(),
  entries: z.array(dirEntrySchema),
});

export const netFetchResultSchema = z.object({
  t: z.literal("net.fetch.result"),
  reqId: z.string(),
  response: fetchResponseSchema,
});

export const jobErrorSchema = z.object({
  t: z.literal("job.error"),
  jobId: z.string().optional(),
  reqId: z.string().optional(),
  procId: z.string().optional(),
  error: normalizedErrorSchema,
});

export const runnerToServerSchema = z.discriminatedUnion("t", [
  helloSchema,
  heartbeatSchema,
  workspaceOkSchema,
  execStdoutSchema,
  execStderrSchema,
  execExitSchema,
  procStdoutSchema,
  procStderrSchema,
  procExitSchema,
  fsReadResultSchema,
  fsWriteResultSchema,
  fsListResultSchema,
  netFetchResultSchema,
  jobErrorSchema,
]);
export type RunnerToServer = z.infer<typeof runnerToServerSchema>;

export const linkMessageSchema = z.union([serverToRunnerSchema, runnerToServerSchema]);
export type LinkMessage = z.infer<typeof linkMessageSchema>;

export function encodeLinkMessage(message: LinkMessage): string {
  return JSON.stringify(message);
}

export function parseRunnerToServer(raw: string): RunnerToServer {
  const parsed: unknown = JSON.parse(raw);
  return runnerToServerSchema.parse(parsed);
}

export function parseServerToRunner(raw: string): ServerToRunner {
  const parsed: unknown = JSON.parse(raw);
  return serverToRunnerSchema.parse(parsed);
}
