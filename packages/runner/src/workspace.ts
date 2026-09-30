import fs, { type FileHandle } from "node:fs/promises";
import { constants, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DirEntry } from "@hat/core";

/** Not following a symlink in the last component; not blocking on a FIFO. Absent on Windows. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

/**
 * Where an open descriptor can be named as a path: `/proc/self/fd/N` is the
 * very file or directory opened, whatever happened to the path it was
 * opened by since. Linux only; elsewhere the checks fall back to comparing
 * the opened file with where its path leads now.
 */
const PROC_FD = process.platform === "linux" && existsSync("/proc/self/fd") ? "/proc/self/fd" : undefined;

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

function escapes(relative: string): Error {
  return new Error(`Path escapes session workspace: ${relative}`);
}

/**
 * Open a directory and make sure the directory opened is inside `root`. The
 * path was checked before, but a process in the workspace could have swapped
 * one of its directories for a symlink since.
 */
async function openDirInside(root: string, dir: string, relative: string): Promise<FileHandle> {
  const handle = await fs.open(dir, constants.O_RDONLY | DIRECTORY);
  try {
    await assertOpenedInside(handle, root, dir, relative);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Throw unless what `handle` has open is inside `root` (and, without /proc, is still what `opened` names). */
async function assertOpenedInside(handle: FileHandle, root: string, opened: string, relative: string): Promise<void> {
  if (PROC_FD) {
    if (!isWithin(root, await fs.readlink(`${PROC_FD}/${handle.fd}`))) throw escapes(relative);
    return;
  }
  const real = await fs.realpath(opened);
  if (!isWithin(root, real)) throw escapes(relative);
  const [held, named] = await Promise.all([handle.stat(), fs.stat(real)]);
  if (held.dev !== named.dev || held.ino !== named.ino) {
    throw new Error(`Path changed while it was opened: ${relative}`);
  }
}

/**
 * Open the file at `target` (already resolved inside the workspace) so that
 * the file opened is inside `root` whatever changes on disk meanwhile: its
 * directory is opened and checked first, and the file is opened through that
 * descriptor, never following a symlink in its own name. Without /proc the
 * file is opened by path and then compared with where the path leads now:
 * nothing is read or written through a swapped path, though a new, empty
 * file could be left where it led.
 */
async function openFileInside(root: string, target: string, relative: string, flags: number): Promise<FileHandle> {
  const mode = flags | NOFOLLOW | NONBLOCK;
  let handle: FileHandle;
  if (PROC_FD) {
    const dir = await openDirInside(root, path.dirname(target), relative);
    try {
      handle = await fs.open(`${PROC_FD}/${dir.fd}/${path.basename(target)}`, mode, 0o666);
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw escapes(relative);
      throw error;
    } finally {
      await dir.close();
    }
  } else {
    await (await openDirInside(root, path.dirname(target), relative)).close();
    handle = await fs.open(target, mode, 0o666).catch((error: unknown) => {
      throw errorCode(error) === "ELOOP" ? escapes(relative) : error;
    });
    try {
      await assertOpenedInside(handle, root, target, relative);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${relative}`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
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
   * creates whatever it points at. That check is made again on what is
   * actually opened (see `openFileInside`), so a process in the workspace
   * swapping a directory for a symlink in between can't redirect it.
   */
  private async resolveReal(sessionId: string, relative: string): Promise<{ root: string; target: string }> {
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
        if (!isWithin(root, resolved)) throw escapes(relative);
        return { root, target: resolved };
      }
      if (await isSymlink(current)) {
        throw new Error(`Path goes through a dangling symlink: ${relative}`);
      }
      missing.unshift(path.basename(current));
    }
  }

  async read(sessionId: string, relative: string): Promise<string> {
    const { root, target } = await this.resolveReal(sessionId, relative);
    await assertRegularFile(target, relative);
    const handle = await openFileInside(root, target, relative, constants.O_RDONLY);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async write(sessionId: string, relative: string, data: string): Promise<void> {
    const { root, target } = await this.resolveReal(sessionId, relative);
    await assertRegularFile(target, relative, true);
    // Creating missing directories goes by path. If one of them is swapped
    // for a symlink meanwhile, an empty directory may land outside, but the
    // file never does: the directory it goes in is checked once opened.
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Not truncated until the file opened is known to be the right one.
    const handle = await openFileInside(root, target, relative, constants.O_WRONLY | constants.O_CREAT);
    try {
      await handle.truncate(0);
      await handle.writeFile(data, "utf8");
    } finally {
      await handle.close();
    }
  }

  async list(sessionId: string, relative: string): Promise<DirEntry[]> {
    const { root, target: abs } = await this.resolveReal(sessionId, relative || ".");
    // Entries keep the path the caller asked for, not where a symlink led.
    const shown = path.relative(this.sessionDir(sessionId), this.resolveInSession(sessionId, relative || "."));
    const dir = await openDirInside(root, abs, relative || ".");
    try {
      // Read through the descriptor where possible: the directory checked.
      const listed = PROC_FD ? `${PROC_FD}/${dir.fd}` : abs;
      const entries = await fs.readdir(listed, { withFileTypes: true });
      const out: DirEntry[] = [];
      for (const entry of entries) {
        let size: number | undefined;
        if (entry.isFile()) {
          try {
            size = (await fs.lstat(path.join(listed, entry.name))).size;
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
    } finally {
      await dir.close();
    }
  }

  get outputCap(): number {
    return this.maxOutputBytes;
  }
}
