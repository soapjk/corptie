import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectArtifactMarkdownCommit, assertArtifactMarkdownCommit } from "../src/runtime/artifactMarkdownCommitGate.mjs";

test("real Git index gate permits existing Markdown but requires exact evidence for new documents", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "markdown-gate-")));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "--quiet");
    await writeFile(join(root, "README.md"), "existing");
    git("add", "README.md");
    assert.equal((await inspectArtifactMarkdownCommit(root)).violations[0].code, "GIT_MARKDOWN_PROMOTION_REQUIRED");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
    await writeFile(join(root, "README.md"), "edited");
    git("add", "README.md");
    assert.equal((await inspectArtifactMarkdownCommit(root)).ok, true);
    const path = "new\nreport.MD";
    await writeFile(join(root, path), "approved");
    git("add", "--", path);
    await assert.rejects(() => assertArtifactMarkdownCommit(root), { code: "GIT_ARTIFACT_POLICY_REJECTED" });
    const hash = createHash("sha256").update("approved").digest("hex");
    const verifyPromotion = async item => item.repositoryPath === root && item.path === path && item.contentHash === hash;
    assert.equal((await inspectArtifactMarkdownCommit(root, { verifyPromotion })).ok, true);
    await writeFile(join(root, path), "not staged");
    assert.equal((await inspectArtifactMarkdownCommit(root, { verifyPromotion })).ok, true);
    git("add", "--", path);
    assert.equal((await inspectArtifactMarkdownCommit(root, { verifyPromotion })).ok, false);
    await mkdir(join(root, ".CoRpTiE"));
    await writeFile(join(root, ".CoRpTiE", "secret.bin"), "private");
    git("add", "--force", ".CoRpTiE/secret.bin");
    assert.ok((await inspectArtifactMarkdownCommit(root, { verifyPromotion: async () => true })).violations.some(v => v.code === "GIT_CORPTIE_CONTENT_FORBIDDEN"));
    await symlink("README.md", join(root, "link.md"));
    git("add", "link.md");
    assert.ok((await inspectArtifactMarkdownCommit(root, { verifyPromotion: async () => true })).violations.some(v => v.code === "GIT_MARKDOWN_NOT_REGULAR"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new PDF and Office files require exact staged-byte tracking evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "binary-document-gate-")));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "--quiet");
    const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255]);
    for (const path of ["report.PDF", "report.docx", "report.pptx", "report.xlsx"]) {
      await writeFile(join(root, path), content);
      git("add", "--", path);
    }
    const blocked = await inspectArtifactMarkdownCommit(root);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.violations.length, 4);
    assert.ok(blocked.violations.every(v => v.code === "GIT_DOCUMENT_PROMOTION_REQUIRED"));
    const contentHash = createHash("sha256").update(content).digest("hex");
    const approvedPaths = new Set(["report.PDF", "report.docx", "report.pptx", "report.xlsx"]);
    const verifyPromotion = async item => item.repositoryPath === root && approvedPaths.has(item.path) && item.contentHash === contentHash;
    assert.equal((await inspectArtifactMarkdownCommit(root, { verifyPromotion })).ok, true);
    await writeFile(join(root, "report.PDF"), "unstaged edit");
    assert.equal((await inspectArtifactMarkdownCommit(root, { verifyPromotion })).ok, true);
    git("add", "report.PDF");
    assert.equal((await inspectArtifactMarkdownCommit(root, { verifyPromotion })).ok, false);
    await writeFile(join(root, "report.PDF"), content);
    git("add", "report.PDF");
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--no-gpg-sign", "-m", "fixture");
    await writeFile(join(root, "report.PDF"), "edit existing tracked document");
    git("add", "report.PDF");
    assert.equal((await inspectArtifactMarkdownCommit(root)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
