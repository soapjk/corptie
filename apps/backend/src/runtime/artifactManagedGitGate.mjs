import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertArtifactMarkdownCommit } from "./artifactMarkdownCommitGate.mjs";

const run = promisify(execFile);

// Provider-neutral policy at Corptie's Git boundary. No repository hook or DB
// is installed; promotion resolution is lazy and supplied by ArtifactService.
export async function assertManagedArtifactGitOperation(cwd, args = ["commit"], options = {}) {
  if (args.some(arg => ["--abort", "--quit", "--skip"].includes(arg))) return;
  if (args[0] !== "merge") return assertArtifactMarkdownCommit(cwd, options);
  if (args.includes("--no-commit") && args.includes("--no-ff")) return; // the later commit checks the actual index
  const refs = args.slice(1).filter(arg => !arg.startsWith("-"));
  if (refs.length !== 1) throw new Error("Managed merge requires exactly one source ref.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = async (...arguments_) => (await run("git", ["-C", cwd, ...arguments_], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
  // merge-tree leaves the real index/worktree untouched, including on conflicts.
  let tree;
  try { tree = (await git("merge-tree", "--write-tree", "HEAD", refs[0])).split("\n")[0]; }
  catch (error) { if (error.code === 1) return; throw error; } // conflicted merge cannot commit
  const temporary = await mkdtemp(join(tmpdir(), "corptie-git-policy-"));
  try {
    const indexPath = join(temporary, "index");
    await run("git", ["-C", cwd, "read-tree", tree], { env: { ...env, GIT_INDEX_FILE: indexPath } });
    return await assertArtifactMarkdownCommit(cwd, { ...options, indexPath });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
