import Foundation

public struct ClientManagedRepository: Identifiable, Decodable, Equatable, Sendable {
    public let id: String
    public let path: String
    public let name: String
    public let discoveredAt: String
    public let lastValidatedAt: String
    public let mainPath: String?
    public let availability: String
    public let worktreeCount: Int
}

public struct ClientManagedRepositoryDetail: Decodable, Equatable, Sendable {
    public let repository: ClientManagedRepository
    public let project: ClientManagedGitProject
    public let latestJob: ClientWorktreeJob?
}

public struct ClientManagedGitProject: Decodable, Equatable, Sendable {
    public let repositoryId: String
    public let inventoryVersion: String
    public let mainWorktreeId: String
    public let mainPath: String
    public let mainBranch: String?
    public let mainHeadOid: String?
    public let pendingWorktreeCount: Int
    public let worktrees: [ClientManagedWorktree]
}

public struct ClientManagedWorktree: Identifiable, Decodable, Equatable, Sendable {
    public var id: String { worktreeId }
    public let worktreeId: String
    public let path: String
    public let isMain: Bool
    public let availability: String
    public let headOid: String?
    public let branchName: String?
    public let isDetached: Bool
    public let isLocked: Bool
    public let lockReason: String?
    public let isPrunable: Bool?
    public let pruneReason: String?
    public let state: String
    public let dirty: Bool?
    public let statusSummary: String?
    public let diffStat: String?
    public let changedFiles: [String]
    public let operationState: String?
    public let conflictFiles: [String]
    public let mergedIntoMain: Bool?
    public let synchronizedWithMain: Bool?
    public let aheadOfMain: Int?
    public let behindMain: Int?
    public let pendingIntegration: Bool
    public let associations: [ClientWorktreeAssociation]
    public let deletionBlocker: ClientWorktreeDeletionBlocker?
    public var gitHubPush: ClientGitHubPushStatus?
}

public struct ClientWorktreeAssociation: Decodable, Equatable, Sendable {
    public let logicalSessionId: String
    public let sessionId: String?
    public let title: String?
    public let active: Bool
    public let taskId: String?
    public let taskTitle: String?
}

public struct ClientWorktreeDeletionBlocker: Decodable, Equatable, Sendable {
    public let code: String
    public let reason: String
}

public struct ClientGitHubPushStatus: Decodable, Equatable, Sendable {
    public let available: Bool
    public let pending: Bool
    public let dirty: Bool
    public let unpushedCommitCount: Int
    public let branch: String?
    public let destinationUrl: String?
    public let error: String?
}

public struct ClientGitHubPushResult: Decodable, Equatable, Sendable {
    public let pushed: Bool
    public let committed: Bool
    public let commitMessage: String?
    public let headOid: String
    public let branch: String
    public let destinationUrl: String
}

public struct ClientDevelopmentServiceStatus: Decodable, Equatable, Sendable {
    public let projectId: String
    public let toolset: ClientProjectToolsetStatus
    public let service: ClientProjectServiceStatus
}

public struct ClientProjectToolsetStatus: Decodable, Equatable, Sendable {
    public let installed: Bool
    public let configured: Bool
    public let manifestConfigured: Bool
    public let compatible: Bool
    public let requiresUpdate: Bool
    public let schemaVersion: Int?
    public let mainPath: String
    public let toolsetPath: String
    public let profiles: [ClientProjectServiceProfile]
    public let selectedProfile: String
}

public struct ClientProjectServiceProfile: Identifiable, Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String
}

public struct ClientProjectServiceStatus: Decodable, Equatable, Sendable {
    public let state: String
    public let configurationError: String?
    public let freshness: String
    public let running: Bool?
    public let healthy: Bool?
    public let mainHeadOid: String?
    public let runningRevision: String?
    public let runningBranch: String?
    public let runningCommitTime: String?
    public let dirty: Bool?
    public let startedAt: String?
    public let worktreePath: String?
    public let desiredProfile: String?
    public let runningProfile: String?
    public let artifactId: String?
    public let sourceFingerprint: String?
    public let verified: Bool?
    public let verificationDetail: String?
}

public struct ClientGitCommitProtectionStatus: Decodable, Equatable, Sendable {
    public let repositoryRoot: String
    public let protectedPaths: [String]
    public let localSymlinkPaths: [String]?
    public let suggestedIgnorePatterns: [String]
    public let warningEnabled: Bool
    public let requiresDecision: Bool
}

public struct ClientWorktreeJob: Identifiable, Decodable, Equatable, Sendable {
    public let id: String
    public let repositoryId: String
    public let status: String
    public let phase: String
    public let planFingerprint: String
    public let error: String?
    public let createdAt: String
    public let updatedAt: String
    public let confirmedAt: String?
    public let completedAt: String?
    public let plan: ClientWorktreePlan
    public let currentWorktreeId: String?
    public let progress: ClientWorktreeProgress
    public let conflictResolution: ClientWorktreeConflictResolution?
    public let conflictAutomation: ClientWorktreeConflictAutomation?

    public var shouldPoll: Bool {
        ["queued", "running", "cancellation_requested", "replanning"].contains(status)
            || conflictResolution?.status == "running"
    }
    public var canCancel: Bool {
        ["awaiting_confirmation", "queued", "running", "paused"].contains(status)
            && conflictResolution?.status != "running"
    }
    public var hasMergeConflict: Bool {
        status == "paused" && plan.operationType != "sync"
            && plan.items.contains { $0.worktreeId == currentWorktreeId && $0.mergeStatus == "conflict" }
    }
}

public struct ClientWorktreePlan: Decodable, Equatable, Sendable {
    public let repositoryId: String
    public let operationType: String?
    public let syncMode: String?
    public let targetWorktreeId: String?
    public let targetBranchName: String?
    public let sourceWorktreeIds: [String]?
    public let executionPath: String?
    public let mainWorktreeId: String
    public let mainPath: String
    public let mainHeadBefore: String
    public let inventoryVersion: String
    public let mergeOrder: [String]
    public let blockingRisks: [ClientWorktreeRisk]
    public let items: [ClientWorktreePlanItem]
}

public struct ClientWorktreePlanItem: Identifiable, Decodable, Equatable, Sendable {
    public var id: String { worktreeId }
    public let ordinal: Int
    public let worktreeId: String
    public let path: String
    public let branchName: String?
    public let isMain: Bool
    public let actualIsMain: Bool?
    public let isTarget: Bool?
    public let availability: String
    public let statusSummary: String
    public let changedFiles: [String]
    public let dirty: Bool
    public let aheadOfMain: Int?
    public let behindMain: Int?
    public let mergedIntoMain: Bool?
    public let associations: [ClientWorktreeAssociation]
    public let risks: [ClientWorktreeRisk]
    public let commitProtection: ClientGitCommitProtectionStatus?
    public let commitMessage: String?
    public let commitStatus: String
    public let mergeStatus: String
    public let convergenceStatus: String?
    public let conflictFiles: [String]
    public let error: String?
}

public struct ClientWorktreeRisk: Decodable, Equatable, Sendable {
    public let worktreeId: String?
    public let code: String
    public let message: String
}

public struct ClientWorktreeProgress: Decodable, Equatable, Sendable {
    public let completed: Int
    public let total: Int
    public let fraction: Double
}

public struct ClientWorktreeConflictResolution: Decodable, Equatable, Sendable {
    public let status: String
    public let worktreeId: String?
    public let taskId: String?
    public let sessionId: String?
    public let agentId: String?
    public let agentName: String?
    public let sessionStatus: String?
}

public struct ClientWorktreeConflictAutomation: Decodable, Equatable, Sendable {
    public let status: String
    public let scopeWorktreeIds: [String]
    public let completedWorktreeIds: [String]
    public let taskId: String?
    public let sessionId: String?
    public let sessionName: String?
    public let agentId: String?
    public let agentName: String?
    public let currentWorktreeId: String?
    public let blockedWorktreeId: String?
    public let conflictFiles: [String]
    public let failureCode: String?
    public let failureReason: String?
}

public struct ClientWorktreeCommitDecision: Encodable, Equatable, Sendable {
    public let worktreeId: String
    public let decision: String
    public let neverRemind: Bool
    public init(worktreeId: String, decision: String, neverRemind: Bool) {
        self.worktreeId = worktreeId; self.decision = decision; self.neverRemind = neverRemind
    }
}

/// Request values deliberately differ from the operation names in a returned plan.
public enum ClientWorktreePlanOperation: String, CaseIterable, Sendable {
    case merge = "batch_merge"
    case synchronize = "one_way_sync"
    case converge
}

public struct ClientWorktreePlanRequest: Encodable, Sendable {
    public let operationType: ClientWorktreePlanOperation
    public let sourceWorktreeIds: [String]
    public let targetWorktreeId: String
    public init(operation: ClientWorktreePlanOperation, sources: [String], target: String) throws {
        guard !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ClientServiceFailure(statusCode: 400, code: "TARGET_WORKTREE_REQUIRED")
        }
        var seen = Set<String>()
        let ordered = sources.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && seen.insert($0).inserted }
        guard ordered.contains(where: { $0 != target }) else {
            throw ClientServiceFailure(statusCode: 400, code: "SOURCE_WORKTREE_REQUIRED")
        }
        guard operation == .converge || !ordered.contains(target) else {
            throw ClientServiceFailure(statusCode: 400, code: "SOURCE_EQUALS_TARGET")
        }
        operationType = operation
        sourceWorktreeIds = operation == .converge && !ordered.contains(target) ? [target] + ordered : ordered
        targetWorktreeId = target
    }
}

extension ClientWorktreePlanOperation: Encodable {}

public struct ClientWorktreeAPI: Sendable {
    private let transport: BackendTransport
    private let decoder = JSONDecoder()
    public init(transport: BackendTransport) { self.transport = transport }

    public func repository(_ id: String, forceFresh: Bool = false) async throws -> ClientManagedRepositoryDetail {
        try await get(["client", "v1", "worktrees", "repositories", id],
                      query: forceFresh ? [URLQueryItem(name: "forceFresh", value: "true")] : [])
    }

    public func pushStatus(repositoryId: String, worktreeId: String) async throws -> ClientGitHubPushStatus {
        let envelope: PushStatusEnvelope = try await get(["client", "v1", "worktrees", "repositories", repositoryId,
                                                          "worktrees", worktreeId, "github-push-status"])
        return envelope.gitHubPush ?? ClientGitHubPushStatus(available: false, pending: false, dirty: false,
                                                              unpushedCommitCount: 0, branch: nil,
                                                              destinationUrl: nil, error: nil)
    }

    public func developmentService(_ repositoryId: String) async throws -> ClientDevelopmentServiceStatus {
        try await get(["client", "v1", "worktrees", "repositories", repositoryId, "development-service"])
    }

    public func preparePlan(repositoryId: String, operationType: ClientWorktreePlanOperation? = nil,
                            sources: [String]? = nil, target: String? = nil) async throws -> ClientWorktreeJob {
        let body = try operationType.map { try ClientWorktreePlanRequest(operation: $0, sources: sources ?? [], target: target ?? "") }
        let envelope: JobEnvelope = try await post(["client", "v1", "worktrees", "repositories", repositoryId,
                                                    "integration-plans"],
                                                   body.map(PlanBody.explicit) ?? .automatic)
        return envelope.job
    }

    public func job(_ id: String) async throws -> ClientWorktreeJob {
        let envelope: JobEnvelope = try await get(["client", "v1", "worktrees", "jobs", id])
        return envelope.job
    }

    public func confirm(job: ClientWorktreeJob, decisions: [ClientWorktreeCommitDecision]) async throws -> ClientWorktreeJob {
        struct Body: Encodable { let confirmed: Bool; let planFingerprint: String; let commitProtectionDecisions: [ClientWorktreeCommitDecision] }
        return try await jobAction(job.id, "confirm", Body(confirmed: true, planFingerprint: job.planFingerprint,
                                                            commitProtectionDecisions: decisions))
    }

    public func cancel(jobId: String) async throws -> ClientWorktreeJob {
        struct Body: Encodable { let replan = false }
        return try await jobAction(jobId, "cancel", Body())
    }

    public func retry(jobId: String) async throws -> ClientWorktreeJob {
        try await jobAction(jobId, "retry", EmptyBody())
    }

    public func resolveConflict(jobId: String) async throws -> ClientWorktreeJob {
        try await jobAction(jobId, "resolve-conflict", EmptyBody())
    }

    public func delete(repositoryId: String, worktreeId: String) async throws {
        let _: EmptyResponse = try await post(["client", "v1", "worktrees", "repositories", repositoryId,
                                               "worktrees", worktreeId, "delete"], EmptyBody())
    }

    public func workspaceAction(repositoryId: String, worktreeId: String, action: String,
                                commitMessage: String? = nil, privateFilesDecision: String? = nil,
                                neverRemindPrivateFiles: Bool = false, synchronizeSource: Bool? = nil) async throws {
        struct Body: Encodable {
            let commitMessage: String?; let privateFilesDecision: String?
            let neverRemindPrivateFiles: Bool; let synchronizeSource: Bool?
        }
        let _: EmptyResponse = try await post(["client", "v1", "worktrees", "repositories", repositoryId,
                                               "workspaces", worktreeId, "actions", action],
                                              Body(commitMessage: commitMessage,
                                                   privateFilesDecision: privateFilesDecision,
                                                   neverRemindPrivateFiles: neverRemindPrivateFiles,
                                                   synchronizeSource: synchronizeSource))
    }

    public func push(repositoryId: String, worktreeId: String) async throws -> ClientGitHubPushResult {
        let envelope: ResultEnvelope<ClientGitHubPushResult> = try await actionResult(
            repositoryId: repositoryId, worktreeId: worktreeId, action: "push", body: EmptyBody())
        guard envelope.result.pushed else { throw ClientConnectionError.invalidResponse }
        return envelope.result
    }

    public func commitPreparation(repositoryId: String, worktreeId: String) async throws -> ClientGitCommitProtectionStatus {
        let envelope: ResultEnvelope<ClientGitCommitProtectionStatus> = try await actionResult(
            repositoryId: repositoryId, worktreeId: worktreeId, action: "commit-prepare", body: EmptyBody())
        return envelope.result
    }

    public func commitMessage(repositoryId: String, worktreeId: String) async throws -> String {
        let envelope: ResultEnvelope<CommitMessageResult> = try await actionResult(
            repositoryId: repositoryId, worktreeId: worktreeId, action: "commit-message", body: EmptyBody())
        return envelope.result.commitMessage
    }

    public func developmentServiceAction(repositoryId: String, action: String, profileId: String? = nil) async throws {
        struct Body: Encodable { let profileId: String? }
        let _: EmptyResponse = try await post(["client", "v1", "worktrees", "repositories", repositoryId,
                                               "development-service", "actions", action], Body(profileId: profileId))
    }

    private func jobAction<B: Encodable>(_ id: String, _ action: String, _ body: B) async throws -> ClientWorktreeJob {
        let envelope: JobEnvelope = try await post(["client", "v1", "worktrees", "jobs", id, "actions", action], body)
        return envelope.job
    }

    private func actionResult<R: Decodable, B: Encodable>(repositoryId: String, worktreeId: String,
                                                           action: String, body: B) async throws -> ResultEnvelope<R> {
        try await post(["client", "v1", "worktrees", "repositories", repositoryId,
                        "workspaces", worktreeId, "actions", action], body)
    }

    private func get<R: Decodable>(_ path: [String], query: [URLQueryItem] = []) async throws -> R {
        let (data, _) = try await transport.data(for: transport.endpoint.request(path: path, query: query))
        return try decoder.decode(R.self, from: data)
    }

    private func post<R: Decodable, B: Encodable>(_ path: [String], _ body: B) async throws -> R {
        var request = try transport.endpoint.request(path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await transport.data(for: request)
        return try decoder.decode(R.self, from: data)
    }
}

private struct EmptyBody: Encodable {}
private enum PlanBody: Encodable {
    case automatic, explicit(ClientWorktreePlanRequest)
    func encode(to encoder: Encoder) throws {
        switch self {
        case .automatic: try EmptyBody().encode(to: encoder)
        case .explicit(let request): try request.encode(to: encoder)
        }
    }
}
private struct EmptyResponse: Decodable {}
private struct JobEnvelope: Decodable { let job: ClientWorktreeJob }
private struct ResultEnvelope<Result: Decodable>: Decodable { let result: Result }
private struct CommitMessageResult: Decodable { let commitMessage: String }
private struct PushStatusEnvelope: Decodable { let gitHubPush: ClientGitHubPushStatus? }
