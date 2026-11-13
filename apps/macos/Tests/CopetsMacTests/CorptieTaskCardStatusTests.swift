import Foundation
import Testing
@testable import CorptieMac

struct CorptieTaskCardStatusTests {
    @Test func executionProjectionWinsOverStaleLegacySessionStatus() {
        var session = makeCorptieTaskSession(id: "session:current", status: .running)
        session.executionStatus = "completed"
        #expect(CorptieTaskBoundSessionActivity.resolve(
            task: makeCorptieTask(currentSessionId: session.id, executionStatus: "running"),
            sessions: [session]) == .idle)
        session.executionStatus = "failed"
        #expect(CorptieTaskBoundSessionActivity.resolve(
            task: makeCorptieTask(currentSessionId: session.id, executionStatus: "running"),
            sessions: [session]) == .failed)
    }

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

    @Test func idleTaskSessionUsesANeutralIndicator() {
        #expect(CorptieTaskBoundSessionActivity.idle.color == .secondary)
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

    @Test func workActivityIncludesOnlyWorksWithProcessingTasks() {
        let task = makeCorptieTask(
            currentSessionId: "session:current",
            executionStatus: "idle"
        )
        let runningSession = makeCorptieTaskSession(
            id: "session:current",
            status: .running
        )

        #expect(ConsoleWorkActivityPolicy.processingWorkIDs(
            tasks: [task],
            sessions: [runningSession]
        ) == ["work:one"])

        let blockedSession = makeCorptieTaskSession(
            id: "session:current",
            status: .blocked
        )
        #expect(ConsoleWorkActivityPolicy.processingWorkIDs(
            tasks: [task],
            sessions: [blockedSession]
        ).isEmpty)
    }

    @Test func unifiedTaskListIndicatorConsumesLiveSessionActivity() {
        let task = makeCorptieTask(currentSessionId: "session:current", executionStatus: "running")
        var session = makeCorptieTaskSession(id: "session:current", status: .running)
        session.executionStatus = "failed"
        #expect(TaskSessionLookup(sessions: [session]).activity(for: task) == .failed)
        session.executionStatus = "completed"
        #expect(TaskSessionLookup(sessions: [session]).activity(for: task) == .idle)
    }

}

private func makeCorptieTask(currentSessionId: String?, executionStatus: String?) -> CorptieTask {
    CorptieTask(
        id: "task:one",
        workId: "work:one",
        title: "CorptieTask",

        priority: "medium",
        lifecycleState: "in_progress",
        mainRoleId: "agent:one",
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
        roleId: "agent:one",
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
