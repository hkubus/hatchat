import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { WorkspaceManager } from "./workspace.js";

/** A session workspace, plus a directory beside it standing in for the rest of the host. */
function setup(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hat-workspace-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, "host");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "host secret");
  const workspace = new WorkspaceManager(path.join(base, "workspaces"), 1_000_000);
  return { outside, workspace, dir: workspace.ensureSync("s1") };
}

test("file operations do not follow symlinks out of the workspace", async (t) => {
  const { outside, workspace, dir } = setup(t);
  // What a sandboxed command, a cloned repo or an unpacked archive can leave behind.
  fs.symlinkSync(outside, path.join(dir, "host"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "secret.txt"));

  await assert.rejects(workspace.read("s1", "host/secret.txt"), /escapes session workspace/);
  await assert.rejects(workspace.read("s1", "secret.txt"), /escapes session workspace/);
  await assert.rejects(workspace.list("s1", "host"), /escapes session workspace/);
  await assert.rejects(workspace.write("s1", "host/planted.txt", "x"), /escapes session workspace/);
  await assert.rejects(workspace.write("s1", "secret.txt", "overwritten"), /escapes session workspace/);

  assert.equal(fs.existsSync(path.join(outside, "planted.txt")), false);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "host secret");
});

test("a dangling symlink is not written through", async (t) => {
  const { outside, workspace, dir } = setup(t);
  fs.symlinkSync(path.join(outside, "created.txt"), path.join(dir, "new.txt"));

  await assert.rejects(workspace.write("s1", "new.txt", "x"), /dangling symlink/);
  assert.equal(fs.existsSync(path.join(outside, "created.txt")), false);
});

test("paths that climb out of the workspace are refused", async (t) => {
  const { workspace } = setup(t);
  await assert.rejects(workspace.read("s1", "../host/secret.txt"), /escapes session workspace/);
  await assert.rejects(workspace.read("s1", "/etc/hostname"), /escapes session workspace/);
});

test("symlinks that stay inside the workspace keep working", async (t) => {
  const { workspace, dir } = setup(t);
  await workspace.write("s1", "src/a.txt", "hello");
  fs.symlinkSync("src", path.join(dir, "alias"));

  assert.equal(await workspace.read("s1", "alias/a.txt"), "hello");
  await workspace.write("s1", "alias/b.txt", "through the link");
  assert.equal(fs.readFileSync(path.join(dir, "src", "b.txt"), "utf8"), "through the link");
  const entries = await workspace.list("s1", "alias");
  assert.deepEqual(entries.map((entry) => entry.path).sort(), ["alias/a.txt", "alias/b.txt"]);
  assert.deepEqual((await workspace.list("s1", "")).map((entry) => entry.path).sort(), ["alias", "src"]);
});

test("a FIFO is refused instead of blocking the read forever", async (t) => {
  const { workspace, dir } = setup(t);
  try {
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
  } catch {
    t.skip("mkfifo is not available");
    return;
  }
  await assert.rejects(workspace.read("s1", "pipe"), /Not a regular file/);
  await assert.rejects(workspace.write("s1", "pipe", "x"), /Not a regular file/);
});

test("removing a workspace deletes it, and never what a symlink inside points at", async (t) => {
  const { outside, workspace, dir } = setup(t);
  await workspace.write("s1", "notes/a.txt", "private");
  fs.symlinkSync(outside, path.join(dir, "host"));

  await workspace.remove("s1");
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "host secret");

  // An id with nothing left after sanitizing would name the root: refused.
  const other = workspace.ensureSync("s2");
  await workspace.remove("");
  assert.equal(fs.existsSync(other), true);
});

/**
 * Swap `dir/<name>` for a symlink to `outside` right after the path check,
 * as a process still running in the workspace could. Once: later calls
 * see the symlink at check time.
 */
function swapAfterCheck(workspace: WorkspaceManager, dir: string, name: string, outside: string): void {
  const internals = workspace as unknown as { resolveReal: (...args: unknown[]) => Promise<unknown> };
  const check = internals.resolveReal.bind(workspace);
  let swapped = false;
  internals.resolveReal = async (...args: unknown[]) => {
    const checked = await check(...args);
    if (swapped) return checked;
    swapped = true;
    fs.renameSync(path.join(dir, name), path.join(dir, `${name}.old`));
    fs.symlinkSync(outside, path.join(dir, name));
    return checked;
  };
}

test("a directory swapped for a symlink after the check is not read through", async (t) => {
  const { outside, workspace, dir } = setup(t);
  await workspace.write("s1", "src/secret.txt", "workspace copy");
  swapAfterCheck(workspace, dir, "src", outside);
  await assert.rejects(workspace.read("s1", "src/secret.txt"), /escapes session workspace|changed while it was opened/);
});

test("a directory swapped for a symlink after the check is not written through", async (t) => {
  const { outside, workspace, dir } = setup(t);
  await workspace.write("s1", "src/secret.txt", "workspace copy");
  swapAfterCheck(workspace, dir, "src", outside);
  await assert.rejects(workspace.write("s1", "src/secret.txt", "overwritten"), /escapes session workspace|changed while it was opened/);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "host secret");
  assert.equal(fs.existsSync(path.join(outside, "secret.txt")), true);
});

test("a new file is not created through a directory swapped after the check", async (t) => {
  const { outside, workspace, dir } = setup(t);
  await workspace.write("s1", "src/a.txt", "x");
  swapAfterCheck(workspace, dir, "src", outside);
  await assert.rejects(workspace.write("s1", "src/planted.txt", "x"), /escapes session workspace|changed while it was opened/);
  assert.equal(fs.existsSync(path.join(outside, "planted.txt")), false);
});

test("a directory swapped for a symlink after the check is not listed", async (t) => {
  const { outside, workspace, dir } = setup(t);
  await workspace.write("s1", "src/a.txt", "x");
  swapAfterCheck(workspace, dir, "src", outside);
  await assert.rejects(workspace.list("s1", "src"), /escapes session workspace|changed while it was opened/);
});

test("a file swapped for a symlink after the check is not followed", async (t) => {
  const { outside, workspace, dir } = setup(t);
  await workspace.write("s1", "notes.txt", "mine");
  swapAfterCheck(workspace, dir, "notes.txt", path.join(outside, "secret.txt"));
  await assert.rejects(workspace.read("s1", "notes.txt"), /escapes session workspace|changed while it was opened/);
  await assert.rejects(workspace.write("s1", "notes.txt", "overwritten"), /escapes session workspace|changed while it was opened/);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "host secret");
});
