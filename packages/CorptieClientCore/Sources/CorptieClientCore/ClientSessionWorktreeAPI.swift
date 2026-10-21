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
        public var hierarchy: WorktreeHierarchy? = nil
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
    public var workId: String? = nil
    public let repositoryId: String?
    public let mainWorktreeId: String?
    public let mainBranch: String?
    public let blockedReason: String?
    public let worktree: Worktree?
    public let job: ClientWorktreeJob?
    public let autoFollow: AutoFollow?

    public func canPerform(_ action: ClientWorktreePlanOperation) -> Bool {
        if let h=worktree?.hierarchy {
            guard attached,blockedReason == nil,worktree?.dirty == false,job?.shouldPoll != true else {return false}
            switch action {
            case .merge: return h.role == "child" && h.actions.mergeToParent.available
            case .synchronize: return h.role == "child" ? h.actions.syncFromParent.available : h.actions.syncFromMain.available
            case .converge: return false
            }
        }
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
    private let expectedWorktreeID: String?
    public init(transport: BackendTransport, route: Route, expectedWorktreeID: String? = nil) {
        self.transport = transport; self.route = route; self.expectedWorktreeID = expectedWorktreeID
    }
    private var root: [String] {
        switch route { case .desktop: ["worktree-management"]; case .pairedDevice: ["client", "v1", "worktrees"] }
    }
    public var hierarchyAPI: ClientTaskHierarchyAPI {
        ClientTaskHierarchyAPI(transport:transport,surface:route == .desktop ? .local : .pairedDevice)
    }
    public func prepareHierarchy(sessionID: String, action: String, receiptId: String? = nil) async throws -> ClientWorktreeJob {
        let current=try await detail(sessionID:sessionID)
        guard let h=current.worktree?.hierarchy,let source=current.worktree?.worktreeId,let repository=current.repositoryId,
              let main=current.mainWorktreeId, let workID=current.workId, current.blockedReason == nil else {
            throw ClientServiceFailure(statusCode:409,code:current.blockedReason ?? "WORKTREE_BINDING_CHANGED")
        }
        var sources=[source]
        if h.role == "parent" && ["merge_children","sync_children"].contains(action) {
            sources=[]
            var cursor:String?
            repeat {
                let page=try await hierarchyAPI.page(workID:workID,parentTaskID:h.rootTaskId,cursor:cursor,includeArchived:true)
                for task in page.tasks {
                    guard let id=task.hierarchy?.deliveryWorktreeId else { throw ClientServiceFailure(statusCode:409,code:"PARENT_WORKTREE_REQUIRED") }
                    sources.append(id)
                }
                cursor=page.nextCursor
                if sources.count>100 { throw ClientServiceFailure(statusCode:409,code:"TASK_SCOPE_TOO_LARGE") }
            } while cursor != nil
        }
        let target=["merge_children","sync_children"].contains(action) ? (h.parentWorktreeId ?? source) : main
        let operation:ClientWorktreePlanOperation=["sync_children","sync_main"].contains(action) ? .synchronize : .merge
        let body=try ClientWorktreePlanRequest(operation:operation,sources:sources,target:target,taskScope:h.scope(action,receiptId:receiptId),syncStrategy:action == "sync_main" ? "merge" : nil)
        let result:Envelope=try await request(root+["repositories",repository,"integration-plans"],body:JSONEncoder().encode(body))
        return result.job
    }
    public func detail(sessionID: String) async throws -> ClientSessionWorktreeDetail {
        let detail: ClientSessionWorktreeDetail
        switch route {
        case .desktop: detail = try await request(["sessions", sessionID, "worktree-detail"])
        case .pairedDevice:
            let value = try await ClientInspectorAPI(transport: transport).read(sessionID: sessionID, resource: "session-worktree")
            detail = try JSONDecoder().decode(ClientSessionWorktreeDetail.self, from: JSONEncoder().encode(value))
        }
        if let expectedWorktreeID, detail.worktree?.worktreeId != expectedWorktreeID {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_BINDING_CHANGED")
        }
        return detail
    }
    public func prepare(sessionID: String, action: ClientWorktreePlanOperation, expectedWorktreeID: String? = nil) async throws -> ClientWorktreeJob {
        let current = try await detail(sessionID: sessionID)
        if let expectedWorktreeID, current.worktree?.worktreeId != expectedWorktreeID {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_BINDING_CHANGED")
        }
        if let h=current.worktree?.hierarchy {
            return try await prepareHierarchy(sessionID:sessionID,action:action == .merge ? "merge_children" : h.role == "child" ? "sync_children" : "sync_main")
        }
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
        if let expectedWorktreeID, expectedWorktreeID != worktreeID {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_BINDING_CHANGED")
        }
        let current=try await detail(sessionID:sessionID),h=current.worktree?.hierarchy
        switch route {
        case .desktop:
            struct Body: Encodable { let enabled: Bool; let expectedWorktreeId: String; let expectedTargetWorktreeId: String?; let expectedHierarchyRevision: Int?; let expectedBindingRevision: Int? }
            let _: ClientSessionWorktreeDetail.AutoFollow = try await request(["sessions", sessionID, "worktree-auto-follow"],
                body: JSONEncoder().encode(Body(enabled: enabled, expectedWorktreeId: worktreeID,expectedTargetWorktreeId:h?.comparison.worktreeId,expectedHierarchyRevision:h?.hierarchyRevision,expectedBindingRevision:h?.bindingRevision)))
        case .pairedDevice:
            var fields:[String:ClientInspectorValue]=["enabled":.bool(enabled),"expectedWorktreeId":.string(worktreeID)]
            if let h { fields["expectedTargetWorktreeId"] = .string(h.comparison.worktreeId)
                fields["expectedHierarchyRevision"] = .number(Double(h.hierarchyRevision)); fields["expectedBindingRevision"] = .number(Double(h.bindingRevision)) }
            let receipt = try await ClientInspectorAPI(transport: transport).command(sessionID: sessionID,
                requestID: UUID().uuidString, action: "worktree.autoFollow",
                fields: fields)
            guard receipt.status == "completed" else {
                throw ClientServiceFailure(statusCode: receipt.status == "rejected" ? 409 : 503,
                    code: receipt.errorCode ?? "AUTO_FOLLOW_OUTCOME_UNCERTAIN")
            }
        }
    }
    /// Reuses the management page's commit protection and command endpoints.
    /// A commit never implies merge, synchronize, push, or a service restart.
    public func prepareCommit(sessionID: String, worktreeID: String) async throws -> ClientGitCommitProtectionStatus {
        let current = try await commitDetail(sessionID: sessionID, worktreeID: worktreeID)
        switch route {
        case .desktop:
            return try await request(["sessions", sessionID, "project-worktrees", worktreeID, "commit-prepare"], body: Data("{}".utf8))
        case .pairedDevice:
            return try await ClientWorktreeAPI(transport: transport).commitPreparation(repositoryId: current.repositoryId!, worktreeId: worktreeID)
        }
    }
    public func commit(sessionID: String, worktreeID: String, message: String, privateFilesDecision: String?) async throws {
        let current = try await commitDetail(sessionID: sessionID, worktreeID: worktreeID)
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              privateFilesDecision == nil || ["ignore", "include"].contains(privateFilesDecision!) else {
            throw ClientServiceFailure(statusCode: 400, code: "COMMIT_REVIEW_REQUIRED")
        }
        switch route {
        case .desktop:
            struct Body: Encodable { let commitMessage: String; let privateFilesDecision: String? }
            let _: ClientInspectorValue = try await request(["sessions", sessionID, "project-worktrees", worktreeID, "commit"],
                body: JSONEncoder().encode(Body(commitMessage: message, privateFilesDecision: privateFilesDecision)))
        case .pairedDevice:
            try await ClientWorktreeAPI(transport: transport).workspaceAction(repositoryId: current.repositoryId!, worktreeId: worktreeID,
                action: "commit", commitMessage: message, privateFilesDecision: privateFilesDecision)
        }
    }
    private func commitDetail(sessionID: String, worktreeID: String) async throws -> ClientSessionWorktreeDetail {
        let current = try await detail(sessionID: sessionID)
        guard let tree = current.worktree, tree.worktreeId == worktreeID, current.repositoryId != nil,
              tree.availability == "available", tree.dirty == true, tree.operationState == nil, tree.conflictFiles.isEmpty,
              current.blockedReason == nil || ["MAIN_WORKTREE", "UNCOMMITTED_CHANGES"].contains(current.blockedReason!),
              !["awaiting_confirmation", "queued", "running", "paused", "cancellation_requested", "replanning"].contains(current.job?.status ?? "") else {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_STATE_CHANGED")
        }
        return current
    }
    public func confirm(_ job: ClientWorktreeJob, sessionID: String? = nil) async throws -> ClientWorktreeJob {
        try validateJobBinding(job)
        if let sessionID {
            let current = try await detail(sessionID: sessionID)
            guard let id = current.worktree?.worktreeId, job.plan.items.contains(where: { $0.worktreeId == id }) else {
                throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_BINDING_CHANGED")
            }
        }
        guard job.status == "awaiting_confirmation", job.plan.blockingRisks.isEmpty,
              job.plan.items.allSatisfy({ !$0.dirty && $0.commitStatus == "not_needed" }) else {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_REVIEW_BLOCKED")
        }
        struct Body: Encodable { let confirmed = true; let planFingerprint: String; let commitProtectionDecisions: [ClientWorktreeCommitDecision] = [] }
        let value: Envelope = try await request(root + ["jobs", job.id, "confirm"], body: JSONEncoder().encode(Body(planFingerprint: job.planFingerprint)))
        return value.job
    }
    public func job(_ id: String) async throws -> ClientWorktreeJob {
        let result: Envelope = try await request(root + ["jobs", id]); try validateJobBinding(result.job); return result.job
    }
    public func jobAction(_ id: String, action: String, sessionID: String? = nil) async throws -> ClientWorktreeJob {
        guard ["cancel", "retry"].contains(action) else { throw ClientConnectionError.invalidEndpoint }
        if expectedWorktreeID != nil || sessionID != nil {
            let currentJob = try await job(id)
            if action == "retry", let sessionID {
                let current = try await detail(sessionID: sessionID)
                guard let treeID = current.worktree?.worktreeId, currentJob.plan.items.contains(where: { $0.worktreeId == treeID }) else {
                    throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_BINDING_CHANGED")
                }
            }
        }
        let result: Envelope = try await request(root + ["jobs", id, action], body: Data("{}".utf8)); return result.job
    }
    private struct Envelope: Decodable { let job: ClientWorktreeJob }
    private func validateJobBinding(_ job: ClientWorktreeJob) throws {
        if let expectedWorktreeID, !job.plan.items.contains(where: { $0.worktreeId == expectedWorktreeID }) {
            throw ClientServiceFailure(statusCode: 409, code: "WORKTREE_BINDING_CHANGED")
        }
    }
    private func request<T: Decodable>(_ path: [String], body: Data? = nil) async throws -> T {
        var request = try transport.endpoint.request(path: path)
        if let body {
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = body
        }
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
