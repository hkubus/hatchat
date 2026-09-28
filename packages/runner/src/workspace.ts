import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DirEntry } from "@hat/core";

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Owns the on-disk workspace tree for every session on this runner. */
export class WorkspaceManager {
  constructor(
    private readonly root: string,
    private readonly maxOutputBytes: number,
  ) {}

  sessionDir(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    return path.join(this.root, safe);
  }

  async ensure(sessionId: string): Promise<string> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Synchronous variant, so process registration can happen before stdin arrives. */
  ensureSync(sessionId: string): string {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Resolve a caller-supplied path inside the session workspace, or throw. */
  private resolveInSession(sessionId: string, relative: string): string {
    const dir = this.sessionDir(sessionId);
    const abs = path.resolve(dir, relative || ".");
    if (!isWithin(dir, abs)) {
      throw new Error(`Path escapes session workspace: ${relative}`);
    }
    return abs;
  }

  async resolveCwd(sessionId: string, relative?: string): Promise<string> {
    const dir = await this.ensure(sessionId);
    if (!relative) return dir;
    return this.resolveInSession(sessionId, relative);
  }

  resolveCwdSync(sessionId: string, relative?: string): string {
    const dir = this.ensureSync(sessionId);
    if (!relative) return dir;
    return this.resolveInSession(sessionId, relative);
  }

  async read(sessionId: string, relative: string): Promise<string> {
    return fs.readFile(this.resolveInSession(sessionId, relative), "utf8");
  }

  async write(sessionId: string, relative: string, data: string): Promise<void> {
    const abs = this.resolveInSession(sessionId, relative);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data, "utf8");
  }

  async list(sessionId: string, relative: string): Promise<DirEntry[]> {
    const dir = await this.ensure(sessionId);
    const abs = this.resolveInSession(sessionId, relative || ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const entry of entries) {
      const full = path.join(abs, entry.name);
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          size = (await fs.stat(full)).size;
        } catch {
          size = undefined;
        }
      }
      out.push({
        name: entry.name,
        path: path.relative(dir, full),
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        size,
      });
    }
    return out;
  }

  get outputCap(): number {
    return this.maxOutputBytes;
  }
}
