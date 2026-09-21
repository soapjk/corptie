import { DatabaseSync } from "node:sqlite";
import { assertArtifactMarkdownCommit } from "./artifactMarkdownCommitGate.mjs";

let database;
try {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error("Artifact evidence database is required.");
  database = new DatabaseSync(dbPath, { readOnly: true });
  const query = database.prepare(`SELECT p.authorization_json FROM artifact_repository_promotions p
    JOIN artifacts a ON a.artifact_id=p.artifact_id AND a.status='active'
    JOIN artifact_versions v ON v.artifact_id=p.artifact_id AND v.version=p.version AND v.content_hash=p.content_hash
    WHERE p.repository_path=? AND p.target_path=? AND p.content_hash=?`);
  await assertArtifactMarkdownCommit(process.cwd(), {
    indexPath: process.env.GIT_INDEX_FILE,
    verifyPromotion: ({ repositoryPath, path, contentHash }) => query.all(repositoryPath, path, contentHash)
      .some(row => { const evidence = JSON.parse(row.authorization_json); return Boolean(evidence.eventId && evidence.sessionId && evidence.turnId && evidence.path === path); })
  });
} catch (error) {
  process.stderr.write(`Corptie Artifact commit gate: ${error.code ?? "UNAVAILABLE"}: ${error.message}\n`);
  for (const item of error.details?.violations ?? []) process.stderr.write(`${item.code}: ${JSON.stringify(item.path ?? "")}\n`);
  process.exitCode = 1;
} finally { database?.close(); }
