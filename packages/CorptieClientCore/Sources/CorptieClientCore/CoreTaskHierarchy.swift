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
