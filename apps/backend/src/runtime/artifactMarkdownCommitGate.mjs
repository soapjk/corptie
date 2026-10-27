import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

// Shared by the real index gate and read-only, prospective commit review.
// readBytes is lazy: ordinary source files and existing documents are not read.
export async function inspectArtifactDocumentEntry({path,mode,objectId=null,repositoryPath,headPaths,readBytes}, verifyPromotion) {
  if (path.split("/").some(part=>part.normalize("NFC").toLowerCase()===".corptie"))
    return {violation:{path,code:"GIT_CORPTIE_CONTENT_FORBIDDEN"}};
  const markdown=/\.md$/i.test(path);
  if (!(markdown || /\.(?:pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|epub)$/i.test(path)) || headPaths.has(path)) return null;
  if (!["100644","100755"].includes(mode)) return {violation:{path,code:markdown ? "GIT_MARKDOWN_NOT_REGULAR" : "GIT_DOCUMENT_NOT_REGULAR"}};
  const bytes=await readBytes();
  const contentHash=createHash("sha256").update(bytes).digest("hex");
  const fixed={repositoryPath,path,contentHash,objectId};
  return await verifyPromotion(fixed)===true ? {verified:fixed}
    : {violation:{path,code:markdown ? "GIT_MARKDOWN_PROMOTION_REQUIRED" : "GIT_DOCUMENT_PROMOTION_REQUIRED"},contentHash,byteLength:bytes.byteLength};
}

// The resolver is supplied by the trusted Artifact service, never by tool
// arguments or repository-local JSON. It must validate durable promotion and
// direct-user authorization evidence for this exact repository/path/hash.
export async function inspectArtifactMarkdownCommit(cwd, { verifyPromotion = async () => false, indexPath = null } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  if (indexPath) env.GIT_INDEX_FILE = indexPath;
  const git = async (...args) => (await run("git", ["-C", cwd, ...args], {
    env, encoding: "buffer", timeout: 10000, maxBuffer: 32 * 1024 * 1024
  })).stdout;
  const repositoryPath = await realpath((await git("rev-parse", "--show-toplevel")).toString().trim());
  const index = await git("ls-files", "--stage", "-z");
  let headPaths = new Set();
  let head = null;
  try { head = (await git("rev-parse", "--verify", "HEAD")).toString().trim(); }
  catch (error) { if (error.code !== 128) throw error; }
  if (head) headPaths = new Set((await git("ls-tree", "-r", "--name-only", "-z", head)).toString().split("\0").filter(Boolean));
  const violations = [];
  const verified = [];
  for (const entry of index.toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, objectId, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (tab < 0 || stage !== "0") { violations.push({ path, code: "GIT_INDEX_UNMERGED" }); continue; }
    const result=await inspectArtifactDocumentEntry({path,mode,objectId,repositoryPath,headPaths,readBytes:()=>git("cat-file","blob",objectId)},verifyPromotion);
    if(result?.violation) violations.push(result.violation);
    if(result?.verified) verified.push(result.verified);
  }
  // A concurrent git add must not turn a previously checked receipt into
  // evidence for a different index. The caller must check again at commit.
  if (!(await git("ls-files", "--stage", "-z")).equals(index)) violations.push({ code: "GIT_INDEX_CHANGED" });
  return { ok: violations.length === 0, repositoryPath, head, verified, violations,
    indexHash: createHash("sha256").update(index).digest("hex") };
}

export async function assertArtifactMarkdownCommit(cwd, options) {
  const result = await inspectArtifactMarkdownCommit(cwd, options);
  if (!result.ok) throw Object.assign(new Error("Artifact document commit policy rejected the staged tree."), {
    code: "GIT_ARTIFACT_POLICY_REJECTED", details: result
  });
  return result;
}
