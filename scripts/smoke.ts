import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

const PORT = 8100 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;
const ENROLL = "smoke-token";

const tsx = path.resolve("node_modules/.bin/tsx");
const children: ChildProcess[] = [];

interface PathNode {
  message: { id: string; role: string };
  siblingIndex: number;
  siblingCount: number;
  siblingIds: string[];
}

function launch(name: string, entry: string, env: Record<string, string>): void {
  const child = spawn(tsx, [entry], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
}

async function waitForRunner(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const body = (await res.json()) as { runners: string[] };
      if (body.runners.length > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("runner did not connect in time");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function postSSE(
  url: string,
  body: unknown,
): Promise<{ events: any[]; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`SSE ${url}: ${res.status}`);

  const events: any[] = [];
  let assistantText = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handle = async (event: any): Promise<void> => {
    events.push(event);
    if (event.type === "text.delta") assistantText += event.text;
    if (event.type === "tool.approval" && event.status === "requested") {
      await postJson(`${BASE}/api/approvals/${encodeURIComponent(event.callId)}`, {
        decision: "approve",
      });
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            await handle(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore */
          }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { events, text: assistantText };
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(`[smoke] ${ok ? "ok  " : "FAIL"} ${label}`);
}

async function main(): Promise<void> {
  launch("server", "packages/server/src/index.ts", {
    HAT_PORT: String(PORT),
    HAT_HOST: "127.0.0.1",
    HAT_ENROLL_TOKEN: ENROLL,
    HAT_AUTH_PASSWORD: "",
    HAT_AUTH_PASSWORD_HASH: "",
    HAT_AUTH_TOKEN: "",
    HAT_DB_PATH: "./.hat/smoke.db",
    HAT_MASTER_KEY_FILE: "./.hat/smoke-master.key",
    HAT_UPLOAD_DIR: "./.hat/smoke-uploads",
    HAT_WORKSPACE_ROOT: "./.hat/smoke-workspaces",
  });
  launch("runner", "packages/runner/src/index.ts", {
    HAT_SERVER_URL: `ws://127.0.0.1:${PORT}/link`,
    HAT_ENROLL_TOKEN: ENROLL,
    HAT_RUNNER_ID: "smoke-runner",
    HAT_WORKSPACE_ROOT: "./.hat/smoke-workspaces",
  });

  await waitForRunner();
  console.log("\n[smoke] runner connected\n");

  const { session } = await postJson<{ session: { id: string } }>(`${BASE}/api/sessions`, {
    model: "fake/fake-agent",
  });
  const sessionId = session.id;

  // --- turn + approval round-trip + runner execution -----------------------
  const turn = await postSSE(`${BASE}/api/sessions/${sessionId}/turn`, {
    text: "run: echo hello from smoke",
  });
  const toolResult = turn.events.find((e) => e.type === "tool.result");
  const resultText = toolResult
    ? (toolResult.parts as any[]).map((p) => (p.type === "text" ? p.text : "")).join("")
    : "";
  const approved = turn.events.some((e) => e.type === "tool.approval" && e.status === "approved");
  const turnErrors = turn.events.filter((e) => e.type === "error");

  check("tool approval round-trip", approved);
  check("runner executed command", resultText.includes("hello from smoke"));
  check("no turn errors", turnErrors.length === 0);

  // --- persistence + model list -------------------------------------------
  const models = await getJson<{ models: Array<{ id: string; capabilities: object }> }>(
    `${BASE}/api/models`,
  );
  check("models endpoint returns fake model", models.models.some((m) => m.id === "fake/fake-agent"));

  const listed = await getJson<{ sessions: Array<{ id: string }> }>(`${BASE}/api/sessions`);
  check("session persisted", listed.sessions.some((s) => s.id === sessionId));

  // --- attachments ---------------------------------------------------------
  const png = (() => {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(16, 16);
    buffer.writeUInt32BE(16, 20);
    return buffer;
  })();

  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "test.png");
  const uploadRes = await fetch(`${BASE}/api/attachments`, { method: "POST", body: form });
  const upload = (await uploadRes.json()) as {
    attachment: { id: string; width?: number; height?: number; url: string };
  };
  check(
    "attachment uploaded with dimensions",
    Boolean(upload.attachment?.id) &&
      upload.attachment.width === 16 &&
      upload.attachment.height === 16,
  );

  const imageRes = await fetch(`${BASE}${upload.attachment.url}`);
  check(
    "attachment served as an image",
    imageRes.ok && (imageRes.headers.get("content-type") ?? "").includes("image/png"),
  );

  await postSSE(`${BASE}/api/sessions/${sessionId}/turn`, {
    text: "what is this?",
    attachmentIds: [upload.attachment.id],
  });
  const withImage = await getJson<{
    path: Array<{ message: { role: string; parts: any[] } }>;
  }>(`${BASE}/api/sessions/${sessionId}`);
  const lastUser = [...withImage.path].reverse().find((n) => n.message.role === "user");
  check(
    "user message persisted an image attachment part",
    Boolean(
      lastUser?.message.parts.some(
        (p) => p.type === "image" && p.source?.kind === "attachment",
      ),
    ),
  );

  // --- provider catalog + runtime activation -------------------------------
  type Prov = { id: string; configured: boolean; registered: boolean };
  const provs0 = await getJson<{ providers: Prov[] }>(`${BASE}/api/providers`);
  check("provider catalog lists openrouter", provs0.providers.some((p) => p.id === "openrouter"));
  check("providers unconfigured initially", provs0.providers.every((p) => !p.configured));

  await postJson(`${BASE}/api/secrets`, { name: "OPENROUTER_API_KEY", value: "sk-dummy" });
  const provs1 = await getJson<{ providers: Prov[] }>(`${BASE}/api/providers`);
  check(
    "provider activates when key is set",
    provs1.providers.find((p) => p.id === "openrouter")?.registered === true,
  );

  await fetch(`${BASE}/api/secrets/OPENROUTER_API_KEY`, { method: "DELETE" });
  const provs2 = await getJson<{ providers: Prov[] }>(`${BASE}/api/providers`);
  check(
    "provider deactivates when key is removed",
    provs2.providers.find((p) => p.id === "openrouter")?.registered === false,
  );

  // --- plugins -------------------------------------------------------------
  type PluginInfo = { id: string; status: string; enabled: boolean; source: string };
  const plugins0 = await getJson<{ plugins: PluginInfo[] }>(`${BASE}/api/plugins`);
  check(
    "plugins include shell, fake and openrouter",
    ["shell", "fake", "openrouter"].every((id) => plugins0.plugins.some((p) => p.id === id)),
  );
  check(
    "openrouter needs config without a key",
    plugins0.plugins.find((p) => p.id === "openrouter")?.status === "needs-config",
  );
  check("shell plugin active", plugins0.plugins.find((p) => p.id === "shell")?.status === "active");

  const tools0 = await getJson<{ tools: string[] }>(`${BASE}/api/tools`);
  check("shell_exec tool registered by plugin", tools0.tools.includes("shell_exec"));

  await postJson(`${BASE}/api/plugins/shell/enable`, { enabled: false });
  const tools1 = await getJson<{ tools: string[] }>(`${BASE}/api/tools`);
  check("disabling the shell plugin unregisters its tool", !tools1.tools.includes("shell_exec"));

  await postJson(`${BASE}/api/plugins/shell/enable`, { enabled: true });
  const tools2 = await getJson<{ tools: string[] }>(`${BASE}/api/tools`);
  check("re-enabling restores the tool", tools2.tools.includes("shell_exec"));
  check("external plugin loaded from plugins dir", tools2.tools.includes("example_echo"));

  // --- MCP -----------------------------------------------------------------
  const mcpConfig = {
    serversJson: JSON.stringify([
      {
        name: "fake",
        transport: "stdio",
        command: process.execPath,
        args: [path.resolve("scripts/fake-mcp-server.mjs")],
      },
    ]),
    requireApproval: false,
  };
  const mcpSave = await fetch(`${BASE}/api/plugins/mcp/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: mcpConfig }),
  });
  const mcpPlugin = ((await mcpSave.json()) as { plugin: { status: string } }).plugin;
  check("mcp plugin activates against the runner", mcpPlugin.status === "active");

  const tools3 = await getJson<{ tools: string[] }>(`${BASE}/api/tools`);
  check("mcp tool discovered and namespaced", tools3.tools.includes("mcp__fake__echo"));

  await patchJson(`${BASE}/api/sessions/${sessionId}`, { approvalMode: "auto" });
  const mcpTurn = await postSSE(`${BASE}/api/sessions/${sessionId}/turn`, {
    text: 'tool: mcp__fake__echo {"text":"hello mcp"}',
  });
  const mcpResult = mcpTurn.events.find((e) => e.type === "tool.result");
  const mcpText = mcpResult
    ? (mcpResult.parts as any[]).map((p) => (p.type === "text" ? p.text : "")).join("")
    : "";
  check(
    "mcp tool call round-trips through the runner",
    mcpResult?.isError === false && mcpText.includes("mcp echo: hello mcp"),
  );

  // --- branching: regenerate creates a sibling assistant -------------------
  const before = await getJson<{ path: PathNode[] }>(`${BASE}/api/sessions/${sessionId}`);
  const firstAssistant = before.path.find((n) => n.message.role === "assistant");
  check("initial path has an assistant message", Boolean(firstAssistant));

  await postSSE(`${BASE}/api/sessions/${sessionId}/regenerate`, {
    messageId: firstAssistant!.message.id,
  });
  const afterRegen = await getJson<{ path: PathNode[] }>(`${BASE}/api/sessions/${sessionId}`);
  const assistantNode = afterRegen.path.find((n) => n.message.role === "assistant");
  check("regenerate created a sibling branch", assistantNode?.siblingCount === 2);
  check("new branch is active", assistantNode?.message.id !== firstAssistant!.message.id);

  // --- branch selection switches the active path ---------------------------
  await postJson(`${BASE}/api/sessions/${sessionId}/select`, {
    messageId: firstAssistant!.message.id,
  });
  const afterSelect = await getJson<{ path: PathNode[] }>(`${BASE}/api/sessions/${sessionId}`);
  const selected = afterSelect.path.find((n) => n.message.role === "assistant");
  check("selecting the other sibling switches branches", selected?.message.id === firstAssistant!.message.id);
  check("selected branch index is 0", selected?.siblingIndex === 0);

  // --- edit creates a sibling user message ---------------------------------
  const userNode = afterSelect.path.find((n) => n.message.role === "user");
  await postSSE(`${BASE}/api/sessions/${sessionId}/edit`, {
    messageId: userNode!.message.id,
    text: "run: echo edited branch",
  });
  const afterEdit = await getJson<{ path: PathNode[] }>(`${BASE}/api/sessions/${sessionId}`);
  const editedUser = afterEdit.path.find((n) => n.message.role === "user");
  check("edit created a sibling user message", editedUser?.siblingCount === 2);

  // --- tool policy ---------------------------------------------------------
  await patchJson(`${BASE}/api/sessions/${sessionId}`, { approvalMode: "auto" });
  const autoTurn = await postSSE(`${BASE}/api/sessions/${sessionId}/turn`, {
    text: "run: echo auto mode",
  });
  const autoApprovals = autoTurn.events.filter(
    (e) => e.type === "tool.approval" && e.status === "requested",
  ).length;
  const autoResult = autoTurn.events.find((e) => e.type === "tool.result");
  check(
    "auto policy runs without approval",
    autoApprovals === 0 && Boolean(autoResult) && autoResult.isError === false,
  );

  await patchJson(`${BASE}/api/sessions/${sessionId}`, { approvalMode: "deny" });
  const denyTurn = await postSSE(`${BASE}/api/sessions/${sessionId}/turn`, {
    text: "run: echo denied by policy",
  });
  const denyResult = denyTurn.events.find((e) => e.type === "tool.result");
  const denyText = denyResult
    ? (denyResult.parts as any[]).map((p) => (p.type === "text" ? p.text : "")).join("")
    : "";
  check(
    "deny policy blocks the tool",
    denyResult?.isError === true && denyText.includes("blocked by the session policy"),
  );

  await patchJson(`${BASE}/api/sessions/${sessionId}`, { approvalMode: "ask" });
  const resumed = await getJson<{ session: { approvalMode: string } }>(
    `${BASE}/api/sessions/${sessionId}`,
  );
  check("policy persisted on the session", resumed.session.approvalMode === "ask");

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n[smoke] ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

const timeout = setTimeout(() => {
  console.error("[smoke] timed out");
  process.exitCode = 1;
  shutdown();
}, 60000);

function shutdown(): void {
  clearTimeout(timeout);
  for (const child of children) child.kill("SIGKILL");
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}

main()
  .catch((error) => {
    console.error("[smoke] error:", error);
    process.exitCode = 1;
  })
  .finally(shutdown);
