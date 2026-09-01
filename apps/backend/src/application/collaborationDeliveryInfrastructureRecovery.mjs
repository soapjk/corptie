import { historicalProviderSessionUnavailable } from "./taskSessionRepairPolicy.mjs";

export function recoverCollaborationDeliveriesAfterCodexRolloutRepair(options = {}) {
  const core = options.core;
  const store = options.store;
  if (!core || !store) throw new TypeError("Collaboration core and store are required.");

  const logger = options.logger ?? console;
  const repairedThreadIds = new Set(
    (options.rolloutPathRepair?.repairs ?? [])
      .map((repair) => String(repair?.id ?? "").trim())
      .filter(Boolean)
  );
  const recovered = [];
  for (const threadId of repairedThreadIds) {
    const providerSessionId = `codex:${threadId}`;
    const failedTasks = store.listAgentTasksForSession(providerSessionId, { statuses: ["failed"] });
    for (const task of failedTasks) {
      if (task.kind !== "collaboration" || !task.deliveryId
          || !historicalProviderSessionUnavailable(task.lastError)) continue;
      const delivery = core.getDelivery(task.deliveryId);
      if (delivery?.status !== "failed"
          || !historicalProviderSessionUnavailable(delivery.lastError)) continue;

      const retried = core.retryDeliveryAfterInfrastructureRepair(
        delivery.deliveryId,
        "codex_rollout_path_relocated"
      );
      if (!retried) continue;
      store.updateAgentTask(task.taskId, {
        status: "queued",
        startedAt: null,
        completedAt: null,
        targetTurnId: null,
        lastError: null
      });
      logger.warn?.(
        `[collaboration-recovery] event=delivery_requeued deliveryId=${delivery.deliveryId} `
        + `providerSessionId=${providerSessionId} reason=codex_rollout_path_relocated`
      );
      recovered.push({ delivery: retried, taskId: task.taskId, providerSessionId });
    }
  }
  return recovered;
}
