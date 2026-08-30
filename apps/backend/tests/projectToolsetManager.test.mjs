import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  PROJECT_TOOLSET_ACTIONS,
  ProjectToolsetManager
} from "../src/runtime/projectToolsetManager.mjs";
import { RunIsolationExecutionCoordinator } from "../src/runIsolation/runIsolationExecutionCoordinator.mjs";
import { RunIsolationAuthorityResolver } from "../src/runIsolation/runIsolationAuthorityResolver.mjs";
import { fixture as runIsolationFixture, prepareInput, toolsetFixture } from "./runIsolationTestHelpers.mjs";

const execFileAsync = promisify(execFile);

test("inspect reports a main Worktree toolset symlink without following a link loop", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  const toolsetPath = join(fixture.mainPath, ".corptie");
  try {
    await symlink(toolsetPath, toolsetPath);
    const state = await manager.inspect(fixture.featurePath);
    assert.equal(state.installed, false);
    assert.equal(state.configured, false);
    assert.match(state.configurationError, /\.corptie path is a symbolic link/);
    assert.ok(Object.values(state.scripts).every((script) => script.exists === false));
  } finally {
    await fixture.close();
  }
});

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

test("Toolset-owned receipt resolver exposes only the exact receipt requested by Run v6", async () => {
  const fixture = await createFixture();
  const receipt = { receiptId: "toolset_validation_receipt:run_v6", schemaVersion: 3 };
  const manager = new ProjectToolsetManager({ validationReceiptResolver: async (receiptId) => receiptId === receipt.receiptId ? receipt : null });
  try {
    await manager.scaffold(fixture.mainPath);
    assert.deepEqual(await manager.resolveValidationReceipt(fixture.featurePath, receipt.receiptId), receipt);
    assert.equal(await manager.resolveValidationReceipt(fixture.featurePath, "toolset_validation_receipt:missing"), null);
    assert.equal(await manager.resolveValidationReceipt(fixture.featurePath, "../escape"), null);
  } finally {
    await fixture.close();
  }
});

test("mutating and validation actions fail closed without server-owned RunIsolation authority", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    await manager.scaffold(fixture.mainPath);
    await manager.markConfigured(fixture.mainPath);
    for (const action of ["build", "start", "restart", "stop", "verify"]) {
      await assert.rejects(() => manager.run(fixture.mainPath, action, { sourceIdentity: { revision: "test", fingerprint: "f".repeat(64), dirty: false } }), { code: "DEPENDENCY_CONTRACT_UNRESOLVED" });
    }
  } finally {
    await fixture.close();
  }
});

test("production manager composition executes a Toolset action through Run v6 and parses its bounded output", async (t) => {
  const project = await createFixture();
  t.after(() => project.close());
  const { service } = await runIsolationFixture(t);
  const coordinator = new RunIsolationExecutionCoordinator({ service });
  let toolsetReceipt = null;
  const manager = new ProjectToolsetManager({ runIsolationCoordinator: coordinator, validationReceiptResolver: async (receiptId) => receiptId === toolsetReceipt?.receiptId ? toolsetReceipt : null });
  const state = await manager.scaffold(project.mainPath);
  await writeFile(state.scripts.build.path, "#!/bin/sh\nprintf '%s\\n' '{\"schemaVersion\":2,\"action\":\"build\",\"ok\":true,\"artifactId\":\"artifact:test\"}'\n");
  await chmod(state.scripts.build.path, 0o700);
  await manager.markConfigured(project.mainPath);
  const workspace = await import("../src/utils/gitWorktreeInventory.mjs").then(({ inspectGitWorkspace }) => inspectGitWorkspace(project.mainPath));
  const authority = { logicalSessionId: "logical:test", workItemId: "work_item:test", repositoryId: workspace.repositoryId, worktreeId: workspace.worktreeId };
  const toolset = toolsetFixture({ receiptId: "toolset_validation_receipt:production", authority });
  toolsetReceipt = toolset.receipt;
  const request = { ...authority, action: "build", bindingId: "binding:production", bindingGeneration: 1 };
  const authorityResolver = new RunIsolationAuthorityResolver({ resolveAuthority: async (input) => ({ logicalSessionId: input.logicalSessionId, workItemId: input.workItemId, repositoryId: input.repositoryId, worktreeId: input.worktreeId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration, startupBindingReceiptRef: prepareInput().startupBindingReceiptRef, repositorySourceSnapshotReceiptRef: toolset.snapshotRef, toolsetValidationReceiptPointer: toolset.pointer }) });
  const resolved = await authorityResolver.resolve(request);
  const result = await manager.run(project.mainPath, "build", { sourceIdentity: { revision: "test", fingerprint: toolset.snapshotRef.sourceFingerprint, dirty: false }, runIsolation: { session: authority, prepare: prepareInput({ sourceAware: true, toolsetRequired: true, ...resolved, idempotencyKey: "production-manager-build" }) } });
  assert.equal(result.ok, true);
  assert.equal(result.payload.artifactId, "artifact:test");
  assert.equal(result.runIsolation.runReceipt.schemaVersion, 6);
  assert.equal(result.runIsolation.cleanupReceipt.schemaVersion, 4);
  assert.equal(result.runIsolation.finalState, "cleaned");
});

test("run can restart the service from a selected worktree", async () => {
  const fixture = await createFixture();
  const manager = isolatedManager();
  try {
    const state = await manager.scaffold(fixture.mainPath);
    await writeFile(
      state.scripts.restart.path,
      "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$PWD\" \"$CORPTIE_PROJECT_ROOT\" \"$CORPTIE_MAIN_PROJECT_ROOT\" > \"$CORPTIE_TOOLSET_ROOT/runtime/invocation\"\nprintf '%s\\n' '{\"schemaVersion\":1,\"action\":\"restart\",\"ok\":true}'\n"
    );
    await chmod(state.scripts.restart.path, 0o700);
    await manager.markConfigured(fixture.mainPath);

    const result = await manager.run(fixture.mainPath, "restart", {
      executionRoot: fixture.featurePath,
      sourceIdentity: await manager.sourceIdentity(fixture.featurePath),
      runIsolation: TEST_RUN_AUTHORITY
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
  const manager = isolatedManager();
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

    const result = await manager.activateLatest(fixture.mainPath, { runIsolation: TEST_RUN_AUTHORITY });
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
  const manager = isolatedManager();
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

    const result = await manager.activateLatest(fixture.mainPath, { runIsolation: TEST_RUN_AUTHORITY });
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

test("source identity ignores a gitignored .corptie directory without failing staging", async () => {
  const fixture = await createFixture();
  const manager = new ProjectToolsetManager();
  try {
    await writeFile(join(fixture.mainPath, ".gitignore"), "/.corptie/\n");
    await git(["add", ".gitignore"], fixture.mainPath);
    await git(["commit", "-m", "ignore private Corptie tools"], fixture.mainPath);
    await mkdir(join(fixture.mainPath, ".corptie"));
    await writeFile(join(fixture.mainPath, ".corptie", "local.json"), "{\"version\":1}\n");

    const clean = await manager.sourceIdentity(fixture.mainPath);
    assert.equal(clean.dirty, false);
    assert.match(clean.fingerprint, /^[0-9a-f]{40}$/);

    await writeFile(join(fixture.mainPath, "proposal.md"), "proposal\n");
    const withSourceChange = await manager.sourceIdentity(fixture.mainPath);
    await writeFile(join(fixture.mainPath, ".corptie", "local.json"), "{\"version\":2}\n");
    const withPrivateToolChange = await manager.sourceIdentity(fixture.mainPath);

    assert.equal(withSourceChange.dirty, true);
    assert.equal(withPrivateToolChange.fingerprint, withSourceChange.fingerprint);
    assert.equal((await gitOutput(["diff", "--cached", "--name-only"], fixture.mainPath)).trim(), "");
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

const TEST_RUN_AUTHORITY = Object.freeze({ prepare: Object.freeze({ idempotencyKey: "test-authority" }), session: Object.freeze({ logicalSessionId: "logical:test", workItemId: "work_item:test" }) });

function isolatedManager() {
  return new ProjectToolsetManager({
    runIsolationCoordinator: {
      async runCommand({ descriptor }) {
        try {
          const result = await execFileAsync(descriptor.executable, descriptor.args ?? [], { cwd: descriptor.cwd, encoding: "utf8", env: { ...process.env, ...descriptor.environment } });
          return { runReceipt: { outcome: "passed", error: null }, cleanupReceipt: { schemaVersion: 4, outcome: "cleaned" }, finalState: "cleaned", commandOutput: `${result.stdout ?? ""}${result.stderr ?? ""}` };
        } catch (error) {
          return { runReceipt: { outcome: "failed", error: { message: error.message } }, cleanupReceipt: { schemaVersion: 4, outcome: "retained" }, finalState: "cleaning", commandOutput: `${error.stdout ?? ""}${error.stderr ?? ""}` };
        }
      }
    }
  });
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
