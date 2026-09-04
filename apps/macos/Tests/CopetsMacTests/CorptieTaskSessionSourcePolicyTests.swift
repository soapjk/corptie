import Testing
@testable import CorptieMac

@MainActor
struct CorptieTaskSessionSourcePolicyTests {
    @Test
    func ignoresAGloballySelectedSessionFromAnotherWork() {
        let foreign = makeSession(id: "session:foreign", kind: .workChat, workId: "work:other")
        let local = makeSession(id: "session:local", kind: .workChat, workId: "work:target")

        let resolved = CorptieTaskSessionSourcePolicy.resolve(
            workId: "work:target",
            preferred: foreign,
            sessions: [foreign, local]
        )

        #expect(resolved?.id == local.id)
    }

    @Test
    func prefersTheWorksOwnChatOverWorkerSessions() {
        let worker = makeSession(id: "session:worker", kind: .worker, workId: "work:target")
        let chat = makeSession(id: "session:chat", kind: .workChat, workId: "work:target")

        let resolved = CorptieTaskSessionSourcePolicy.resolve(
            workId: "work:target",
            preferred: nil,
            sessions: [worker, chat]
        )

        #expect(resolved?.id == chat.id)
    }

    @Test
    func rejectsArchivedAndUnauthenticatedCandidates() {
        var archived = makeSession(id: "session:archived", kind: .workChat, workId: "work:target")
        archived = replacingArchived(archived, true)
        let legacy = makeSession(id: "codex:legacy", kind: .workChat, workId: "work:target")

        #expect(CorptieTaskSessionSourcePolicy.resolve(
            workId: "work:target",
            preferred: nil,
            sessions: [archived, legacy]
        ) == nil)
    }

    private func makeSession(id: String, kind: SessionKind, workId: String) -> TaskSession {
        TaskSession(
            id: id,
            title: id,
            agent: "Agent",
            agentId: "agent:one",
            sessionKind: kind,
            workId: workId,
            taskId: kind == .worker ? "task:one" : nil,
            status: .complete,
            progress: 1,
            summary: "",
            suggestedOptions: nil,
            suggestedPrompt: nil,
            activityStatus: nil,
            updatedAt: "2026-09-04T00:00:00Z",
            accent: .cyan,
            archived: false,
            pinned: false,
            sortOrder: nil,
            capabilities: nil,
            external: nil,
            actions: nil
        )
    }

    private func replacingArchived(_ session: TaskSession, _ archived: Bool) -> TaskSession {
        TaskSession(
            id: session.id,
            title: session.title,
            agent: session.agent,
            agentId: session.agentId,
            sessionKind: session.sessionKind,
            workId: session.workId,
            taskId: session.taskId,
            status: session.status,
            progress: session.progress,
            summary: session.summary,
            suggestedOptions: session.suggestedOptions,
            suggestedPrompt: session.suggestedPrompt,
            activityStatus: session.activityStatus,
            updatedAt: session.updatedAt,
            accent: session.accent,
            archived: archived,
            pinned: session.pinned,
            sortOrder: session.sortOrder,
            capabilities: session.capabilities,
            external: session.external,
            actions: session.actions
        )
    }
}
