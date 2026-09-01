import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct SessionListSearchTests {
    @Test
    func emptyQueryReturnsAllRows() {
        let rows = [makeRow("one"), makeRow("two")]
        #expect(filteredSessionRows(rows, query: "  ").map(\.id) == ["one", "two"])
    }

    @Test
    func searchMatchesTitleSummaryAgentAndCwdCaseInsensitively() {
        let rows = [
            makeRow("a", title: "Plan Sprint", agent: "alpha"),
            makeRow("b", summary: "Deploy notes", agent: "alpha"),
            makeRow("c", agent: "Codex"),
            makeRow("d", agent: "alpha", cwd: "/Users/dev/project"),
        ]
        #expect(filteredSessionRows(rows, query: "sprint").map(\.id) == ["a"])
        #expect(filteredSessionRows(rows, query: "DEPLOY").map(\.id) == ["b"])
        #expect(filteredSessionRows(rows, query: "codex").map(\.id) == ["c"])
        #expect(filteredSessionRows(rows, query: "/Users/dev").map(\.id) == ["d"])
    }

    @Test
    func searchReturnsEmptyWhenNoMatch() {
        #expect(filteredSessionRows([makeRow("a", title: "Alpha")], query: "zzz").isEmpty)
    }
}

@MainActor
struct SessionSelectionResolutionTests {
    @Test
    func keepsCurrentSelectionWhenStillValidInCategory() {
        let rows = [makeRow("worker-a", kind: .worker), makeRow("worker-b", kind: .worker)]
        #expect(
            resolvedSessionSelection(
                category: .worker,
                rows: rows,
                selectedSessionId: "worker-b",
                lastSelectedId: "worker-a"
            ) == "worker-b"
        )
    }

    @Test
    func restoresLastSelectedWithinCategory() {
        let rows = [
            makeRow("worker-a", kind: .worker),
            makeRow("worker-b", kind: .worker),
            makeRow("assistant-a", kind: .assistantChat, agentId: "agent"),
        ]
        // 当前选择是 assistant，切到 worker Tab 时应恢复 worker 记住的 worker-b。
        #expect(
            resolvedSessionSelection(
                category: .worker,
                rows: rows,
                selectedSessionId: "assistant-a",
                lastSelectedId: "worker-b"
            ) == "worker-b"
        )
    }

    @Test
    func fallsBackToFirstWhenSavedSelectionDeleted() {
        let rows = [makeRow("worker-a", kind: .worker)]
        #expect(
            resolvedSessionSelection(
                category: .worker,
                rows: rows,
                selectedSessionId: nil,
                lastSelectedId: "deleted-worker"
            ) == "worker-a"
        )
    }

    @Test
    func fallsBackToFirstWhenSavedSelectionBelongsToAnotherCategory() {
        let rows = [makeRow("assistant-a", kind: .assistantChat, agentId: "agent")]
        // 记住的 worker-x 已不属于 assistant 分类，应回退到该分类第一个。
        #expect(
            resolvedSessionSelection(
                category: .assistant,
                rows: rows,
                selectedSessionId: nil,
                lastSelectedId: "worker-x"
            ) == "assistant-a"
        )
    }

    @Test
    func returnsNilWhenCategoryHasNoSessions() {
        #expect(
            resolvedSessionSelection(
                category: .objective,
                rows: [makeRow("worker-a", kind: .worker)],
                selectedSessionId: nil,
                lastSelectedId: nil
            ) == nil
        )
    }
}

// MARK: - Helpers

@MainActor
private func makeRow(
    _ id: String,
    title: String = "Session",
    summary: String = "Summary",
    agent: String = "Codex",
    kind: SessionKind = .legacy,
    agentId: String? = nil,
    cwd: String? = nil
) -> SessionRowModel {
    let external: ExternalSession? = cwd.map { cwd in
        ExternalSession(
            provider: "codex",
            threadId: nil,
            sessionId: nil,
            agentSessionId: nil,
            connectionStatus: nil,
            currentModel: nil,
            currentReasoningLevel: nil,
            cwd: cwd,
            sandbox: nil,
            approvalPolicy: nil,
            source: nil,
            logicalSessionId: nil,
            workspace: nil,
            routingVersion: nil,
            providerSwitchInFlight: nil,
            providerTransition: nil
        )
    }
    let session = TaskSession(
        id: id,
        title: title,
        agent: agent,
        agentId: agentId,
        sessionKind: kind,
        taskId: nil,
        status: .complete,
        progress: 1,
        summary: summary,
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: "2026-08-12T00:00:00Z",
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: external,
        actions: nil,
    )
    return SessionRowModel(session: session)
}
