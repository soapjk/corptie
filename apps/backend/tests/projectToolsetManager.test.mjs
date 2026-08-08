import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  PROJECT_TOOLSET_ACTIONS,
  ProjectToolsetManager
} from "../src/runtime/projectToolsetManager.mjs";

const execFileAsync = promisify(execFile);

test("scaffold creates a private standard toolset in the main worktree", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager({ now: () => "2026-08-06T00:00:00.000Z" });
  try {
    const state = await manager.scaffold(fixture.featurePath);
    assert.equal(state.mainPath, await realpath(fixture.mainPath));
    assert.equal(state.installed, true);
    assert.equal(state.configured, false);
    assert.deepEqual(Object.keys(state.scripts), PROJECT_TOOLSET_ACTIONS);
    assert.ok(Object.values(state.scripts).every((script) => script.executable));
    assert.match((await gitOutput(["status", "--short"], fixture.mainPath)).trim(), /^\?\? \.corptie\/$/);
    assert.equal(await gitSucceeds(["check-ignore", ".corptie/toolset.json"], fixture.mainPath), false);
  } finally {
    await fixture.close();
  }
});

test("scaffold preserves customized scripts without changing private Git excludes", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const first = await manager.scaffold(fixture.mainPath);
    const startPath = first.scripts.start.path;
    await writeFile(startPath, "#!/bin/sh\nprintf 'custom\\n'\n");
    await chmod(startPath, 0o700);
    await manager.scaffold(fixture.mainPath);
    assert.equal(await readFile(startPath, "utf8"), "#!/bin/sh\nprintf 'custom\\n'\n");
    assert.equal(await gitSucceeds(["check-ignore", ".corptie/toolset.json"], fixture.mainPath), false);
  } finally {
    await fixture.close();
  }
});

test("run enforces configuration and parses the standard JSON contract", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    await assert.rejects(() => manager.run(fixture.mainPath, "status"), /not configured/);
    await writeFile(
      state.scripts.status.path,
      "#!/bin/sh\nprintf '%s\\n' '{\"schemaVersion\":1,\"action\":\"status\",\"ok\":true,\"running\":true,\"pid\":42}'\n"
    );
    await chmod(state.scripts.status.path, 0o700);
    await manager.markConfigured(fixture.mainPath);
    const result = await manager.run(fixture.featurePath, "status");
    assert.equal(result.ok, true);
    assert.equal(result.payload.running, true);
    assert.equal(result.payload.pid, 42);
  } finally {
    await fixture.close();
  }
});

test("run can restart the service from a selected worktree", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    await writeFile(
      state.scripts.restart.path,
      "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$PWD\" \"$CORPTIE_PROJECT_ROOT\" \"$CORPTIE_MAIN_PROJECT_ROOT\" > \"$CORPTIE_TOOLSET_ROOT/runtime/invocation\"\nprintf '%s\\n' '{\"schemaVersion\":1,\"action\":\"restart\",\"ok\":true}'\n"
    );
    await chmod(state.scripts.restart.path, 0o700);
    await manager.markConfigured(fixture.mainPath);

    const result = await manager.run(fixture.mainPath, "restart", {
      executionRoot: fixture.featurePath
    });

    assert.equal(result.ok, true);
    const invocation = (await readFile(join(state.runtimePath, "invocation"), "utf8"))
      .trim()
      .split("\n");
    assert.deepEqual(invocation, [
      await realpath(fixture.featurePath),
      await realpath(fixture.featurePath),
      await realpath(fixture.mainPath)
    ]);
  } finally {
    await fixture.close();
  }
});

test("an older configured toolset requires an explicit update and can only be probed", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    await writeFile(state.manifestPath, `${JSON.stringify({
      ...state.manifest,
      schemaVersion: 1,
      configured: true
    }, null, 2)}\n`);
    await writeFile(
      state.scripts.status.path,
      "#!/bin/sh\nprintf '%s\\n' '{\"schemaVersion\":1,\"action\":\"status\",\"ok\":true,\"running\":true}'\n"
    );
    await chmod(state.scripts.status.path, 0o700);

    const inspected = await manager.inspect(fixture.mainPath);
    assert.equal(inspected.configured, false);
    assert.equal(inspected.manifestConfigured, true);
    assert.equal(inspected.requiresUpdate, true);
    await assert.rejects(() => manager.run(fixture.mainPath, "restart"), /not configured/);
    const probe = await manager.run(fixture.mainPath, "status", { allowIncompatible: true });
    assert.equal(probe.payload.running, true);
  } finally {
    await fixture.close();
  }
});

test("service profiles are selected locally and passed to every toolset action", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    await writeFile(state.manifestPath, `${JSON.stringify({
      ...state.manifest,
      profiles: [
        { id: "local", label: "Local", description: "Local mode" },
        { id: "gateway", label: "Gateway", description: "Gateway OAuth mode" }
      ],
      selectedProfile: "local"
    }, null, 2)}\n`);
    await manager.markConfigured(fixture.mainPath);
    const selected = await manager.selectProfile(fixture.mainPath, "gateway");
    assert.equal(selected.selectedProfile, "gateway");
    await writeFile(
      selected.scripts.status.path,
      "#!/bin/sh\nprintf '{\"schemaVersion\":2,\"action\":\"status\",\"ok\":true,\"profile\":\"%s\"}\\n' \"$CORPTIE_SERVICE_PROFILE\"\n"
    );
    await chmod(selected.scripts.status.path, 0o700);
    const result = await manager.run(fixture.mainPath, "status");
    assert.equal(result.payload.profile, "gateway");
  } finally {
    await fixture.close();
  }
});

test("activation builds before restart and verifies the exact artifact, source, and profile", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    const scripts = {
      build: "#!/bin/sh\nprintf 'build\\n' >> \"$CORPTIE_TOOLSET_ROOT/runtime/order\"\nprintf '{\"schemaVersion\":2,\"action\":\"build\",\"ok\":true,\"revision\":\"%s\",\"sourceFingerprint\":\"%s\",\"profile\":\"%s\",\"artifactId\":\"artifact-%s\"}\\n' \"$CORPTIE_SOURCE_REVISION\" \"$CORPTIE_SOURCE_FINGERPRINT\" \"$CORPTIE_SERVICE_PROFILE\" \"$CORPTIE_SOURCE_FINGERPRINT\"\n",
      restart: "#!/bin/sh\nprintf 'restart\\n' >> \"$CORPTIE_TOOLSET_ROOT/runtime/order\"\nprintf '%s\\n' '{\"schemaVersion\":2,\"action\":\"restart\",\"ok\":true}'\n",
      status: "#!/bin/sh\nprintf '%s\\n' '{\"schemaVersion\":2,\"action\":\"status\",\"ok\":true,\"running\":true}'\n",
      health: "#!/bin/sh\nprintf '%s\\n' '{\"schemaVersion\":2,\"action\":\"health\",\"ok\":true,\"healthy\":true}'\n",
      verify: "#!/bin/sh\nprintf '{\"schemaVersion\":2,\"action\":\"verify\",\"ok\":true,\"verified\":true,\"profile\":\"%s\"}\\n' \"$CORPTIE_SERVICE_PROFILE\"\n",
      version: "#!/bin/sh\nprintf '{\"schemaVersion\":2,\"action\":\"version\",\"ok\":true,\"verified\":true,\"revision\":\"%s\",\"sourceFingerprint\":\"%s\",\"profile\":\"%s\",\"artifactId\":\"artifact-%s\"}\\n' \"$CORPTIE_SOURCE_REVISION\" \"$CORPTIE_SOURCE_FINGERPRINT\" \"$CORPTIE_SERVICE_PROFILE\" \"$CORPTIE_SOURCE_FINGERPRINT\"\n"
    };
    for (const [action, contents] of Object.entries(scripts)) {
      await writeFile(state.scripts[action].path, contents);
      await chmod(state.scripts[action].path, 0o700);
    }
    await manager.markConfigured(fixture.mainPath);

    const result = await manager.activateLatest(fixture.mainPath);
    assert.equal(result.ok, true);
    assert.equal(result.stage, "complete");
    assert.deepEqual(
      (await readFile(join(state.runtimePath, "order"), "utf8")).trim().split("\n"),
      ["build", "restart"]
    );
  } finally {
    await fixture.close();
  }
});

test("a failed build never restarts the existing service", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    await writeFile(
      state.scripts.build.path,
      "#!/bin/sh\nprintf '%s\\n' '{\"schemaVersion\":2,\"action\":\"build\",\"ok\":false,\"error\":\"build failed\"}'\nexit 1\n"
    );
    await writeFile(
      state.scripts.restart.path,
      "#!/bin/sh\ntouch \"$CORPTIE_TOOLSET_ROOT/runtime/restarted\"\nprintf '%s\\n' '{\"schemaVersion\":2,\"action\":\"restart\",\"ok\":true}'\n"
    );
    await chmod(state.scripts.build.path, 0o700);
    await chmod(state.scripts.restart.path, 0o700);
    await manager.markConfigured(fixture.mainPath);

    const result = await manager.activateLatest(fixture.mainPath);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "build");
    await assert.rejects(() => readFile(join(state.runtimePath, "restarted")), /ENOENT/);
  } finally {
    await fixture.close();
  }
});

test("revision details report the verified commit time and source Worktree branch", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    const revision = (await gitOutput(["rev-parse", "HEAD"], fixture.featurePath)).trim();
    const details = await manager.revisionDetails(fixture.mainPath, revision, fixture.featurePath);
    assert.equal(details.branch, "feature/test");
    assert.match(details.commitTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  } finally {
    await fixture.close();
  }
});

test("scaffold refuses a repository that already tracks .corptie content", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    await mkdir(join(fixture.mainPath, ".corptie"));
    await writeFile(join(fixture.mainPath, ".corptie", "public.txt"), "tracked\n");
    await git(["add", ".corptie/public.txt"], fixture.mainPath);
    await git(["commit", "-m", "track conflicting corptie directory"], fixture.mainPath);
    await assert.rejects(
      () => manager.scaffold(fixture.mainPath),
      /contains Git-tracked files/
    );
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-project-toolset-"));
  const mainPath = join(directory, "repo");
  const featurePath = join(directory, "feature");
  await mkdir(mainPath);
  await git(["init", "-b", "main"], mainPath);
  await git(["commit", "--allow-empty", "-m", "initial"], mainPath);
  await git(["worktree", "add", "-b", "feature/test", featurePath, "HEAD"], mainPath);
  return {
    directory,
    mainPath,
    featurePath,
    async close() {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function git(arguments_, cwd) {
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

async function gitOutput(arguments_, cwd) {
  return execFileAsync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" }).then((result) => result.stdout);
}

async function gitSucceeds(arguments_, cwd) {
  try {
    await execFileAsync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}
