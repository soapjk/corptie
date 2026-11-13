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
        public let priority: String
        public let lifecycleState: String
        public let archived: Bool
        public let mainRoleId: String?
        public let deletionStatus: String?
        // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case id
        case workId
        case title
        case priority
        case lifecycleState
        case archived
        case mainRoleId = "mainAgentId"
        case deletionStatus
    }
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
    public let roles: [ClientTaskCreationOptions.Resource]
    public let priorities: [String]
    public let actions: Actions
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case task
        case roles = "agents"
        case priorities
        case actions
    }
}

/// Desktop deletion plan without host paths (§10.1): branch name, dirtiness and
/// counts are enough for the same confirmation the macOS dialog shows.
public struct ClientTaskDeletionPlan: Decodable, Sendable {
    public var recoveryAvailable: Bool? = nil
    public let parentTaskId: String?
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
    public let associatedTaskIds: [String]?
    public let childTaskIds: [String]?
    public let artifacts: [Artifact]
    public let worktree: Worktree?
    public let risks: [Risk]
    public let blockers: [Risk]
}

/// Mirrors the server's conservative risk classification on every client.
public enum TaskDeletionConfirmationPolicy {
    public static func isTaskLevelBlocker(_ code: String) -> Bool {
        !["MAIN_WORKTREE", "SHARED_WITH_ACTIVE_TASK", "GIT_OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS", "WORKTREE_LOCKED"].contains(code)
    }

    public static func canForceDelete(riskCodes: [String], branchName: String?) -> Bool {
        branchName?.isEmpty == false && riskCodes.allSatisfy {
            ["UNCOMMITTED_CHANGES", "UNTRACKED_FILES", "NOT_MERGED_INTO_MAIN", "NOT_DELIVERED_TO_PARENT"].contains($0)
        }
    }
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
        public let repairLocalState: ClientEntityAction?
    }
    public let schemaVersion: Int
    public let work: WorkDetail
    public let actions: Actions
}

public struct ClientWorkLocalState: Decodable, Sendable, Equatable {
    public let schemaVersion: Int?
    public let state: String
    public let scope: String
    public let gitStatus: String?
    public let code: String?
    public var isReady: Bool { state == "ready" }
    public var titleKey: String {
        switch state {
        case "ready": "本地目录已就绪"
        case "missing": "尚未初始化本地目录"
        default: "本地目录需要检查"
        }
    }
}

/// Closed command bodies; the host rejects unknown keys, so each command only
/// carries the fields the matching macOS action edits.
public struct ClientTaskUpdate: Codable, Sendable, Equatable {
    public let requestId: String
    public var title: String?
    public var autoTitleEnabled: Bool?
    public var coordinationEnabled: Bool?
    public var priority: String?
    public var mainRoleId: String?
    public init(requestId: String) { self.requestId = requestId }
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case requestId
        case title
        case autoTitleEnabled
        case coordinationEnabled
        case priority
        case mainRoleId = "mainAgentId"
    }
}
public struct ClientTaskArchive: Codable, Sendable, Equatable {
    public let requestId: String
    public let archived: Bool
    public init(requestId: String, archived: Bool) { self.requestId = requestId; self.archived = archived }
}
public struct ClientTaskDeletionOptions: Codable, Sendable, Equatable {
    public var stopRunning = false
    public var cancelStartup = false
    public var deleteAssociatedTasks = false
    public var cancelIntegration = false
    public init() {}
    public func resolves(_ code: String) -> Bool {
        switch code {
        case "SESSION_BUSY", "TASK_BACKGROUND_WORK_RUNNING": return stopRunning
        case "START_IN_PROGRESS": return cancelStartup
        case "SHARED_WITH_ACTIVE_TASK": return deleteAssociatedTasks
        case "ACTIVE_WORKTREE_INTEGRATION_JOB": return cancelIntegration
        case "GIT_OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS", "WORKTREE_LOCKED": return true
        default: return false
        }
    }
}

public struct ClientTaskDeletion: Codable, Sendable, Equatable {
    public let requestId: String
    /// `safe` or `force`.
    public var mode = "safe"
    public var deleteWorktree = true
    /// `delete`, `work` or `retain`.
    public var artifactDisposition = "delete"
    public var acknowledgeDataLoss: Bool?
    public var stopRunning = false
    public var cancelStartup = false
    public var deleteAssociatedTasks = false
    public var cancelIntegration = false
    public init(requestId: String) { self.requestId = requestId }
}
public struct ClientWorkUpdate: Codable, Sendable, Equatable {
    public let requestId: String
    public var name: String?
    public var description: String?
    public init(requestId: String) { self.requestId = requestId }
}
public struct ClientWorkCreationOptions: Decodable, Sendable {
    public let roles: [ClientTaskCreationOptions.Resource]
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case roles = "agents"
    }
}
public struct ClientChatCreationOptions: Decodable, Sendable {
    public struct Provider: Decodable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let available: Bool
    }
    public let schemaVersion: Int
    public let roles: [ClientTaskCreationOptions.Resource]
    public let providers: [Provider]
    public let defaultProviderId: String?
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case roles = "agents"
        case providers
        case defaultProviderId
    }
}
public struct ClientChatCreation: Encodable, Sendable {
    public let requestId: String
    public let title: String
    public let roleId: String
    public let providerId: String
    public init(requestId: String, title: String, roleId: String, providerId: String) {
        self.requestId = requestId; self.title = title; self.roleId = roleId; self.providerId = providerId
    }
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case requestId
        case title
        case roleId = "agentId"
        case providerId
    }
}
public struct ClientWorkCreation: Encodable, Sendable {
    public let requestId: String
    public let name: String
    public let description: String
    public let contributorRoleIds: [String]
    public init(requestId: String, name: String, description: String, contributorRoleIds: [String]) {
        self.requestId = requestId; self.name = name; self.description = description
        self.contributorRoleIds = contributorRoleIds
    }
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case requestId
        case name
        case description
        case contributorRoleIds = "contributorAgentIds"
    }
}
public struct ClientEntityRequest: Codable, Sendable, Equatable {
    public let requestId: String
    public init(requestId: String) { self.requestId = requestId }
}

/// `entityResult` on a receipt; which fields are present depends on `kind`.
public struct ClientEntityCommandResult: Codable, Sendable, Equatable {
    public let sessionId: String?
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
    case repairLocalState = "repair-local-state"
    public var kind: String { "work_\(rawValue)" }
}
