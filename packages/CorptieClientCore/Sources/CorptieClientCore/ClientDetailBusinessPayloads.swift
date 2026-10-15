import Foundation

public struct ClientDetailBusinessList<Row: Decodable & Equatable & Sendable>: Decodable, Equatable, Sendable {
    public let items: [Row]
    public let hasMore: Bool
}
public struct ClientDetailBusinessSession: Decodable, Equatable, Sendable { public let sessionId: String; public let workName: String }
public struct ClientDetailBusinessSummary: Decodable, Equatable, Sendable { public let text: String }
public struct ClientDetailBusinessWork: Decodable, Equatable, Sendable { public let workId: String; public let name: String; public let description: String }
public struct ClientDetailBusinessTaskSummary: Decodable, Equatable, Sendable {
    public let state: String; public let focus: String; public let progress: String; public let intervention: String
    public let reason: String; public let nextAction: String; public let current: Bool?
    public let messageSummary: String?; public let generatedAt: String?
}
public struct ClientDetailBusinessFocus: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { taskId }; public let taskId: String; public let title: String
    public let sessionId: String?; public let summary: ClientDetailBusinessTaskSummary
}
public struct ClientDetailBusinessReference: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { referenceId }; public let referenceId: String; public let title: String
    public let targetType: String; public let status: String; public let enabled: Bool
}
public struct ClientDetailBusinessMemory: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { memoryId }; public let memoryId: String; public let kind: String; public let content: String
    public let unavailable: Bool; public let snapshotAtRecall: Bool; public let updatedAt: String?; public let resourceVersion: Int?
}
public struct ClientDetailBusinessSchedule: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { scheduleId }; public let scheduleId: String; public let name: String; public let scheduleType: String
    public let status: String; public let runAt: String?; public let nextRunAt: String?; public let timezone: String; public let resourceRevision: String
}
public struct ClientDetailBusinessProvider: Decodable, Equatable, Sendable {
    public struct Choice: Decodable, Equatable, Identifiable, Sendable {
        public var id: String { providerId }; public let providerId: String; public let name: String; public let available: Bool
    }
    public let providerId: String; public let name: String; public let model: String; public let reasoning: String
    public let switching: Bool; public let providers: [Choice]
}
public struct ClientDetailBusinessWorktree: Decodable, Equatable, Sendable {
    public struct Tree: Decodable, Equatable, Sendable {
        public let branchName: String; public let isMain: Bool; public let dirty: Bool?; public let availability: String
        public let aheadOfMain: Int?; public let behindMain: Int?; public let changedFileCount: Int?; public let operationState: String
    }
    public struct AutoFollow: Decodable, Equatable, Sendable { public let enabled: Bool; public let status: String; public let reason: String }
    public struct Job: Decodable, Equatable, Sendable { public let jobId: String; public let status: String; public let phase: String }
    public let attached: Bool; public let worktreeId: String?; public let mainBranch: String; public let blockedReason: String
    public let tree: Tree?; public let autoFollow: AutoFollow; public let job: Job?
}
public struct ClientDetailBusinessTurn: Decodable, Equatable, Sendable {
    public let turnId: String?; public let completeness: String
    public let wall: [String: String]; public let wallPartition: [String: String]; public let inclusive: [String: String]
}
