import { benchmarkError } from "./canonical.mjs";

export function createArtifactEvidencePort(artifactService) {
  return {
    async readPinned(entry, { scope }) {
      const context = { kind: "worker", actorId: scope.logicalSessionId, sessionId: scope.logicalSessionId, objectiveId: scope.objectiveId, taskId: scope.taskId };
      const result = await artifactService.readPinnedEvidence(context, entry.artifactId, { version: entry.version });
      if (!result?.content) throw benchmarkError("BENCHMARK_DEPENDENCY_CONTRACT_MISMATCH", "Pinned Artifact returned no content.", "manifest");
      return result;
    }
  };
}
