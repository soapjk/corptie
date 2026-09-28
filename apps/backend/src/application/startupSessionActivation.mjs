export async function activateStartupSessions({
  store, storedSessionsAtStartup, developmentPreview, environmentName,
  corptieCodexRuntimePaths, corptieClaudeRuntimePaths,
  ensureAgentWorkDir, ensureCollaborationAgentForSession,
  publishProviderEventOutbox, workspaceContinuationCoordinator,
  providerEventPublisher, feishuGateway, taskSummaryService,
  configureChoiceParserRuntime, seedSessions, runtimeActivity,
  enableMockSessions
}) {
  // Native Provider processes inherit isolated Corptie runtime homes.
  process.env.CODEX_HOME = corptieCodexRuntimePaths.codexHome;
  process.env.CLAUDE_CONFIG_DIR = corptieClaudeRuntimePaths.configDir;

  for (const agent of developmentPreview ? [] : store.listAgents()) {
    try {
      await ensureAgentWorkDir(agent, { environmentName });
    } catch (error) {
      console.warn(`[agent-workdir] failed to ensure work dir for ${agent.agentId}: ${error?.message ?? error}`);
    }
  }
  for (const session of developmentPreview ? [] : storedSessionsAtStartup) {
    ensureCollaborationAgentForSession(session);
  }
  // Re-delivery consumes Corptie's committed Outbox, never Provider history.
  if (!developmentPreview) {
    publishProviderEventOutbox(store.listPendingEventOutbox(500));
    workspaceContinuationCoordinator.recover();
  }
  providerEventPublisher.addSessionEventListener((event) => feishuGateway.handleSessionEvent(event));
  providerEventPublisher.addSessionEventListener((event) => taskSummaryService.onSessionEvent(event));
  if (!developmentPreview) configureChoiceParserRuntime({
    ...(store.settings().choiceParser ?? {}),
    agentProxy: store.settings().agentProxy
  });
  if (!developmentPreview && enableMockSessions) {
    seedSessions();
    runtimeActivity.startMockTimer();
  }
}
