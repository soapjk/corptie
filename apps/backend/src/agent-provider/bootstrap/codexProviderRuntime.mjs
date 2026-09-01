import { CodexAppServerClient } from "../../adapters/codexAppServer.mjs";

export class CodexProviderRuntime {
  constructor(options = {}) {
    this.client = options.client ?? new CodexAppServerClient(options);
  }

  get notifications() { return this.client.notifications; }

  initialize(...args) { return this.client.initialize(...args); }
  bindThreadToolContext(...args) { return this.client.bindThreadToolContext(...args); }
  confirmThreadToolPlan(...args) { return this.client.confirmThreadToolPlan(...args); }
  restoreThreadToolPlanConfirmation(...args) { return this.client.restoreThreadToolPlanConfirmation(...args); }
  close(...args) { return this.client.close(...args); }
  deleteThread(...args) { return this.client.deleteThread(...args); }
  execResumeThread(...args) { return this.client.execResumeThread(...args); }
  ensureThreadResumed(...args) { return this.client.ensureThreadResumed(...args); }
  forkThread(...args) { return this.client.forkThread(...args); }
  interruptTurn(...args) { return this.client.interruptTurn(...args); }
  inspectEmptyThreadForRouteCommit(...args) { return this.client.inspectEmptyThreadForRouteCommit(...args); }
  liveItemsForThread(...args) { return this.client.liveItemsForThread(...args); }
  readAccountRateLimits(...args) { return this.client.readAccountRateLimits(...args); }
  readThreadForLegacyHistoryRepair(...args) { return this.client.readThreadForLegacyHistoryRepair(...args); }
  respondToApproval(...args) { return this.client.respondToApproval(...args); }
  resumeThread(...args) { return this.client.resumeThread(...args); }
  runEphemeralPrompt(...args) { return this.client.runEphemeralPrompt(...args); }
  setThreadName(...args) { return this.client.setThreadName(...args); }
  startThread(...args) { return this.client.startThread(...args); }
  startTurn(...args) { return this.client.startTurn(...args); }
  tokenUsageForThread(...args) { return this.client.tokenUsageForThread(...args); }
  updateThreadSettings(...args) { return this.client.updateThreadSettings(...args); }
}

export function createCodexProviderRuntime(options = {}) {
  return new CodexProviderRuntime(options);
}
