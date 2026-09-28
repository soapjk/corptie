// Codex approval wire decisions and display projection, without transport state.
export function isApprovalServerRequest(request) {
  const params = request.params ?? {};
  return Boolean(params.approvalId) || /approval/i.test(request.method ?? "");
}

export function mapServerRequestToItem(threadId, request) {
  if (!isApprovalServerRequest(request)) {
    return null;
  }
  const params = request.params ?? {};
  const command = typeof params.command === "string" ? params.command.trim() : "";
  const cwd = typeof params.cwd === "string" ? params.cwd.trim() : (typeof params.workdir === "string" ? params.workdir.trim() : "");
  const reason = typeof params.reason === "string" ? params.reason.trim() : (typeof params.justification === "string" ? params.justification.trim() : "");
  const body = [
    command ? `Codex wants approval to run this command:\n${command}` : "Codex wants approval to run a command.",
    cwd ? `Working directory:\n${cwd}` : "",
    reason ? `Reason:\n${reason}` : ""
  ].filter(Boolean).join("\n\n");

  return {
    id: `${threadId}:app-server-approval:${params.requestId ?? params.approvalId}`,
    turnId: params.turnId ?? threadId,
    turnStatus: "waiting_approval",
    type: "approval",
    title: "Codex approval",
    text: body,
    options: approvalOptionsForRequest(request),
    status: "pending",
    createdAt: params.createdAt ?? null
  };
}

function approvalOptionsForRequest(request) {
  const decisions = Array.isArray(request.params?.availableDecisions) ? request.params.availableDecisions : [];
  const approveDecision = approvalOptionIdForDecision(preferredApprovalDecision(decisions));
  const denyDecision = decisions.includes("cancel") ? "cancel" : (decisions.includes("denied") ? "denied" : "deny");
  const options = [
    { id: approveDecision, label: approveDecision === "approved_for_session" ? "Approve for session" : "Approve", role: "approve", index: 0, selected: false },
    { id: denyDecision, label: "Deny", role: "deny", index: 1, selected: false }
  ];
  return options;
}

export function approvalDecisionForRequest(request, optionId = "") {
  const decisions = Array.isArray(request.params?.availableDecisions) ? request.params.availableDecisions : [];
  if (optionId === "accept_with_execpolicy_amendment") {
    const amendmentDecision = decisions.find((decision) => {
      return decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment;
    });
    if (amendmentDecision) {
      return amendmentDecision;
    }
  }
  if (optionId && decisions.some((decision) => decision === optionId)) {
    return optionId;
  }
  return preferredApprovalDecision(decisions) ?? "approved";
}

export function denialDecisionForRequest(request) {
  const decisions = Array.isArray(request.params?.availableDecisions) ? request.params.availableDecisions : [];
  return decisions.includes("cancel") ? "cancel" : (decisions.includes("denied") ? "denied" : "deny");
}

export function approvedCommandKey(threadId, request) {
  const params = request.params ?? {};
  const commandName = approvedCommandName(params);
  if (!commandName || commandName !== "ps") {
    return null;
  }
  const turnId = params.turnId ?? "";
  if (!turnId) {
    return null;
  }
  return `${threadId}:${turnId}:${commandName}`;
}

function approvedCommandName(params) {
  const amendment = Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : [];
  if (typeof amendment[0] === "string" && amendment[0].trim()) {
    return commandBasename(amendment[0]);
  }
  const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
  for (const action of actions) {
    const name = firstShellCommandName(action?.command);
    if (name) {
      return name;
    }
  }
  return firstShellCommandName(params.command);
}

function firstShellCommandName(command) {
  if (typeof command !== "string") {
    return null;
  }
  const withoutWrapper = command.match(/(?:^|\s)(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])(.*?)\1/)?.[2] ?? command;
  const firstSegment = withoutWrapper.split("|")[0]?.trim() ?? "";
  const firstToken = firstSegment.match(/(?:^|\s)([^\s]+)/)?.[1] ?? "";
  return commandBasename(firstToken);
}

function commandBasename(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return text.split("/").pop();
}

function preferredApprovalDecision(decisions) {
  const amendmentDecision = decisions.find((decision) => {
    return decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment;
  });
  if (amendmentDecision) {
    return amendmentDecision;
  }
  return decisions.find((decision) => decision === "accept")
    ?? decisions.find((decision) => typeof decision === "string" && /^approved/.test(decision))
    ?? null;
}

function approvalOptionIdForDecision(decision) {
  if (decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment) {
    return "accept_with_execpolicy_amendment";
  }
  if (typeof decision === "string" && decision) {
    return decision;
  }
  return "approved";
}
