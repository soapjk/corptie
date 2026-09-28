// Status inspection must not silently execute build verification; verification
// is a separate authenticated RunIsolation action.
export function createProjectToolsetStatusReader({
  projectToolsets, readInitializationStatus, getProduction, runtimeSourceIdentity
}) {
  async function projectToolsetStatusForPath(cwd, options = {}) {
    const toolset = await projectToolsets.inspect(cwd);
    if (toolset.configurationError) {
      return {
        toolset,
        service: {
          state: "configurationFailed",
          configurationError: toolset.configurationError,
          freshness: "unknown",
          running: null,
          mainHeadOid: toolset.mainHeadOid,
          desiredProfile: toolset.selectedProfile,
          verified: false
        }
      };
    }
    if (toolset.requiresUpdate && toolset.manifestConfigured) {
      const legacySource = await projectToolsets.sourceIdentity(toolset.mainPath, toolset.runtimePath);
      const [status, health, version] = await Promise.all([
        projectToolsets.run(cwd, "status", { timeoutMs: 5_000, allowIncompatible: true, sourceIdentity: legacySource }),
        projectToolsets.run(cwd, "health", { timeoutMs: 5_000, allowIncompatible: true, sourceIdentity: legacySource }),
        projectToolsets.run(cwd, "version", { timeoutMs: 5_000, allowIncompatible: true, sourceIdentity: legacySource })
      ]);
      const running = status.payload?.running === true;
      return {
        toolset,
        service: {
          state: running ? "running" : "stopped",
          configurationError: null,
          freshness: running ? "toolsetUpdateRequired" : "stopped",
          running,
          healthy: health.payload?.healthy === true,
          mainHeadOid: toolset.mainHeadOid,
          runningRevision: version.payload?.revision ?? null,
          dirty: version.payload?.dirty === true,
          startedAt: version.payload?.startedAt ?? null,
          worktreePath: version.payload?.worktreePath ?? null,
          desiredProfile: toolset.selectedProfile,
          runningProfile: null,
          artifactId: null,
          sourceFingerprint: null,
          verified: false,
          verificationDetail: "Update the Corptie Scripts Tools Set to verify build artifacts and service profiles.",
          status,
          health,
          version
        }
      };
    }
    if (!toolset.configured) {
      const initialization = await readInitializationStatus(toolset.repositoryId, options.logicalSessionId ?? null);
      return {
        toolset,
        service: {
          state: initialization.state,
          configurationError: initialization.error,
          freshness: "unknown",
          running: null,
          mainHeadOid: toolset.mainHeadOid,
          desiredProfile: toolset.selectedProfile,
          verified: false
        }
      };
    }
    const desiredSource = options.logicalSessionId && getProduction()
      ? runtimeSourceIdentity((await getProduction().runtimeAuthority(options.logicalSessionId)).snapshot)
      : await projectToolsets.sourceIdentity(toolset.mainPath, toolset.runtimePath);
    const [status, health, version] = await Promise.all([
      projectToolsets.run(cwd, "status", { timeoutMs: 5_000, sourceIdentity: desiredSource }),
      projectToolsets.run(cwd, "health", { timeoutMs: 5_000, sourceIdentity: desiredSource }),
      projectToolsets.run(cwd, "version", { timeoutMs: 5_000, sourceIdentity: desiredSource })
    ]);
    const verify = { ok: false, action: "verify", payload: null, code: "DEPENDENCY_CONTRACT_UNRESOLVED", detail: "Verification requires an explicit authenticated RunIsolation action." };
    const running = status.payload?.running === true;
    const runningRevision = version.payload?.revision ?? null;
    const dirty = version.payload?.dirty === true;
    const verified = false;
    let revisionDetails = null;
    if (runningRevision) {
      try {
        revisionDetails = await projectToolsets.revisionDetails(
          cwd,
          runningRevision,
          version.payload?.worktreePath
        );
      } catch {
        revisionDetails = null;
      }
    }
    let freshness = "unknown";
    if (!running) {
      freshness = "stopped";
    } else if (!verified || !runningRevision) {
      freshness = "unverifiedBuild";
    } else if (version.payload?.profile !== toolset.selectedProfile
      || verify.payload?.profile !== toolset.selectedProfile) {
      freshness = "configurationMismatch";
    } else if (runningRevision !== desiredSource.revision
      || version.payload?.sourceFingerprint !== desiredSource.fingerprint) {
      freshness = "stale";
    } else if (health.payload?.healthy !== true) {
      freshness = "unhealthy";
    } else {
      freshness = "current";
    }
    return {
      toolset,
      service: {
        state: running ? "running" : "stopped",
        freshness,
        running,
        healthy: health.payload?.healthy === true,
        mainHeadOid: toolset.mainHeadOid,
        runningRevision,
        runningBranch: revisionDetails?.branch ?? null,
        runningCommitTime: revisionDetails?.commitTime ?? null,
        dirty,
        startedAt: version.payload?.startedAt ?? null,
        worktreePath: version.payload?.worktreePath ?? null,
        desiredProfile: toolset.selectedProfile,
        runningProfile: version.payload?.profile ?? null,
        artifactId: version.payload?.artifactId ?? null,
        sourceFingerprint: version.payload?.sourceFingerprint ?? null,
        verified,
        verificationDetail: verify.payload?.detail ?? null,
        status,
        health,
        verify,
        version
      }
    };
  }

  return { projectToolsetStatusForPath };
}
