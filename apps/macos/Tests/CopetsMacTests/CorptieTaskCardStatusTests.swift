import Foundation
import Testing
@testable import CorptieMac

struct CorptieTaskCardStatusTests {
    @Test func reportsNoSessionWithoutACurrentBinding() {
        #expect(CorptieTaskBoundSessionActivity.resolve(
            task: makeCorptieTask(currentSessionId: nil, executionStatus: "idle"),
            sessions: []
        ) == .noSession)
    }

    @Test func mapsTheBoundSessionsAuthoritativeRuntimeStatus() {
        let mappings: [(TaskStatus, CorptieTaskBoundSessionActivity)] = [
            (.running, .processing),
            (.blocked, .waitingForInput),
            (.complete, .idle),
            (.cancelled, .interrupted),
            (.failed, .failed)
        ]

        for (status, expected) in mappings {
            let task = makeCorptieTask(currentSessionId: "session:current", executionStatus: "idle")
            let session = makeCorptieTaskSession(id: "session:current", status: status)
            #expect(CorptieTaskBoundSessionActivity.resolve(
                task: task,
                sessions: [session]
            ) == expected)
        }
    }

    @Test func ignoresOtherSessionsWhenTheCurrentBindingIsPresent() {
        let current = makeCorptieTaskSession(id: "session:current", status: .running)
        let newerOther = makeCorptieTaskSession(
            id: "session:other",
            status: .failed,
            updatedAt: "2026-08-20T00:00:00Z"
        )
        #expect(CorptieTaskBoundSessionActivity.resolve(
            task: makeCorptieTask(currentSessionId: current.id, executionStatus: "failed"),
            sessions: [newerOther, current]
        ) == .processing)
    }

    @Test func fallsBackToPersistedExecutionStatusDuringSnapshotRaces() {
        let task = makeCorptieTask(currentSessionId: "session:not-loaded", executionStatus: "paused")
        #expect(CorptieTaskBoundSessionActivity.resolve(
            task: task,
            sessions: []
        ) == .paused)
    }

    @Test func findsTheLatestLiveTaskSessionBeforeTheTaskBindingSnapshotCatchesUp() {
        let task = makeCorptieTask(currentSessionId: nil, executionStatus: "idle")
        let older = makeCorptieTaskSession(
            id: "session:older",
            status: .complete,
            updatedAt: "2026-08-19T00:00:00Z"
        )
        let latest = makeCorptieTaskSession(
            id: "session:latest",
            status: .running,
            updatedAt: "2026-08-20T00:00:00Z"
        )

        #expect(CorptieTaskBoundSessionActivity.resolve(
            task: task,
            sessions: [older, latest]
        ) == .processing)
    }

    @Test func unifiedTaskListIndicatorConsumesLiveSessionActivity() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/UnifiedConsoleView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("CorptieTaskBoundSessionActivity.resolve("))
        #expect(contents.contains("taskIndicatorColor(sessionActivity, lifecycleState: task.lifecycleState)"))
        #expect(!contents.contains(".fill(taskStatusColor(task.lifecycleState))"))
    }
}

private func makeCorptieTask(currentSessionId: String?, executionStatus: String?) -> CorptieTask {
    CorptieTask(
        id: "task:one",
        workId: "work:one",
        title: "CorptieTask",
        description: "",
        acceptanceCriteria: "",
        priority: "medium",
        lifecycleState: "in_progress",
        mainAgentId: "agent:one",
        currentSessionId: currentSessionId,
        executionStatus: executionStatus,
        acceptanceAssessment: nil,
        completionSuggestion: nil,
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z"
    )
}

private func makeCorptieTaskSession(
    id: String,
    status: TaskStatus,
    updatedAt: String = "2026-08-19T00:00:00Z"
) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Agent",
        agentId: "agent:one",
        sessionKind: .worker,
        workId: "work:one",
        taskId: "task:one",
        status: status,
        progress: status == .running ? 0.5 : 1,
        summary: "",
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: updatedAt,
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: nil,
        actions: nil,
    )
}
