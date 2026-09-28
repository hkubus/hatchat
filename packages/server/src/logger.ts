import type { AuditEntry, AuditLog, Logger } from "@hat/core";

function emit(level: string, msg: string, meta?: unknown): void {
  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  const line = `[server:${level}] ${msg}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(): Logger {
  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}

export function createAuditLog(logger: Logger): AuditLog {
  return {
    record(entry: AuditEntry) {
      logger.info("audit", entry);
    },
  };
}
