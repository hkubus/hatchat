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
