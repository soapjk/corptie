import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitCommitProtection, parseStatusPaths } from "../src/runtime/gitCommitProtection.mjs";

const execFileAsync = promisify(execFile);
const rules = [
  { path: ".corptie", kind: "directory" },
  { path: "AGENTS.md", kind: "file", onlyWhenSymlink: true }
];

test("status parser preserves renamed source and destination paths", () => {
  assert.deepEqual(
    parseStatusPaths(" M file.txt\0R  new.txt\0old.txt\0?? .corptie/tool.sh\0"),
    [".corptie/tool.sh", "file.txt", "new.txt", "old.txt"]
  );
});

test("protected local Agent files can be added to the project gitignore", async () => {
  const fixture = await createRepository();
  const protection = new GitCommitProtection({ rules });
  try {
    await mkdir(join(fixture.path, ".corptie"));
    await writeFile(join(fixture.path, ".corptie", "restart.sh"), "#!/bin/sh\n");
    const inspection = await protection.inspect(fixture.path);
    assert.equal(inspection.requiresDecision, true);
    assert.deepEqual(inspection.protectedPaths, [".corptie/restart.sh"]);

    const result = await protection.resolve(fixture.path, { decision: "ignore" });
    assert.equal(result.gitignoreUpdated, true);
    assert.match(await readFile(join(fixture.path, ".gitignore"), "utf8"), /^# Corptie local Agent configuration\n\/.corptie\/\n$/);
    assert.deepEqual((await protection.inspect(fixture.path)).protectedPaths, []);
  } finally {
    await fixture.close();
  }
});

test("tracked project instructions are allowed while a local symlink is protected", async () => {
  const fixture = await createRepository();
  const protection = new GitCommitProtection({ rules });
  try {
    await writeFile(join(fixture.path, "AGENTS.md"), "Project instructions\n");
    await git(fixture.path, ["add", "AGENTS.md"]);
    await git(fixture.path, ["commit", "-m", "Add project instructions"]);
    await writeFile(join(fixture.path, "AGENTS.md"), "Updated project instructions\n");
    assert.deepEqual((await protection.inspect(fixture.path)).protectedPaths, []);

    await rm(join(fixture.path, "AGENTS.md"));
    await git(fixture.path, ["rm", "AGENTS.md"]);
    await git(fixture.path, ["commit", "-m", "Remove project instructions"]);
    await writeFile(join(fixture.path, "shared.md"), "Local instructions\n");
    await symlink(join(fixture.path, "shared.md"), join(fixture.path, "AGENTS.md"));
    assert.deepEqual((await protection.inspect(fixture.path)).protectedPaths, ["AGENTS.md"]);
  } finally {
    await fixture.close();
  }
});

test("a local Agent symlink cannot be included as if it were a real project file", async () => {
  const fixture = await createRepository();
  const protection = new GitCommitProtection({ rules });
  try {
    await writeFile(join(fixture.path, "shared.md"), "Local instructions\n");
    await symlink(join(fixture.path, "shared.md"), join(fixture.path, "AGENTS.md"));
    const inspection = await protection.inspect(fixture.path);
    assert.deepEqual(inspection.localSymlinkPaths, ["AGENTS.md"]);
    await assert.rejects(
      () => protection.resolve(fixture.path, { decision: "include" }),
      (error) => error?.code === "GIT_LOCAL_AGENT_SYMLINK_NOT_COMMITTABLE"
    );
    await git(fixture.path, ["config", "--local", "corptie.privateFilesWarning", "false"]);
    await assert.rejects(
      () => protection.resolve(fixture.path),
      (error) => error?.code === "GIT_LOCAL_AGENT_SYMLINK_NOT_COMMITTABLE"
    );
  } finally {
    await fixture.close();
  }
});

test("do not remind preference is stored per repository", async () => {
  const fixture = await createRepository();
  const protection = new GitCommitProtection({ rules });
  try {
    await mkdir(join(fixture.path, ".corptie"));
    await writeFile(join(fixture.path, ".corptie", "local.json"), "{}\n");
    await protection.resolve(fixture.path, { decision: "include", neverRemind: true });
    const inspection = await protection.inspect(fixture.path);
    assert.equal(inspection.warningEnabled, false);
    assert.equal(inspection.requiresDecision, false);
    assert.deepEqual(inspection.protectedPaths, [".corptie/local.json"]);
  } finally {
    await fixture.close();
  }
});

async function createRepository() {
  const path = await mkdtemp(join(tmpdir(), "corptie-commit-protection-"));
  await git(path, ["init", "-b", "main"]);
  await writeFile(join(path, "README.md"), "initial\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "Initial commit"]);
  return { path, close: () => rm(path, { recursive: true, force: true }) };
}

async function git(cwd, arguments_) {
  await execFileAsync("git", ["-C", cwd, ...arguments_], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Corptie Tests",
      GIT_AUTHOR_EMAIL: "tests@corptie.local",
      GIT_COMMITTER_NAME: "Corptie Tests",
      GIT_COMMITTER_EMAIL: "tests@corptie.local"
    }
  });
}
