import Foundation

/// One bounded current-Session projection, shared by every frontend.
public struct ClientSessionWorktreeDetail: Decodable, Equatable, Sendable {
    public struct AutoFollow: Decodable, Equatable, Sendable {
        public let enabled: Bool
        public let status: String
        public let reason: String?
        public let jobId: String?
    }
    public struct Worktree: Decodable, Equatable, Sendable {
        public let worktreeId: String
        public let path: String
        public let branchName: String?
        public let isMain: Bool
        public let availability: String
        public let dirty: Bool?
        public let changedFiles: [String]
        public let changedFileCount: Int?
        public let aheadOfMain: Int?
        public let behindMain: Int?
        public let operationState: String?
        public let conflictFiles: [String]
    }
    public let attached: Bool
    public let repositoryId: String?
    public let mainWorktreeId: String?
    public let mainBranch: String?
    public let blockedReason: String?
    public let worktree: Worktree?
    public let job: ClientWorktreeJob?
    public let autoFollow: AutoFollow?

    public func canPerform(_ action: ClientWorktreePlanOperation) -> Bool {
        guard attached, blockedReason == nil, let worktree, !worktree.isMain,
              worktree.availability == "available", worktree.dirty == false,
              worktree.operationState == nil, worktree.conflictFiles.isEmpty,
              let ahead = worktree.aheadOfMain, let behind = worktree.behindMain,
              repositoryId != nil, mainWorktreeId != nil,
              !["awaiting_confirmation", "queued", "running", "paused", "cancellation_requested", "replanning"].contains(job?.status ?? "") else { return false }
        switch action {
        case .synchronize: return behind > 0
        case .merge: return ahead > 0 && behind == 0
        case .converge: return false
        }
    }
}

/// Closed desktop/paired routes, not a generic HTTP proxy. All mutations reuse
/// the project-level plan service and its revision/approval/idle guards.
public struct ClientSessionWorktreeAPI: Sendable {
    public enum Route: Sendable { case desktop, pairedDevice }
    private let transport: BackendTransport
    private let route: Route
    public init(transport: BackendTransport, route: Route) { self.transport = transport; self.route = route }
    private var root: [String] {
        switch route { case .desktop: ["worktree-management"]; case .pairedDevice: ["client", "v1", "worktrees"] }
    }
    public func detail(sessionID: String) async throws -> ClientSessionWorktreeDetail {
        switch route {
        case .desktop: return try await request(["sessions", sessionID, "worktree-detail"])
        case .pairedDevice:
            let value = try await ClientInspectorAPI(transport: transport).read(sessionID: sessionID, resource: "session-worktree")
            return try JSONDecoder().decode(ClientSessionWorktreeDetail.self, from: JSONEncoder().encode(value))
        }
    }
    public func prepare(sessionID: String, action: ClientWorktreePlanOperation) async throws -> ClientWorktreeJob {
        let current = try await detail(sessionID: sessionID)
        guard current.canPerform(action), let repository = current.repositoryId,
              let source = current.worktree?.worktreeId, let target = current.mainWorktreeId else {
            throw ClientServiceFailure(statusCode: 409, code: current.blockedReason ?? "WORKTREE_STATE_CHANGED")
        }
        // In one_way_sync the service rebases each SOURCE onto TARGET, not
        // the reverse. Both operations keep current tree as source, main as target.
        let body = try ClientWorktreePlanRequest(operation: action, sources: [source], target: target)
        let result: Envelope = try await request(root + ["repositories", repository, "integration-plans"], body: JSONEncoder().encode(body))
        return result.job
    }
    public func setAutoFollow(sessionID: String, worktreeID: String, enabled: Bool) async throws {
        switch route {
        case .desktop:
            struct Body: Encodable { let enabled: Bool; let expectedWorktreeId: String }
            let _: ClientSessionWorktreeDetail.AutoFollow = try await request(["sessions", sessionID, "worktree-auto-follow"],
                body: JSONEncoder().encode(Body(enabled: enabled, expectedWorktreeId: worktreeID)))
        case .pairedDevice:
            let receipt = try await ClientInspectorAPI(transport: transport).command(sessionID: sessionID,
                requestID: UUID().uuidString, action: "worktree.autoFollow",
                fields: ["enabled": .bool(enabled), "expectedWorktreeId": .string(worktreeID)])
            guard receipt.status == "completed" else {
                throw ClientServiceFailure(statusCode: receipt.status == "rejected" ? 409 : 503,
                    code: receipt.errorCode ?? "AUTO_FOLLOW_OUTCOME_UNCERTAIN")
            }
        }
    }
    public func confirm(_ job: ClientWorktreeJob) async throws -> ClientWorktreeJob {
        guard job.status == "awaiting_confirmation", job.plan.blockingRisks.isEmpty,
              job.plan.items.allSatisfy({ !$0.dirty && $0.commitStatus == "not_needed" }) else {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_REVIEW_BLOCKED")
        }
        struct Body: Encodable { let confirmed = true; let planFingerprint: String; let commitProtectionDecisions: [ClientWorktreeCommitDecision] = [] }
        let value: Envelope = try await request(root + ["jobs", job.id, "confirm"], body: JSONEncoder().encode(Body(planFingerprint: job.planFingerprint)))
        return value.job
    }
    public func job(_ id: String) async throws -> ClientWorktreeJob {
        let result: Envelope = try await request(root + ["jobs", id]); return result.job
    }
    public func jobAction(_ id: String, action: String) async throws -> ClientWorktreeJob {
        guard ["cancel", "retry"].contains(action) else { throw ClientConnectionError.invalidEndpoint }
        let result: Envelope = try await request(root + ["jobs", id, action], body: Data("{}".utf8)); return result.job
    }
    private struct Envelope: Decodable { let job: ClientWorktreeJob }
    private func request<T: Decodable>(_ path: [String], body: Data? = nil) async throws -> T {
        var request = try transport.endpoint.request(path: path)
        if let body {
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = body
        }
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
