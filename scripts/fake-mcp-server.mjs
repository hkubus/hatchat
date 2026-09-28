// A tiny stdio MCP server used by the smoke test and as a reference.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.
import readline from "node:readline";

const serverInfo = { name: "fake-mcp", version: "0.1.0" };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo,
      },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text back, prefixing it with 'mcp echo:'.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Text to echo" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const text = params?.arguments?.text ?? "";
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `mcp echo: ${text}` }] },
    });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
