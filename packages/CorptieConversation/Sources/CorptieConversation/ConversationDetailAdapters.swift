import SwiftUI
import CorptieClientCore

/// Platform boundaries carry data and actions, never arbitrary card Views.
@MainActor public struct ConversationDetailAdapters {
    public struct Resident {
        let taskTitle: String
        let workName: String
        let workDescription: String
        public init(taskTitle: String = "", workName: String = "", workDescription: String = "") {
            self.taskTitle = taskTitle; self.workName = workName; self.workDescription = workDescription
        }
    }
    let configuration: ClientDetailConfiguration
    let selectConfiguration: @MainActor (ClientDetailConfiguration.Field, String) async throws -> Void
    let reloadConfiguration: @MainActor () async -> Void
    let readTurnSummary: @MainActor (String) async throws -> ClientTurnSummary
    let readTurnTrace: @MainActor (String, String?) async throws -> ClientTurnTrace
    let worktreeAPI: @MainActor (String?) async throws -> ClientSessionWorktreeAPI
    let onWorktreeJob: @MainActor (ClientWorktreeJob) -> Void
    let resident: Resident
    let turnSnapshot: ClientTurnSummary?
    public init(configuration: ClientDetailConfiguration,
                selectConfiguration: @escaping @MainActor (ClientDetailConfiguration.Field, String) async throws -> Void,
                reloadConfiguration: @escaping @MainActor () async -> Void,
                readTurnSummary: @escaping @MainActor (String) async throws -> ClientTurnSummary,
                readTurnTrace: @escaping @MainActor (String, String?) async throws -> ClientTurnTrace,
                worktreeAPI: @escaping @MainActor (String?) async throws -> ClientSessionWorktreeAPI,
                onWorktreeJob: @escaping @MainActor (ClientWorktreeJob) -> Void,
                resident: Resident, turnSnapshot: ClientTurnSummary? = nil) {
        self.configuration = configuration; self.selectConfiguration = selectConfiguration
        self.reloadConfiguration = reloadConfiguration; self.readTurnSummary = readTurnSummary; self.readTurnTrace = readTurnTrace
        self.worktreeAPI = worktreeAPI; self.onWorktreeJob = onWorktreeJob; self.resident = resident
        self.turnSnapshot = turnSnapshot
    }
}

struct ConversationDetailResidentPreview: View {
    let value: ConversationDetailAdapters.Resident
    var body: some View {
        ConversationDetailModuleCard(title: "当前会话", systemImage: "bubble.left") {
            if !value.taskTitle.isEmpty { Text(value.taskTitle).font(.system(size: 12, weight: .medium)).textSelection(.enabled) }
            if !value.workName.isEmpty { Text(value.workName).font(.caption).foregroundStyle(.secondary) }
            if !value.workDescription.isEmpty { Text(value.workDescription).font(.caption).foregroundStyle(.secondary).lineLimit(4) }
        }
    }
}
