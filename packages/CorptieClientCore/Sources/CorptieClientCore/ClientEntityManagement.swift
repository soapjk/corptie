import Foundation

/// Device-side Work / Task management: the macOS outline context menus over the
/// `tasks.manage` / `works.manage` grants. Every write is a receipt-backed command.
public struct ClientEntityAction: Decodable, Sendable, Equatable {
    public let available: Bool
    public let reason: String?
    public init(available: Bool, reason: String? = nil) { self.available = available; self.reason = reason }
}

public struct ClientTaskManagement: Decodable, Sendable {
    public struct TaskDetail: Decodable, Sendable, Equatable {
        public let id: String
        public let workId: String
        public let title: String
        public let description: String
        public let acceptanceCriteria: String
        public let verificationCriteria: String
        public let priority: String
        public let lifecycleState: String
        public let archived: Bool
        public let mainAgentId: String?
        public let deletionStatus: String?
    }
    public struct Actions: Decodable, Sendable, Equatable {
        public let rename: ClientEntityAction
        public let edit: ClientEntityAction
        public let restart: ClientEntityAction
        public let archive: ClientEntityAction
        public let unarchive: ClientEntityAction
        public let delete: ClientEntityAction
    }
    public let schemaVersion: Int
    public let task: TaskDetail
    public let agents: [ClientTaskCreationOptions.Resource]
    public let priorities: [String]
    public let actions: Actions
}

/// Desktop deletion plan without host paths (§10.1): branch name, dirtiness and
/// counts are enough for the same confirmation the macOS dialog shows.
public struct ClientTaskDeletionPlan: Decodable, Sendable {
    public struct Artifact: Decodable, Sendable, Identifiable, Equatable {
        public let id: String
        public let title: String
    }
    public struct Worktree: Decodable, Sendable, Equatable {
        public let branchName: String?
        public let dirty: Bool
        public let mergedIntoMain: Bool
        public let aheadOfMain: Int
    }
    public struct Risk: Decodable, Sendable, Equatable {
        public let code: String
        public let message: String
        public let files: [String]?
        public let commitCount: Int?
    }
    public let schemaVersion: Int
    public let taskId: String
    /// `blocked` / `risky` / `safe`.
    public let status: String
    public let associatedSessionCount: Int
    public let artifacts: [Artifact]
    public let worktree: Worktree?
    public let risks: [Risk]
    public let blockers: [Risk]
}

public struct ClientWorkManagement: Decodable, Sendable {
    public struct WorkDetail: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let description: String
        public let status: String
    }
    public struct Actions: Decodable, Sendable, Equatable {
        public let edit: ClientEntityAction
        public let delete: ClientEntityAction
    }
    public let schemaVersion: Int
    public let work: WorkDetail
    public let actions: Actions
}

/// Closed command bodies; the host rejects unknown keys, so each command only
/// carries the fields the matching macOS action edits.
public struct ClientTaskUpdate: Codable, Sendable, Equatable {
    public let requestId: String
    public var title: String?
    public var autoTitleEnabled: Bool?
    public var description: String?
    public var acceptanceCriteria: String?
    public var verificationCriteria: String?
    public var priority: String?
    public var mainAgentId: String?
    public init(requestId: String) { self.requestId = requestId }
}
public struct ClientTaskArchive: Codable, Sendable, Equatable {
    public let requestId: String
    public let archived: Bool
    public init(requestId: String, archived: Bool) { self.requestId = requestId; self.archived = archived }
}
public struct ClientTaskDeletion: Codable, Sendable, Equatable {
    public let requestId: String
    /// `safe` or `force`.
    public var mode = "safe"
    public var deleteWorktree = true
    /// `delete`, `work` or `retain`.
    public var artifactDisposition = "delete"
    public var acknowledgeDataLoss: Bool?
    public var confirmedBranchName: String?
    public init(requestId: String) { self.requestId = requestId }
}
public struct ClientWorkUpdate: Codable, Sendable, Equatable {
    public let requestId: String
    public var name: String?
    public var description: String?
    public init(requestId: String) { self.requestId = requestId }
}
public struct ClientWorkCreationOptions: Decodable, Sendable {
    public let agents: [ClientTaskCreationOptions.Resource]
}
public struct ClientWorkCreation: Encodable, Sendable {
    public let requestId: String
    public let name: String
    public let description: String
    public let contributorAgentIds: [String]
    public init(requestId: String, name: String, description: String, contributorAgentIds: [String]) {
        self.requestId = requestId; self.name = name; self.description = description
        self.contributorAgentIds = contributorAgentIds
    }
}
public struct ClientEntityRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public init(requestId: String) { self.requestId = requestId }
}

/// `entityResult` on a receipt; which fields are present depends on `kind`.
public struct ClientEntityCommandResult: Codable, Sendable, Equatable {
    public let taskId: String?
    public let workId: String?
    public let title: String?
    public let name: String?
    public let archived: Bool?
    public let status: String?
    public let operationId: String?
    public let state: String?
}

public enum ClientTaskCommand: String, Sendable {
    case update, archive, restart, delete
    public var kind: String { "task_\(rawValue)" }
}
public enum ClientWorkCommand: String, Sendable {
    case update, delete
    public var kind: String { "work_\(rawValue)" }
}
