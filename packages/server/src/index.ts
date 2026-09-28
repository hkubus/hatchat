import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { createServer } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env file present */
}

const config = loadConfig();
const logger = createLogger();

const runtime = await createServer(config);

const server = serve(
  { fetch: runtime.app.fetch, port: config.port, hostname: config.host },
  (info) => {
    logger.info(`hat server listening on http://${config.host}:${info.port}`);
    if (!config.authToken) {
      logger.warn("HAT_AUTH_TOKEN is unset — API is unauthenticated (dev only)");
    }
  },
);

runtime.registry.attach(server as unknown as HttpServer);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`received ${signal}, shutting down`);
    runtime.close();
    server.close(() => process.exit(0));
  });
}
