import { historicalProviderSessionUnavailable } from "./workItemSessionRepairPolicy.mjs";

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
    const failedWorkItems = store.listAgentWorkItemsForSession(providerSessionId, { statuses: ["failed"] });
    for (const workItem of failedWorkItems) {
      if (workItem.kind !== "collaboration" || !workItem.deliveryId
          || !historicalProviderSessionUnavailable(workItem.lastError)) continue;
      const delivery = core.getDelivery(workItem.deliveryId);
      if (delivery?.status !== "failed"
          || !historicalProviderSessionUnavailable(delivery.lastError)) continue;

      const retried = core.retryDeliveryAfterInfrastructureRepair(
        delivery.deliveryId,
        "codex_rollout_path_relocated"
      );
      if (!retried) continue;
      store.updateAgentWorkItem(workItem.workItemId, {
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
      recovered.push({ delivery: retried, workItemId: workItem.workItemId, providerSessionId });
    }
  }
  return recovered;
}
