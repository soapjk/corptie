import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWorkspacePath,
  sessionWorkspacePath
} from "../src/utils/workspacePaths.mjs";

test("the default workspace is stable and independent of the backend process directory", () => {
  assert.equal(
    defaultWorkspacePath({ environment: {}, home: "/Users/example" }),
    "/Users/example/corptie"
  );
});

test("an absolute configured default workspace is honored", () => {
  assert.equal(
    defaultWorkspacePath({
      environment: { CORPTIE_DEFAULT_WORKSPACE: "/Volumes/Work/projects" },
      home: "/Users/example"
    }),
    "/Volumes/Work/projects"
  );
});

test("a relative configured default cannot redirect sessions into the process directory", () => {
  assert.equal(
    defaultWorkspacePath({
      environment: { CORPTIE_DEFAULT_WORKSPACE: "Contents/Resources/backend" },
      home: "/Users/example"
    }),
    "/Users/example/corptie"
  );
});

test("session workspace paths must be absolute", () => {
  assert.throws(
    () => sessionWorkspacePath("Contents/Resources/backend"),
    (error) => error.code === "INVALID_WORKSPACE_PATH"
  );
});
