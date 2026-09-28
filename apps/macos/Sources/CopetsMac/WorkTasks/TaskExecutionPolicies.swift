import SwiftUI
import CorptieClientCore
import CorptieConversation

enum CorptieTaskExecutionStartDecision: Equatable {
    case restoreCompleted
    case resume(sessionId: String)
    case createSession(agentId: String)
    case chooseAgent

    static func resolve(status: String, currentSessionId: String?, mainAgentId: String?) -> Self {
        if ["done", "complete", "completed"].contains(status) {
            return .restoreCompleted
        }
        if let currentSessionId = normalized(currentSessionId) {
            return .resume(sessionId: currentSessionId)
        }
        if let mainAgentId = normalized(mainAgentId) {
            return .createSession(agentId: mainAgentId)
        }
        return .chooseAgent
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }
}

enum CorptieTaskCompletionBackgroundDecision: Equatable {
    case submit
    case alreadyCompleted

    static func resolve(status: String) -> Self {
        ["done", "complete", "completed"].contains(status) ? .alreadyCompleted : .submit
    }

    static func requiresExplicitUserConfirmation(status: String) -> Bool {
        ["in_progress", "doing", "running"].contains(status)
    }
}

enum CorptieTaskEditSubmissionPolicy {
    static func submitsInBackground(statusChanged: Bool) -> Bool {
        statusChanged
    }
}
