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

export const workItemAcceptanceDynamicTools = Object.freeze([
  tool(
    "corptie_work_item_report_acceptance",
    "Report a criterion-by-criterion acceptance assessment for the WorkItem bound to this Session. Call only after verification. A passed criterion requires reproducible evidence; Session completion alone is never evidence.",
    {
      results: {
        type: "array",
        minItems: 1,
        items: result,
        description: "Results for every current WorkItem acceptance criterion, exactly once and in the original order."
      }
    },
    ["results"]
  )
]);

export async function callWorkItemAcceptanceDynamicTool(reportAcceptance, input = {}) {
  if (input.tool !== "corptie_work_item_report_acceptance") {
    const error = new Error(`Unsupported WorkItem acceptance tool: ${input.tool}`);
    error.code = "HOST_TOOL_UNSUPPORTED";
    throw error;
  }
  const actorId = String(input.actorId ?? input.agentId ?? "").trim();
  if (!actorId) {
    const error = new Error("The WorkItem acceptance tool requires an authenticated Agent identity.");
    error.code = "AGENT_REQUIRED";
    throw error;
  }
  if (typeof reportAcceptance !== "function") {
    const error = new Error("WorkItem acceptance reporting is unavailable.");
    error.code = "WORK_ITEM_ACCEPTANCE_UNAVAILABLE";
    throw error;
  }
  return reportAcceptance(actorId, input.arguments ?? {});
}
