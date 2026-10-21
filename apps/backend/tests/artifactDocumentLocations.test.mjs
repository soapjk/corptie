import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertArtifactExportOutsideProjects, materializeArtifactBytes } from "../src/application/artifactMaterialization.mjs";
import { ARTIFACT_RUNTIME_POLICY } from "../src/application/artifactRuntimePolicy.mjs";

test("document policy covers binary deliverables and intermediate files, not just Markdown", () => {
  for (const word of ["PDF", "DOCX", "PPTX", "XLSX", "HTML", "intermediate", ".corptie/artifacts/", "outputs/"]) assert.ok(ARTIFACT_RUNTIME_POLICY.includes(word), word);
  assert.match(ARTIFACT_RUNTIME_POLICY, /outside every project/);
  assert.match(ARTIFACT_RUNTIME_POLICY, /successful Artifact import is not Git-tracking authorization/);
});

test("export blocks project document outputs, unregistered repositories and symlink aliases before allocation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "artifact-document-boundary-")));
  const repository = join(root, "repo");
  const nonGit = join(root, "office");
  try {
    await mkdir(repository);
    await mkdir(nonGit);
    execFileSync("git", ["-C", repository, "init", "--quiet"]);
    const deny = destinationPath => assert.rejects(assertArtifactExportOutsideProjects({ destinationPath, projectRoots: [nonGit] }), { code: "ARTIFACT_PROJECT_EXPORT_FORBIDDEN" });
    for (const target of ["report.pdf", "outputs/report.docx", "output/report.html", ".corptie/artifacts/report.pdf"]) await deny(join(repository, target));
    await deny(join(nonGit, "outputs/report.xlsx"));
    await symlink(repository, join(root, "alias"));
    await deny(join(root, "alias", "new", "report.pdf"));
    await mkdir(join(root, "repo-copy"));
    await assertArtifactExportOutsideProjects({ destinationPath: join(root, "repo-copy", "report.pdf"), projectRoots: [repository] });
    await assertArtifactExportOutsideProjects({ destinationPath: join(root, "download", "report.pdf"), projectRoots: [nonGit] });
    assert.deepEqual(await readdir(nonGit), []);
    assert.deepEqual(await readdir(repository), [".git"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("linked Git Worktrees are project directories even without a registered Workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "artifact-document-worktree-")));
  try {
    const main = join(root, "main"), linked = join(root, "linked");
    await mkdir(main);
    const git = (...args) => execFileSync("git", ["-C", main, ...args], { stdio: "pipe" });
    git("init", "--quiet");
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture");
    git("worktree", "add", "--detach", linked);
    await assert.rejects(assertArtifactExportOutsideProjects({ destinationPath: join(linked, "outputs", "report.pdf") }), { code: "ARTIFACT_PROJECT_EXPORT_FORBIDDEN" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialization cannot use arbitrary .corptie subdirectories as a document output", () => {
  for (const relativePath of ["outputs/report.pdf", "report.docx", "runtime/report.pdf", "artifacts/../report.pdf", "artifacts//report.pdf"]) {
    assert.throws(() => materializeArtifactBytes({ cwd: "/unused", relativePath, content: Buffer.from("test") }), { code: "ARTIFACT_PATH_INVALID" });
  }
});
