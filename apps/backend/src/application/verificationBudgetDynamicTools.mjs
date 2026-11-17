export const verificationBudgetDynamicTools = [{ type: "function", name: "corptie_verification", deferLoading: false,
  description: "Run one coordinated verification batch after ALL development and test-code edits for the instruction are complete. First get the shared instruction budget. get also returns related original budgets; budget:null means this instruction has no recorded runs, not that funds are missing. An executionId on get is a read-only lookup and cannot change the run root. Budget limits are off unless the user enables them; run records one round, retrying the same executionId never re-executes. Collect failures and fix together before the next round. Native Shell is not blocked by this entry; do not claim global enforcement or bypass exhausted budgets. Each command defaults to a 120-second timeout, configurable with timeoutSeconds. Outputs remain in the ordinary tool result. Only the user can extend a budget.",
  inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["get", "run"] }, executionId: { type: "string", minLength: 1, maxLength: 512 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
    developmentComplete: { type: "boolean" }, commands: { type: "array", minItems: 1, maxItems: 20,
      items: { type: "object", additionalProperties: false, required: ["file", "args"], properties: {
        file: { type: "string", minLength: 1, maxLength: 4096 }, args: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 16000 } }
      } } }
  }, allOf: [{ if: { properties: { action: { const: "run" } }, required: ["action"] },
    then: { required: ["executionId", "developmentComplete", "commands"] } }] }
}];

export function callVerificationBudgetTool(service, input) {
  const args = input.arguments ?? {};
  if (args.action === "get") {
    return { ...service.inspect(input.context,args), defaultLimit:service.defaultLimit(),defaultEnabled:service.defaultEnabled(),
      workflow: "整条指令及其子任务的开发代码与测试代码全部完成后，统一提交 run；不要逐模块运行验证。原生 Shell 未受强制限制。" };
  }
  if (args.action !== "run") throw Object.assign(new Error("VERIFICATION_ACTION_INVALID"), { statusCode: 400 });
  return service.execute(input.context, args);
}
