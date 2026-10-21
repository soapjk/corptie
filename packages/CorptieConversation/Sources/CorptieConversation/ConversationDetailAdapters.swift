import SwiftUI
import CorptieClientCore

public enum ConversationReferenceAddKind: String, CaseIterable, Identifiable {
    case localFile, webURL, work, task, agent, session
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .localFile: "本地文件…"
        case .webURL: "网页链接…"
        case .work: "Work…"
        case .task: "Task…"
        case .agent: "Agent…"
        case .session: "其他会话…"
        }
    }
}

public enum ConversationReferenceOperation: String, Identifiable {
    case open, reveal, copyPath, refresh, replace, enable, disable, remove
    public var id: String { rawValue }
    var title: String {
        switch self {
        case .open: "打开引用"
        case .reveal: "在 Finder 中显示"
        case .copyPath: "复制路径"
        case .refresh: "重新检查／刷新"
        case .replace: "重新选择文件…"
        case .enable: "启用引用"
        case .disable: "停用引用"
        case .remove: "移除引用"
        }
    }
}

/// Native platform registration only; reference IDs are resolved by the trusted host.
@MainActor public struct ConversationReferenceManagement {
    let addKinds: [ConversationReferenceAddKind]
    let canAdd: Bool
    let add: (ConversationReferenceAddKind) -> Void
    let operations: (String) -> [ConversationReferenceOperation]
    let perform: (String, ConversationReferenceOperation) -> Void
    public init(addKinds: [ConversationReferenceAddKind], canAdd: Bool,
                add: @escaping (ConversationReferenceAddKind) -> Void,
                operations: @escaping (String) -> [ConversationReferenceOperation],
                perform: @escaping (String, ConversationReferenceOperation) -> Void) {
        self.addKinds = addKinds; self.canAdd = canAdd; self.add = add
        self.operations = operations; self.perform = perform
    }
}

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
    let referenceManagement: ConversationReferenceManagement?
    let openArtifact: ((ClientResourceFocus) -> Void)?
    public init(configuration: ClientDetailConfiguration,
                selectConfiguration: @escaping @MainActor (ClientDetailConfiguration.Field, String) async throws -> Void,
                reloadConfiguration: @escaping @MainActor () async -> Void,
                readTurnSummary: @escaping @MainActor (String) async throws -> ClientTurnSummary,
                readTurnTrace: @escaping @MainActor (String, String?) async throws -> ClientTurnTrace,
                worktreeAPI: @escaping @MainActor (String?) async throws -> ClientSessionWorktreeAPI,
                onWorktreeJob: @escaping @MainActor (ClientWorktreeJob) -> Void,
                resident: Resident, turnSnapshot: ClientTurnSummary? = nil,
                referenceManagement: ConversationReferenceManagement? = nil,
                openArtifact: ((ClientResourceFocus) -> Void)? = nil) {
        self.configuration = configuration; self.selectConfiguration = selectConfiguration
        self.reloadConfiguration = reloadConfiguration; self.readTurnSummary = readTurnSummary; self.readTurnTrace = readTurnTrace
        self.worktreeAPI = worktreeAPI; self.onWorktreeJob = onWorktreeJob; self.resident = resident
        self.turnSnapshot = turnSnapshot
        self.referenceManagement = referenceManagement
        self.openArtifact = openArtifact
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
