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
