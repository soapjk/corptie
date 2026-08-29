import assert from "node:assert/strict";
import test from "node:test";
import { registerGitRepository } from "../src/application/gitRepositoryRegistrationService.mjs";

test("Git initialization failure is explicit and never registers a repository", async () => {
  let upsertCount = 0;
  let snapshotAttempts = 0;
  const store = {
    upsertGitWorkspaceSnapshot() { upsertCount += 1; },
    listGitRepositories() { return []; }
  };

  await assert.rejects(
    registerGitRepository({
      dirPath: "/selected/plain-folder",
      initializeIfNeeded: true,
      store,
      inspectPath: async () => ({ isDirectory: () => true }),
      createSnapshot: async () => {
        snapshotAttempts += 1;
        throw new Error("not a repository");
      },
      run: async () => {
        const error = new Error("git init failed");
        error.stderr = "permission denied";
        throw error;
      }
    }),
    (error) => {
      assert.equal(error.code, "GIT_INITIALIZATION_FAILED");
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /permission denied/);
      return true;
    }
  );
  assert.equal(snapshotAttempts, 1);
  assert.equal(upsertCount, 0);
});
