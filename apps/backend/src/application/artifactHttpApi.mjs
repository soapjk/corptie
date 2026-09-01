export function handleArtifactHttpRequest({ request, response, url, service, requestTimeoutMs = 5_000 }) {
  const path = url.pathname;
  const isArtifactApi = path === "/artifacts" || path.startsWith("/artifacts/")
    || /^\/objectives\/[^/]+\/artifacts(?:\/(?:backup|restore))?$/.test(path)
    || /^\/tasks\/[^/]+\/artifacts(?:\/[^/]+\/publish)?$/.test(path);
  if (!isArtifactApi) return false;

  const timeout = setTimeout(() => {
    sendJson(response, 503, {
      code: "ARTIFACT_REQUEST_TIMEOUT",
      error: "Artifact request did not complete within the server deadline."
    });
  }, requestTimeoutMs);
  Promise.resolve().then(async () => {
    const objectiveBackup = path.match(/^\/objectives\/([^/]+)\/artifacts\/backup$/);
    if (request.method === "POST" && objectiveBackup) {
      const objectiveId = decodeURIComponent(objectiveBackup[1]);
      const input = await readJson(request);
      return sendJson(response, 200, await service.backupObjective(localContext(objectiveId), {
        destinationPath: input.destinationPath, confirmed: input.confirmed
      }));
    }
    const objectiveRestore = path.match(/^\/objectives\/([^/]+)\/artifacts\/restore$/);
    if (request.method === "POST" && objectiveRestore) {
      const objectiveId = decodeURIComponent(objectiveRestore[1]);
      const input = await readJson(request);
      return sendJson(response, 200, await service.restoreObjective(localContext(objectiveId), {
        sourcePath: input.sourcePath, confirmed: input.confirmed
      }));
    }
    const objectiveList = path.match(/^\/objectives\/([^/]+)\/artifacts$/);
    if (objectiveList) {
      const objectiveId = decodeURIComponent(objectiveList[1]);
      const context = localContext(objectiveId);
      if (request.method === "GET") return sendJson(response, 200, { artifacts: service.list(context, { includeRevoked: url.searchParams.get("includeRevoked") === "true" }) });
      if (request.method === "POST") {
        const input = await readJson(request);
        const artifact = input.importPath
          ? await service.importLocalFile(context, { ...mapInput(input), path: input.importPath })
          : await service.create(context, mapInput(input));
        return sendJson(response, 201, artifact);
      }
    }

    const taskList = path.match(/^\/tasks\/([^/]+)\/artifacts$/);
    if (request.method === "GET" && taskList) {
      const taskId = decodeURIComponent(taskList[1]);
      const task = service.store.getTask(taskId);
      if (!task) throw httpError("ARTIFACT_TASK_NOT_FOUND", "Task not found.", 404);
      const context = localContext(task.objective_id);
      const limit = boundedQueryInteger(url, "limit", 1, 200, 100);
      const offset = boundedQueryInteger(url, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
      const artifacts = service.listForTask(context, taskId, { limit, offset });
      const totalCount = service.store.countArtifactsReferencedByTask(taskId);
      const nextOffset = offset + artifacts.length < totalCount ? offset + artifacts.length : null;
      return sendJson(response, 200, { artifacts, totalCount, nextOffset });
    }

    const taskPublish = path.match(/^\/tasks\/([^/]+)\/artifacts\/([^/]+)\/publish$/);
    if (request.method === "POST" && taskPublish) {
      const taskId = decodeURIComponent(taskPublish[1]);
      const artifactId = decodeURIComponent(taskPublish[2]);
      const task = service.store.getTask(taskId);
      if (!task) throw httpError("ARTIFACT_TASK_NOT_FOUND", "Task not found.", 404);
      const input = await readJson(request);
      return sendJson(response, 201, await service.publishAndRepin(
        localContext(task.objective_id), artifactId,
        { ...mapInput(input), taskId, referenceId: input.referenceId,
          expectedResourceVersion: input.expectedResourceVersion,
          expectedPinnedVersion: input.expectedPinnedVersion,
          expectedPinnedHash: input.expectedPinnedHash,
          idempotencyKey: input.idempotencyKey }
      ));
    }

    const artifactMatch = path.match(/^\/artifacts\/([^/]+)$/);
    if (artifactMatch) {
      const artifactId = decodeURIComponent(artifactMatch[1]);
      const artifact = service.store.getArtifact(artifactId);
      if (!artifact) throw httpError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
      const context = localContext(artifact.objectiveId);
      if (request.method === "GET") {
        return sendJson(response, 200, await service.get(context, artifactId, {
          version: numberParam(url, "version"), contentHash: url.searchParams.get("contentHash"),
          referenceId: url.searchParams.get("referenceId"),
          offset: numberParam(url, "offset"), limit: numberParam(url, "limit"),
          format: url.searchParams.get("format") ?? undefined,
          turnExecutionId: url.searchParams.get("turnExecutionId") ?? `macos-artifact-read:${Date.now()}`
        }));
      }
      if (request.method === "PATCH") {
        const input = await readJson(request);
        if (input.visibility) return sendJson(response, 200, service.changeVisibility(context, artifactId, input.visibility, { confirmed: input.confirmed === true }));
        if (input.status === "superseded") return sendJson(response, 200, service.supersede(context, artifactId));
        if (input.status === "revoked") return sendJson(response, 200, service.revokeArtifact(context, artifactId, input.reason));
        throw httpError("ARTIFACT_INVALID_INPUT", "A supported visibility or status change is required.", 400);
      }
    }

    const versionsMatch = path.match(/^\/artifacts\/([^/]+)\/versions$/);
    if (request.method === "POST" && versionsMatch) {
      const artifactId = decodeURIComponent(versionsMatch[1]);
      const artifact = requiredArtifact(service, artifactId);
      return sendJson(response, 201, await service.publishVersion(localContext(artifact.objectiveId), artifactId, mapInput(await readJson(request))));
    }

    const referencesMatch = path.match(/^\/artifacts\/([^/]+)\/references$/);
    if (request.method === "POST" && referencesMatch) {
      const artifactId = decodeURIComponent(referencesMatch[1]);
      const artifact = requiredArtifact(service, artifactId);
      const input = await readJson(request);
      return sendJson(response, 201, service.createReference(localContext(artifact.objectiveId), artifactId, {
        taskId: input.taskId, sessionId: input.sessionId, relation: input.relation,
        required: input.required, versionPolicy: input.versionPolicy, version: input.version
      }));
    }

    const revokeReferenceMatch = path.match(/^\/artifacts\/references\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revokeReferenceMatch) {
      const referenceId = decodeURIComponent(revokeReferenceMatch[1]);
      const reference = service.store.getArtifactReference(referenceId);
      if (!reference) throw httpError("ARTIFACT_REFERENCE_NOT_FOUND", "Artifact reference not found.", 404);
      const input = await readJson(request);
      return sendJson(response, 200, service.revokeReference(localContext(reference.objectiveId), referenceId, input.reason));
    }

    const acknowledgeMatch = path.match(/^\/artifacts\/references\/([^/]+)\/acknowledge-update$/);
    if (request.method === "POST" && acknowledgeMatch) {
      const referenceId = decodeURIComponent(acknowledgeMatch[1]);
      const reference = service.store.getArtifactReference(referenceId);
      if (!reference) throw httpError("ARTIFACT_REFERENCE_NOT_FOUND", "Artifact reference not found.", 404);
      const input = await readJson(request);
      if (input.confirmed !== true) throw httpError("ARTIFACT_CONFIRMATION_REQUIRED", "Acknowledging a version impact requires explicit confirmation.", 409);
      return sendJson(response, 200, service.acknowledgePendingReference(localContext(reference.objectiveId), referenceId));
    }

    const integrityMatch = path.match(/^\/artifacts\/([^/]+)\/integrity$/);
    if (request.method === "GET" && integrityMatch) {
      return sendJson(response, 200, await service.verifyIntegrity(decodeURIComponent(integrityMatch[1])));
    }

    const localFileMatch = path.match(/^\/artifacts\/([^/]+)\/local-file$/);
    if (request.method === "GET" && localFileMatch) {
      const artifactId = decodeURIComponent(localFileMatch[1]);
      const artifact = requiredArtifact(service, artifactId);
      return sendJson(response, 200, await service.localFile(
        localContext(artifact.objectiveId),
        artifactId,
        {
          version: numberParam(url, "version"),
          contentHash: url.searchParams.get("contentHash"),
          referenceId: url.searchParams.get("referenceId")
        }
      ));
    }

    const exportMatch = path.match(/^\/artifacts\/([^/]+)\/export$/);
    if (request.method === "POST" && exportMatch) {
      const artifactId = decodeURIComponent(exportMatch[1]);
      const artifact = requiredArtifact(service, artifactId);
      const input = await readJson(request);
      return sendJson(response, 200, await service.exportArtifact(localContext(artifact.objectiveId), artifactId, {
        destinationPath: input.destinationPath, version: input.version,
        contentHash: input.contentHash, referenceId: input.referenceId, confirmed: input.confirmed,
        confirmedRepositoryWrite: input.confirmedRepositoryWrite, confirmedOverwrite: input.confirmedOverwrite
      }));
    }

    throw httpError("ARTIFACT_ROUTE_NOT_FOUND", "Artifact route not found.", 404);
  }).catch((error) => sendJson(response, error.statusCode ?? 500, { code: error.code ?? "INTERNAL", error: error.message }))
    .finally(() => clearTimeout(timeout));
  return true;
}

function localContext(objectiveId) { return { kind: "local_user", actorId: "macos-local-user", objectiveId }; }
function requiredArtifact(service, artifactId) { const artifact = service.store.getArtifact(artifactId); if (!artifact) throw httpError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404); return artifact; }
function mapInput(input) {
  return {
    artifactId: input.artifactId, title: input.title, summary: input.summary, content: input.content,
    visibility: input.visibility, boundTaskId: input.boundTaskId, boundSessionId: input.boundSessionId,
    repositoryLocator: input.repositoryLocator, confirmedRepositoryTracked: input.confirmedRepositoryTracked,
    mimeType: input.mimeType, approvalStatus: input.approvalStatus, sourceEventId: input.sourceEventId,
    expectedResourceVersion: input.expectedResourceVersion,
    expectedPinnedVersion: input.expectedPinnedVersion,
    expectedPinnedHash: input.expectedPinnedHash, idempotencyKey: input.idempotencyKey,
    referenceId: input.referenceId
  };
}
function numberParam(url, name) { const value = url.searchParams.get(name); return value == null ? undefined : Number(value); }
function boundedQueryInteger(url, name, min, max, fallback) {
  const value = url.searchParams.get(name);
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw httpError("ARTIFACT_INVALID_QUERY", `${name} must be an integer from ${min} to ${max}.`, 400);
  }
  return number;
}
function httpError(code, message, statusCode) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
function sendJson(response, statusCode, value) { if (response.writableEnded) return; response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
function readJson(request) { return new Promise((resolve, reject) => { const chunks = []; let length = 0; request.on("data", (chunk) => { length += chunk.length; if (length > 16 * 1024 * 1024) { reject(httpError("ARTIFACT_REQUEST_TOO_LARGE", "Artifact request exceeds 16 MiB.", 413)); request.destroy(); return; } chunks.push(chunk); }); request.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(httpError("ARTIFACT_INVALID_JSON", "Invalid JSON body.", 400)); } }); request.on("error", reject); }); }
