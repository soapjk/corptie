import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { SessionForkService } from "./sessionForkService.mjs";
import { isPlatformAssistant } from "../utils/platformAssistantIdentity.mjs";

// Composition of Task and assistant-chat forks with the same source binding
// validation and workspace inventory contract.
export function createSessionForkOperations({
  store, agentProviderRegistry, sessionApplicationService, workService,
  workSessionStartApplicationService, chatResourceService, collaborationCore,
  createSessionThroughApplication, emitEvent, createForkWorktree,
  createGitWorkspaceSnapshot, ensureArtifactCommitHook
}) {
const sessionForkService = new SessionForkService({
  store, registry: agentProviderRegistry, sessionService: sessionApplicationService, workService,
  startWorkSession: (command) => workSessionStartApplicationService.start(command),
  copyMetadata: (...args) => chatResourceService.copyForkMetadata(...args),
  createChat: async ({ source, input }) => {
    const logical = store.getLogicalSessionByLegacySessionId(source.session.id);
    const workspace = logical?.repositoryId ? await prepareConversationForkWorkspace(source, `chat:${input.requestId}`) : null;
    const session = await createSessionThroughApplication(source.reference.providerId, {
      title: input.title, cwd: workspace?.path ?? source.session.external?.cwd,
      sessionKind: "assistantChat", model: source.session.external?.currentModel,
      reasoningLevel: source.session.external?.currentReasoningLevel,
      ...(workspace ? { runtimeWorkspaceRoots: [workspace.path] } : {})
    }, { source: "conversation-fork", actorId: source.session.agentId,
      sessionKind: "assistantChat", forkSource: source, forkRequestId: input.requestId });
    collaborationCore.bindSession({ agentId: source.session.agentId, sessionId: session.id });
    const agent = store.getAgent(source.session.agentId);
    if (agent && isPlatformAssistant(agent)) store.grantSessionCapability(session.id, "platform.manage");
    return session;
  },
  onChanged: (type, payload) => emitEvent(type, payload)
});

async function prepareConversationForkWorkspace(source, targetId) {
  const logical = store.getLogicalSessionByLegacySessionId(source.session.id);
  const sourcePath = logical?.activeBinding?.boundCwd;
  if (!logical?.repositoryId || !sourcePath || logical.activeBinding.bindingId !== source.reference.bindingId) {
    throw Object.assign(new Error("源会话没有有效的 Git Worktree 绑定。"), { code: "FORK_WORKSPACE_UNAVAILABLE" });
  }
  const suffix = createHash("sha256").update(targetId).digest("hex").slice(0, 24);
  const targetPath = resolve(store.layout.worktreesDirectory, logical.repositoryId.split(":").at(-1), `fork-${suffix}`);
  const created = await createForkWorktree({ sourcePath, targetPath, branchName: `fork/${suffix}` });
  const snapshot = await createGitWorkspaceSnapshot(targetPath);
  if (snapshot.repository.id !== logical.repositoryId) throw new Error("Fork Repository identity changed.");
  store.upsertGitWorkspaceSnapshot(snapshot);
  const worktree = snapshot.worktrees.find(row => resolve(row.canonicalPath || row.path) === targetPath);
  if (!worktree) throw new Error("Fork Worktree was not inventoried.");
  await ensureArtifactCommitHook(targetPath, { dbPath: store.dbPath });
  return { ...created, worktreeId: worktree.worktreeId, reused: false };
}
  return { sessionForkService, prepareConversationForkWorkspace };
}
