import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DirEntry } from "@hat/core";

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** FIFOs and devices would block a read or write forever; only plain files are served. */
async function assertRegularFile(target: string, relative: string, mayBeMissing = false): Promise<void> {
  try {
    if ((await fs.stat(target)).isFile()) return;
  } catch (error) {
    if (mayBeMissing && errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error(`Not a regular file: ${relative}`);
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

  /**
   * Delete a session's workspace. `fs.rm` removes symlinks, never what they
   * point at, so a link planted inside can't take anything else with it.
   */
  async remove(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    // An id with nothing left after sanitizing would name the root of every workspace.
    if (path.resolve(dir) === path.resolve(this.root)) return;
    await fs.rm(dir, { recursive: true, force: true });
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

  /**
   * Resolve a path for a file operation, following symlinks. The lexical check
   * is not enough on its own: file operations run here, on the runner's host,
   * even when commands are sandboxed, so a symlink left in the workspace (by a
   * command, `git clone`, `tar x`) would carry them anywhere on this machine.
   * The longest existing prefix is resolved and must stay inside the
   * workspace, and a dangling symlink is refused, since writing through it
   * creates whatever it points at. The check holds at the time of the call; a
   * sandboxed process still running could swap a directory for a link after.
   */
  private async resolveReal(sessionId: string, relative: string): Promise<string> {
    const abs = this.resolveInSession(sessionId, relative);
    const root = await fs.realpath(await this.ensure(sessionId));
    const missing: string[] = [];
    for (let current = abs; ; current = path.dirname(current)) {
      let real: string | undefined;
      try {
        real = await fs.realpath(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (real !== undefined) {
        const resolved = path.join(real, ...missing);
        if (!isWithin(root, resolved)) {
          throw new Error(`Path escapes session workspace: ${relative}`);
        }
        return resolved;
      }
      if (await isSymlink(current)) {
        throw new Error(`Path goes through a dangling symlink: ${relative}`);
      }
      missing.unshift(path.basename(current));
    }
  }

  async read(sessionId: string, relative: string): Promise<string> {
    const target = await this.resolveReal(sessionId, relative);
    await assertRegularFile(target, relative);
    return fs.readFile(target, "utf8");
  }

  async write(sessionId: string, relative: string, data: string): Promise<void> {
    const target = await this.resolveReal(sessionId, relative);
    await assertRegularFile(target, relative, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, "utf8");
  }

  async list(sessionId: string, relative: string): Promise<DirEntry[]> {
    const abs = await this.resolveReal(sessionId, relative || ".");
    // Entries keep the path the caller asked for, not where a symlink led.
    const shown = path.relative(this.sessionDir(sessionId), this.resolveInSession(sessionId, relative || "."));
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const entry of entries) {
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          size = (await fs.stat(path.join(abs, entry.name))).size;
        } catch {
          size = undefined;
        }
      }
      out.push({
        name: entry.name,
        path: path.join(shown, entry.name),
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
