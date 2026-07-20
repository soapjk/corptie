export function handleCollaborationHttpRequest({ request, response, url, core, onConfirmationStaged, onConfirmationResolved }) {
  const isInternal = url.pathname.startsWith("/internal/collaboration/");
  const isProductApi = url.pathname === "/collaboration/overview"
    || url.pathname.startsWith("/collaboration/tasks/")
    || url.pathname.startsWith("/collaboration/confirmations/")
    || url.pathname === "/collaboration/services"
    || url.pathname.startsWith("/collaboration/services/")
    || url.pathname.startsWith("/collaboration/deliveries/");
  if (!isInternal && !isProductApi) return false;

  Promise.resolve()
    .then(async () => {
      if (isProductApi) {
        return handleProductRequest({ request, response, url, core, onConfirmationResolved });
      }
      const actorAgentId = requiredActor(request, core);

      if (request.method === "GET" && url.pathname === "/internal/collaboration/agents") {
        return sendJson(response, 200, {
          agents: core.listAgents({ status: url.searchParams.get("status") || undefined }),
          actorAgentId
        });
      }

      const agentMatch = url.pathname.match(/^\/internal\/collaboration\/agents\/([^/]+)$/);
      if (request.method === "GET" && agentMatch) {
        const agent = core.getAgent(decodeURIComponent(agentMatch[1]));
        if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent was not found.", 404);
        return sendJson(response, 200, { agent, actorAgentId });
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/services") {
        return sendJson(response, 200, {
          services: core.listServices({
            ownerAgentId: url.searchParams.get("ownerAgentId") || undefined,
            status: url.searchParams.get("status") || undefined
          })
        });
      }

      const serviceMatch = url.pathname.match(/^\/internal\/collaboration\/services\/([^/]+)$/);
      if (request.method === "GET" && serviceMatch) {
        const service = core.getService(decodeURIComponent(serviceMatch[1]));
        if (!service) throw apiError("SERVICE_NOT_FOUND", "Service was not found.", 404);
        return sendJson(response, 200, {
          service,
          consumers: core.listServiceConsumers(service.serviceId)
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/inbox") {
        const status = url.searchParams.getAll("status");
        return sendJson(response, 200, {
          tasks: core.listInbox(actorAgentId, {
            status: status.length ? status : undefined,
            limit: url.searchParams.get("limit")
          })
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/task-confirmations") {
        const input = await readJson(request);
        const actor = core.getAgent(actorAgentId);
        const runningWork = actor?.currentSessionId
          ? core.store.getRunningAgentWorkItemForSession(actor.currentSessionId)
          : null;
        const confirmation = core.proposeTask({
          ...input,
          initiatorAgentId: actorAgentId,
          sourceSessionId: actor?.currentSessionId,
          sourceTurnId: runningWork?.targetTurnId ?? null
        });
        await onConfirmationStaged?.(confirmation);
        return sendJson(response, 201, { confirmation });
      }

      // Kept for trusted internal callers and migration compatibility. The MCP
      // request tool uses task-confirmations so user-originated sends cannot
      // bypass the deterministic confirmation step.
      if (request.method === "POST" && url.pathname === "/internal/collaboration/tasks") {
        const input = await readJson(request);
        const task = core.createTask({ ...input, initiatorAgentId: actorAgentId });
        return sendJson(response, 201, { task });
      }

      const taskMatch = url.pathname.match(/^\/internal\/collaboration\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        const task = requireParticipant(core, decodeURIComponent(taskMatch[1]), actorAgentId);
        const includeHistory = url.searchParams.get("includeHistory") === "true";
        return sendJson(response, 200, {
          task: includeHistory ? task : compactTaskForActor(task, actorAgentId)
        });
      }

      const actionMatch = url.pathname.match(/^\/internal\/collaboration\/tasks\/([^/]+)\/actions\/([^/]+)$/);
      if (request.method === "POST" && actionMatch) {
        const taskId = decodeURIComponent(actionMatch[1]);
        const action = decodeURIComponent(actionMatch[2]);
        requireParticipant(core, taskId, actorAgentId);
        const input = await readJson(request);
        const task = performAction(core, taskId, actorAgentId, action, input);
        return sendJson(response, 200, { task });
      }

      throw apiError("NOT_FOUND", "Collaboration endpoint was not found.", 404);
    })
    .catch((error) => {
      sendJson(response, error.statusCode ?? statusForCode(error.code), {
        error: error.message,
        code: error.code ?? "COLLABORATION_ERROR"
      });
    });
  return true;
}

async function handleProductRequest({ request, response, url, core, onConfirmationResolved }) {
  if (request.method === "GET" && url.pathname === "/collaboration/overview") {
    return sendJson(response, 200, {
      agents: core.listAgents(),
      services: core.listServices(),
      tasks: core.listTasks({
        status: url.searchParams.getAll("status").length ? url.searchParams.getAll("status") : undefined,
        limit: url.searchParams.get("limit")
      })
    });
  }

  if (request.method === "POST" && url.pathname === "/collaboration/services") {
    const input = await readJson(request);
    return sendJson(response, 201, { service: core.registerService(input) });
  }

  const confirmationMatch = url.pathname.match(/^\/collaboration\/confirmations\/([^/]+)\/(confirm|reject)$/);
  if (request.method === "POST" && confirmationMatch) {
    const confirmationId = decodeURIComponent(confirmationMatch[1]);
    const action = confirmationMatch[2];
    const confirmation = onConfirmationResolved
      ? await onConfirmationResolved(confirmationId, action === "confirm", { type: "desktop" })
      : action === "confirm"
        ? core.confirmTaskConfirmation(confirmationId)
        : core.rejectTaskConfirmation(confirmationId);
    return sendJson(response, 200, { confirmation });
  }

  const serviceMatch = url.pathname.match(/^\/collaboration\/services\/([^/]+)$/);
  if (request.method === "PATCH" && serviceMatch) {
    const input = await readJson(request);
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const service = core.getService(serviceId);
    if (!service) throw apiError("SERVICE_NOT_FOUND", "Service was not found.", 404);
    return sendJson(response, 200, {
      service: core.updateService(serviceId, service.ownerAgentId, input)
    });
  }

  const taskMatch = url.pathname.match(/^\/collaboration\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const task = core.getTask(taskId);
    if (!task) throw apiError("TASK_NOT_FOUND", "Task was not found.", 404);
    return sendJson(response, 200, {
      task,
      deliveries: core.listDeliveriesForTask(taskId)
    });
  }

  const cancelMatch = url.pathname.match(/^\/collaboration\/tasks\/([^/]+)\/interventions\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const input = await readJson(request);
    return sendJson(response, 200, {
      task: core.cancelByUser(decodeURIComponent(cancelMatch[1]), input.reason)
    });
  }

  const retryMatch = url.pathname.match(/^\/collaboration\/deliveries\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    return sendJson(response, 200, {
      delivery: core.retryDeliveryByUser(decodeURIComponent(retryMatch[1]))
    });
  }

  throw apiError("NOT_FOUND", "Collaboration product endpoint was not found.", 404);
}

function performAction(core, taskId, actorAgentId, action, input) {
  switch (action) {
    case "accept": {
      const current = core.getTask(taskId);
      if (current?.status === "revision_requested") {
        return core.startWorking(taskId, actorAgentId);
      }
      const accepted = core.accept(taskId, actorAgentId);
      return core.startWorking(accepted.taskId, actorAgentId);
    }
    case "reject":
      return core.reject(taskId, actorAgentId, input.reason);
    case "ask":
      return core.askForInformation(taskId, actorAgentId, input.body, messageOptions(input));
    case "reply":
      return core.reply(taskId, actorAgentId, input.body, messageOptions(input));
    case "submit-result":
      return core.submitResult(taskId, actorAgentId, input);
    case "request-revision": {
      let task = core.getTask(taskId);
      if (task.status === "delivered") task = core.beginVerification(taskId, actorAgentId);
      return core.requestRevision(task.taskId, actorAgentId, input.body, messageOptions(input));
    }
    case "complete": {
      let task = core.getTask(taskId);
      if (task.status === "delivered") task = core.beginVerification(taskId, actorAgentId);
      return core.complete(task.taskId, actorAgentId, input.body, messageOptions(input));
    }
    case "cancel":
      return core.cancel(taskId, actorAgentId, input.reason);
    default:
      throw apiError("UNKNOWN_ACTION", `Unknown collaboration action: ${action}`, 404);
  }
}

function requiredActor(request, core) {
  const actorAgentId = String(request.headers["x-corptie-agent-id"] ?? "").trim();
  if (!actorAgentId) throw apiError("AGENT_ID_REQUIRED", "x-corptie-agent-id is required.", 401);
  if (!core.getAgent(actorAgentId)) throw apiError("AGENT_NOT_FOUND", `Agent ${actorAgentId} was not found.`, 403);
  return actorAgentId;
}

function requireParticipant(core, taskId, actorAgentId) {
  const task = core.getTask(taskId);
  if (!task) throw apiError("TASK_NOT_FOUND", `Task ${taskId} was not found.`, 404);
  if (![task.initiatorAgentId, task.recipientAgentId].includes(actorAgentId)) {
    throw apiError("ACTOR_NOT_AUTHORIZED", "Only task participants may view or modify this task.", 403);
  }
  return task;
}

function messageOptions(input) {
  return {
    evidence: input.evidence,
    resourceVersion: input.resourceVersion,
    idempotencyKey: input.idempotencyKey
  };
}

function compactTaskForActor(task, actorAgentId) {
  const role = actorAgentId === task.initiatorAgentId ? "initiator" : "recipient";
  const peerAgentId = role === "initiator" ? task.recipientAgentId : task.initiatorAgentId;
  const currentMessage = [...(task.messages ?? [])]
    .reverse()
    .find((message) => message.recipientAgentId === actorAgentId)
    ?? task.messages?.at(-1)
    ?? null;
  const latestArtifact = task.artifacts?.at(-1) ?? null;
  const compact = {
    taskId: task.taskId,
    role,
    peerAgentId,
    serviceId: task.serviceId,
    type: task.type,
    status: task.status,
    title: task.title,
    summary: task.summary,
    acceptanceCriteria: task.acceptanceCriteria,
    currentMessage: currentMessage ? compactMessage(currentMessage) : null,
    latestArtifact: latestArtifact ? compactArtifact(latestArtifact) : null,
    availableActions: availableActions(task, role)
  };
  if (task.iteration > 1 || ["revision_requested", "escalated"].includes(task.status)) {
    compact.iteration = task.iteration;
    compact.maxIterations = task.maxIterations;
  }
  return compact;
}

function compactMessage(message) {
  return compactObject({
    messageId: message.messageId,
    messageType: message.messageType,
    body: message.body,
    evidence: message.evidence?.length ? message.evidence : undefined,
    resourceVersion: message.resourceVersion ?? undefined,
    createdAt: message.createdAt
  });
}

function compactArtifact(artifact) {
  return {
    type: artifact.type,
    name: artifact.name,
    uri: artifact.uri,
    metadata: artifact.metadata
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function availableActions(task, role) {
  const terminal = ["completed", "rejected", "canceled", "escalated"].includes(task.status);
  if (terminal) return [];
  if (role === "recipient") {
    if (task.status === "proposed") return ["accept", "reject", "ask"];
    if (task.status === "working") return ["reply", "submit_result"];
    if (task.status === "revision_requested") return ["accept", "reply"];
    return ["reply"];
  }
  if (task.type === "question") {
    if (task.status === "needs_information") return ["reply", "cancel"];
    return ["cancel"];
  }
  if (task.status === "delivered" || task.status === "verifying") {
    return ["complete", "request_revision", "cancel"];
  }
  if (task.status === "needs_information") return ["reply", "cancel"];
  return ["reply", "cancel"];
}

function statusForCode(code) {
  if (["AGENT_NOT_FOUND", "SERVICE_NOT_FOUND", "TASK_NOT_FOUND", "DELIVERY_NOT_FOUND"].includes(code)) return 404;
  if (["ACTOR_NOT_AUTHORIZED", "SERVICE_OWNER_REQUIRED", "RECIPIENT_NOT_SERVICE_OWNER"].includes(code)) return 403;
  if (["INVALID_TASK_TRANSITION", "TASK_TERMINAL", "IDEMPOTENCY_CONFLICT", "QUESTION_FOLLOWUP_REQUIRES_NEW_TASK"].includes(code)) return 409;
  return 400;
}

function apiError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
