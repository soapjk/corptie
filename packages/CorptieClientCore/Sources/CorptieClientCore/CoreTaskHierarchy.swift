import Foundation

public struct TaskHierarchyCapabilities: Codable, Sendable, Hashable {
    public let version: Int
    public let maxDepth: Int
    public let createChild: Bool
    public let worktreeOperations: Bool
    public let integrationAcceptance: Bool

    public var supportsChildCreation: Bool { version == 1 && maxDepth == 1 && createChild }
}

public struct TaskHierarchyAction: Codable, Sendable, Hashable {
    public let available: Bool
    public let reason: String?
}

public struct TaskHierarchySummary: Codable, Sendable, Hashable {
    public struct Actions: Codable, Sendable, Hashable {
        public let createChild: TaskHierarchyAction
    }
    public struct Acceptance: Codable, Sendable, Hashable {
        /// Unknown states remain readable but never authorize an operation.
        public let state: String
        public let receiptId: String?
        public let testedHeadOid: String?
        public let reason: String?
    }
    public let version: Int
    public let rootTaskId: String
    public let depth: Int
    public let revision: Int
    public let childCount: Int
    public let completedChildCount: Int
    public let activeChildCount: Int
    public let deliveryWorktreeId: String?
    public let bindingRevision: Int?
    public let actions: Actions
    public let acceptance: Acceptance

    public var canCreateChild: Bool { version == 1 && depth == 0 && actions.createChild.available }
}

public struct ClientTaskHierarchyPage: Decodable, Sendable {
    public struct Scope: Decodable, Sendable, Equatable {
        public let workId: String
        public let mode: String
        public let parentTaskId: String?
        public let queryHash: String
    }
    public let schemaVersion: Int
    public let scope: Scope
    public let tasks: [ClientTask]
    public let ancestors: [ClientTask]
    public let hasMore: Bool
    public let nextCursor: String?
    public let taskHierarchyCapabilities: TaskHierarchyCapabilities?
}

public struct TaskHierarchyScope: Codable, Sendable, Hashable {
    public var version = 1
    public let rootTaskId: String
    public let action: String
    public let expectedHierarchyRevision: Int
    public let expectedBindingRevision: Int
    public let acceptanceReceiptId: String?
    public init(rootTaskId: String, action: String, revision: Int, bindingRevision: Int, receiptId: String? = nil) {
        self.rootTaskId=rootTaskId; self.action=action; expectedHierarchyRevision=revision
        expectedBindingRevision=bindingRevision; acceptanceReceiptId=receiptId
    }
}

public struct WorktreeHierarchy: Codable, Sendable, Hashable {
    public struct Comparison: Codable, Sendable, Hashable {
        public let kind: String
        public let worktreeId: String
        public let branchName: String?
        public let headOid: String?
        public let ahead: Int?
        public let behind: Int?
        public let merged: Bool?
    }
    public struct Actions: Codable, Sendable, Hashable {
        public let createChild: TaskHierarchyAction
        public let mergeChildren: TaskHierarchyAction
        public let syncChildren: TaskHierarchyAction
        public let mergeToParent: TaskHierarchyAction
        public let syncFromParent: TaskHierarchyAction
        public let syncFromMain: TaskHierarchyAction
        public let promoteToMain: TaskHierarchyAction
    }
    public let version: Int
    public let role: String
    public let taskId: String
    public let rootTaskId: String
    public let parentTaskId: String?
    public let parentWorktreeId: String?
    public let hierarchyRevision: Int
    public let bindingRevision: Int
    public let comparison: Comparison
    public let childCount: Int
    public let integratedChildCount: Int?
    public let actions: Actions
    public func scope(_ action: String, receiptId: String? = nil) -> TaskHierarchyScope {
        .init(rootTaskId: rootTaskId, action: action, revision: hierarchyRevision, bindingRevision: bindingRevision, receiptId: receiptId)
    }
}

public struct TaskIntegrationSnapshot: Decodable, Sendable {
    public let snapshotId: String
    public let parentHeadOid: String
    public let parentTaskId: String
}
public struct TaskIntegrationAcceptanceStatus: Decodable, Sendable {
    public let state: String
    public let receiptId: String?
    public let testedHeadOid: String?
    public let canPromote: Bool
    public let reason: String?
}
