import { mkdir, readdir, stat, writeFile, unlink } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

/** Device-selected bytes only. No client-controlled host destination path. */
export function inspectorFileImporter({ store, references, artifacts }) {
  return async (scope, action, input) => {
    if (typeof input.dataBase64 !== "string" || input.dataBase64.length > 12 * 1024 * 1024
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw deviceError("INVALID_DOCUMENT", 400);
    const data = Buffer.from(input.dataBase64, "base64");
    if (!data.length || data.length > 8 * 1024 * 1024) throw deviceError("DOCUMENT_TOO_LARGE", 413);
    const root = join(store.dataRoot, "client-reference-files",
      createHash("sha256").update(scope.sessionId).digest("hex"));
    await mkdir(root, { recursive: true });
    const files = await readdir(root);
    const total = (await Promise.all(files.map(file => stat(join(root, file))))).reduce((sum, info) => sum + info.size, 0);
    if (files.length >= 512 || total + data.length > 128 * 1024 * 1024) throw deviceError("DOCUMENT_QUOTA_EXCEEDED", 413);
    const name = basename(String(input.fileName ?? "document.txt")).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 160) || "document.txt";
    const path = join(root, `${randomUUID()}-${name}`);
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
    let retain = false;
    try {
      if (action === "reference.import") {
        const reference = await references.create(scope.sessionId, { targetType: "localFile", locator: path, displayName: name });
        retain = true; return { referenceId: reference.referenceId };
      }
      if (!scope.workId) throw deviceError("WORK_REQUIRED", 409);
      const result = await artifacts.importLocalFile(scope.context, { path, title: input.title || name,
        mimeType: ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv",
          ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" })[extname(name).toLowerCase()] ?? "application/octet-stream",
        visibility: scope.task ? "task_private" : "work_private", boundTaskId: scope.task?.id });
      // importLocalFile returns the same Artifact descriptor plus an import receipt.
      const artifact = result.artifact ?? result;
      if (scope.task) {
        try { artifacts.createReference(scope.context, artifact.artifactId, {
          taskId: scope.task.id, relation: "implementation_spec", required: false, versionPolicy: "fixed"
        }); } catch { throw deviceError("ARTIFACT_CREATED_REFERENCE_UNCERTAIN", 500); }
      }
      return { artifactId: artifact.artifactId };
    } finally { if (!retain) await unlink(path).catch(() => {}); }
  };
}
