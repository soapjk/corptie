import { sessionWorkspacePath } from "../utils/workspacePaths.mjs";
import { defaultSessionTitleForWorkspace } from "../utils/sessionTitles.mjs";

export function createSessionCreationOperation({
  store, sessionApplicationService, sessionForkService, sessionTitleReservations,
  desiredToolDomainIds, assertDirectory, emitEvent, sendUnifiedSessionMessage
}) {
  const { reserveSessionTitle } = sessionTitleReservations;
  async function createSessionThroughApplication(providerId, input = {}, context = {}) {
    if (context.forkSource) {
      const reference = context.forkSource.reference;
      const materialization = store.getSessionToolCatalogMaterialization(reference.logicalSessionId, reference.bindingId);
      context = { ...context, desiredToolDomains: desiredToolDomainIds(materialization) };
    }
    const cwd = sessionWorkspacePath(input.cwd);
    await assertDirectory(cwd);
    const requestedTitle = typeof input.title === "string" ? input.title.trim() : "";
    const defaultTitle = typeof input.defaultTitle === "string" ? input.defaultTitle.trim() : "";
    const baseTitle = requestedTitle || defaultTitle || defaultSessionTitleForWorkspace(cwd);
    const title = requestedTitle && input.autoUniqueTitle !== true
      ? baseTitle
      : sessionTitleReservations.availableTitle(baseTitle);
    const {
      defaultTitle: _defaultTitle,
      autoUniqueTitle: _autoUniqueTitle,
      prompt: initialPromptValue,
      ...providerInput
    } = input;
    const prepared = {
      ...providerInput,
      cwd,
      title
    };
    const releaseTitle = reserveSessionTitle(title);
    try {
      const createdSession = await sessionApplicationService.createSession(providerId, prepared, context);
      if (context.forkSource) {
        const operationId = context.forkRequestId ?? sessionForkService.forTask(context.taskId)?.request_id;
        if (operationId) sessionForkService.recordTarget(operationId, createdSession.id);
      }
      const session = input.sessionKind
        ? (store.setSessionKind(createdSession.id, input.sessionKind, context.actorId) ?? {
            ...createdSession,
            sessionKind: input.sessionKind,
            agentId: context.actorId ?? null
          })
        : createdSession;
      emitEvent("SessionStarted", {
        session,
        provider: providerId,
        source: { type: context.source ?? "application" }
      });
      const initialPrompt = typeof initialPromptValue === "string" ? initialPromptValue.trim() : "";
      if (initialPrompt) {
        await sendUnifiedSessionMessage(session.id, initialPrompt, {
          type: "session-initialization",
          origin: context.source ?? "application"
        });
      }
      return store.getSession(session.id) ?? session;
    } finally {
      releaseTitle();
    }
  }

  return { createSessionThroughApplication };
}
