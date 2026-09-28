import SwiftUI
import CorptieClientCore
import CorptieConversation

struct CorptieTaskDeletionPresentation: Identifiable {
    let id = UUID()
    let task: CorptieTask
    let plan: CorptieTaskDeletionPlan
}

struct CorptieTaskDeletionNotice: Identifiable {
    enum Phase: Equatable {
        case checking
        case deleting
        case success
        case failure
        case guidance

        var isInProgress: Bool { self == .checking || self == .deleting }
        var systemImage: String {
            switch self {
            case .checking, .deleting: "hourglass"
            case .success: "checkmark.circle.fill"
            case .failure: "exclamationmark.triangle.fill"
            case .guidance: "arrow.triangle.merge"
            }
        }
        var color: Color {
            switch self {
            case .success: .green
            case .failure: .red
            case .guidance: .orange
            case .checking, .deleting: .secondary
            }
        }
    }

    let id = UUID()
    let phase: Phase
    let message: String
    var retryItem: CorptieTask?
}

// MARK: - CorptieTask 混合看板

enum WorkDiscussionRouteDecision: Equatable {
    case open(sessionId: String)
    case create

    static func resolve(workId: String, sessions: [TaskSession]) -> Self {
        if let session = sessions.first(where: {
            $0.workId == workId && $0.resolvedSessionKind == .workChat
        }) {
            return .open(sessionId: session.id)
        }
        return .create
    }
}

enum CorptieTaskAcceptancePresentationDecision {
    static func canOpenCompletionConfirmation(status: String) -> Bool {
        ["in_progress", "doing", "running"].contains(status)
    }
}

struct CorptieTaskAutomaticAcceptancePresentation: Equatable {
    enum State: Equatable {
        case passed
        case notPassed
        case notAssessed
    }

    let state: State
    let results: [CorptieTaskAcceptanceResult]

    static func resolve(
        assessment: CorptieTaskAcceptanceAssessment?,
        suggestion: CorptieTaskCompletionSuggestion?
    ) -> Self {
        if let assessment {
            return Self(
                state: assessment.status == "passed" ? .passed : .notPassed,
                results: assessment.results
            )
        }
        if let suggestion, suggestion.recommended {
            return Self(state: .passed, results: suggestion.results)
        }
        return Self(state: .notAssessed, results: [])
    }
}

enum CorptieTaskAcceptanceReviewState: Equatable {
    case passed
    case manuallyRejected
    case unavailable

    static func resolve(_ task: CorptieTask) -> Self {
        if task.acceptanceAssessment?.status == "rejected" {
            return .manuallyRejected
        }
        if task.completionSuggestion?.recommended == true {
            return .passed
        }
        return .unavailable
    }
}

typealias CorptieTaskBoundSessionActivity = TaskSessionActivity

extension TaskSessionActivity {
    static func resolve(task: CorptieTask, sessions: [TaskSession]) -> Self {
        let currentSessionId = task.currentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let boundSession = currentSessionId.flatMap { sessionId in
            sessions.first(where: { $0.id == sessionId })
        }
            ?? sessions
                .filter { $0.taskId == task.id && $0.archived != true }
                .max(by: { $0.updatedAt < $1.updatedAt })

        return Self.resolve(hasBinding: currentSessionId?.isEmpty == false || boundSession != nil,
            sessionExecutionStatus: boundSession?.executionTaskStatus.rawValue,
            taskExecutionStatus: task.executionStatus)
    }

    @MainActor var label: String {
        L10n(labelKey)
    }

    var color: Color {
        switch self {
        case .processing: CorptiePalette.connected
        case .waitingForInput, .paused: .orange
        case .idle: .orange
        case .interrupted, .failed: .red
        case .noSession, .unknown: .secondary
        }
    }
}
