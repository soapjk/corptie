function tool(name, description, properties, required = []) {
  return Object.freeze({
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  });
}

const evidence = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    reference: {
      type: "string",
      minLength: 1,
      description: "A reproducible command, local artifact URI, or file/result locator that lets the user verify the evidence."
    }
  },
  required: ["summary", "reference"]
};

const result = {
  type: "object",
  additionalProperties: false,
  properties: {
    criterion: { type: "string", minLength: 1 },
    verdict: { type: "string", enum: ["passed", "failed", "unknown"] },
    evidence: { type: "array", items: evidence }
  },
  required: ["criterion", "verdict", "evidence"]
};

export const taskAcceptanceDynamicTools = Object.freeze([
  tool(
    "corptie_task_report_acceptance",
    "Report a criterion-by-criterion acceptance assessment for the Task bound to this Session. Call only after verification. A passed criterion requires reproducible evidence; Session completion alone is never evidence.",
    {
      results: {
        type: "array",
        minItems: 1,
        items: result,
        description: "Results for every current Task acceptance criterion, exactly once and in the original order."
      }
    },
    ["results"]
  ),
  tool(
    "corptie_task_complete",
    "Complete one exact Task only when the current direct user message explicitly requests it. Supply the authoritative logical Session, user-message event, sequence, and current turn evidence shown in Corptie turn context. Assistant/system/collaboration/Automation evidence is rejected.",
    {
      targetTaskId: { type: "string", minLength: 1 },
      objectiveId: { type: "string", minLength: 1 },
      logicalSessionId: { type: "string", minLength: 1 },
      userMessageEventId: { type: "string", minLength: 1 },
      userMessageSequence: { type: "integer", minimum: 1 },
      turnId: { type: "string", minLength: 1 },
      requestId: { type: "string", minLength: 1 },
      idempotencyKey: { type: "string", minLength: 1 }
    },
    ["targetTaskId", "objectiveId", "logicalSessionId", "userMessageEventId",
      "userMessageSequence", "turnId", "requestId", "idempotencyKey"]
  ),
  tool(
    "corptie_task_revise",
    "Evolve the Task bound to this Session after the user switches to a new problem. Corptie atomically snapshots the previous Task definition and replaces the current title, goal, acceptance criteria, and verification criteria without creating another Task.",
    {
      expectedRevision: { type: "integer", minimum: 1 },
      next: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          goal: { type: "string" },
          acceptanceCriteria: { type: "string" },
          verificationCriteria: { type: "string" }
        },
        minProperties: 1
      },
      executionSummary: { type: "string" },
      completionEvidence: { type: "array", items: evidence },
      sourceMessageId: { type: "string", minLength: 1 }
    },
    ["expectedRevision", "next"]
  )
]);

export async function callTaskAcceptanceDynamicTool(handlers, input = {}) {
  if (!["corptie_task_report_acceptance", "corptie_task_complete", "corptie_task_revise"].includes(input.tool)) {
    const error = new Error(`Unsupported Task acceptance tool: ${input.tool}`);
    error.code = "HOST_TOOL_UNSUPPORTED";
    throw error;
  }
  const actorId = String(input.actorId ?? input.agentId ?? "").trim();
  if (!actorId) {
    const error = new Error("The Task acceptance tool requires an authenticated Agent identity.");
    error.code = "AGENT_REQUIRED";
    throw error;
  }
  const reportAcceptance = typeof handlers === "function" ? handlers : handlers?.reportAcceptance;
  const completeTask = typeof handlers === "object" ? handlers?.completeTask : null;
  const reviseTask = typeof handlers === "object" ? handlers?.reviseTask : null;
  const operation = input.tool === "corptie_task_complete"
    ? completeTask
    : input.tool === "corptie_task_revise"
      ? reviseTask
      : reportAcceptance;
  if (typeof operation !== "function") {
    const error = new Error("Task acceptance reporting is unavailable.");
    error.code = "TASK_ACCEPTANCE_UNAVAILABLE";
    throw error;
  }
  return operation(actorId, input.arguments ?? {}, input.metadata ?? {});
}
