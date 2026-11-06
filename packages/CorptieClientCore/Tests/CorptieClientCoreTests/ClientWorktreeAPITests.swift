import Foundation
import Testing
@testable import CorptieClientCore

@Suite(.serialized) struct ClientWorktreeAPITests {
    @Test func staleRegistrationDeletionCarriesExplicitOperation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeProtocol.self]
        let api = ClientWorktreeAPI(transport: try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!), configuration: configuration))
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/repositories/repo/worktrees/stale/delete")
            let body = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
            #expect(body["action"] as? String == "remove_stale_registration")
            return "{}"
        }
        try await api.delete(repositoryId: "repo", worktreeId: "stale", registrationOnly: true)
    }

    @Test func rollbackPreviewAndConfirmationRetainExactJobReviewAndImpactChoices() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeProtocol.self]
        let api = ClientWorktreeAPI(transport: try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!), configuration: configuration))
        let job = #"{"id":"job:rollback","repositoryId":"repo","status":"paused","phase":"rollback_review","planFingerprint":"review","createdAt":"now","updatedAt":"now","availableActions":["rollback","resume","cancel"],"plan":{"repositoryId":"repo","mainWorktreeId":"main","mainPath":"/repo","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":1,"total":2,"fraction":0.5}}"#
        let preview = #"{"id":"review:exact","jobId":"job:rollback","targets":[{"worktreeId":"main","path":"/repo","branchName":"main","baselineHead":"before","currentHead":"after","operation":null,"changedFiles":[" M shared.txt"],"ownedCommits":["merged"],"additionalCommits":["extra"],"requiresPreservation":true,"published":false,"mode":"review_additional_history"}]}"#
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/jobs/job:rollback/actions/cancel-preview")
            return "{\"job\":\(job),\"rollback\":\(preview)}"
        }
        let prepared = try await api.prepareRollback(jobId: "job:rollback")
        let review = try #require(prepared.rollback)
        #expect(review.targets[0].additionalCommits == ["extra"])
        #expect(prepared.job.supports("resume"))
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/jobs/job:rollback/actions/rollback")
            let body = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
            #expect(body["confirmed"] as? Bool == true)
            #expect(body["reviewId"] as? String == "review:exact")
            #expect(body["discardChanges"] as? Bool == true)
            #expect(body["includeAdditionalCommits"] as? Bool == false)
            return "{\"job\":\(job)}"
        }
        _ = try await api.rollback(jobId: prepared.job.id, reviewId: review.id, discardChanges: true, includeAdditionalCommits: false)
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/jobs/job:rollback/actions/resume")
            return "{\"job\":\(job)}"
        }
        _ = try await api.resumeRollbackReview(jobId: prepared.job.id)
    }
    @Test func markdownRecoveryKeepsExactJobAndBlockerOnPairedDeviceRoutes() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeProtocol.self]
        let api = ClientWorktreeAPI(transport: try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!), configuration: configuration))
        let response = #"{"job":{"id":"job:policy","repositoryId":"repo","status":"paused","phase":"awaiting_commit_policy_resolution","planFingerprint":"review","createdAt":"now","updatedAt":"now","availableActions":["resolve_commit_policy","cancel"],"commitPolicyBlocker":{"id":"blocker:exact","version":3,"worktreeId":"feature","files":[{"path":"plan.md","supportedActions":["ignore","artifact","track","delete"],"appliedAction":null}]},"commitPolicyResidue":{"id":"residue","paths":["old.md"],"supportedActions":["keep_ignore","track"]},"plan":{"repositoryId":"repo","mainWorktreeId":"main","mainPath":"/repo","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":0,"total":1,"fraction":0}}}"#
        WorktreeProtocol.handler = { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/client/v1/worktrees/jobs/job:policy/actions/commit-policy-prepare")
            return response
        }
        let job = try await api.prepareCommitPolicy(jobId: "job:policy")
        let blocker = try #require(job.commitPolicyBlocker)
        #expect(blocker.files.first?.supportedActions.contains("artifact") == true)
        #expect(job.commitPolicyResidue?.paths == ["old.md"])
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/jobs/job:policy/actions/commit-policy-decisions")
            let body = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
            #expect(body["blockerId"] as? String == "blocker:exact")
            #expect(body["version"] as? Int == 3)
            #expect(body["decisions"] as? [[String: String]] == [["path": "plan.md", "action": "artifact"]])
            return response
        }
        _ = try await api.resolveCommitPolicy(jobId: job.id, blocker: blocker, decisions: [.init(path: "plan.md", action: "artifact")])
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/jobs/job:policy/actions/commit-policy-residue")
            let body = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
            #expect(body["decisions"] as? [[String: String]] == [["path": "old.md", "action": "keep_ignore"]])
            return response
        }
        _ = try await api.resolveCommitPolicyResidue(jobId: job.id, decisions: [.init(path: "old.md", action: "keep_ignore")])
    }
    @Test func conflictAutomationAcceptsLegacyNumericProcessCodesWithoutLosingItsDiagnostic() throws {
        let cases: [(String, String?)] = [("128", "PROCESS_EXIT_128"), ("\"128\"", "PROCESS_EXIT_128"),
            ("\"MERGE_CONFLICT\"", "MERGE_CONFLICT"), ("null", nil)]
        for (raw, expected) in cases {
            let data = Data("{\"status\":\"blocked\",\"scopeWorktreeIds\":[],\"completedWorktreeIds\":[],\"conflictFiles\":[],\"failureCode\":\(raw),\"failureReason\":\"full index lock diagnostic\"}".utf8)
            let state = try JSONDecoder().decode(ClientWorktreeConflictAutomation.self, from: data)
            #expect(state.failureCode == expected)
            #expect(state.failureReason == "full index lock diagnostic")
        }
    }

    @Test func recoveryActionsAndCompleteDiagnosticsSurviveDecoding() throws {
        var value = try JSONSerialization.jsonObject(with: Data(#"{"id":"job:1","repositoryId":"repo:one","status":"paused","phase":"failed","planFingerprint":"fingerprint","createdAt":"now","updatedAt":"now","availableActions":["repreflight","cancel"],"recovery":{"kind":"repreflight","message":"Review a fresh plan"},"plan":{"repositoryId":"repo:one","mainWorktreeId":"main","mainPath":"/repo","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":1,"total":3,"fraction":0.333}}"#.utf8)) as! [String: Any]
        let full = String(repeating: "诊断 👨‍👩‍👧‍👦\n", count: 3_000) + "LAST_DIAGNOSTIC"
        value["diagnosticText"] = full
        let job = try JSONDecoder().decode(ClientWorktreeJob.self, from: JSONSerialization.data(withJSONObject: value))
        #expect(job.supports("repreflight"))
        #expect(!job.supports("retry"))
        #expect(job.canCancel)
        #expect(!job.shouldPoll)
        #expect(job.diagnosticText == full)
        #expect(job.recovery?.kind == "repreflight")
        value["status"] = "completed"
        value["availableActions"] = [] as [String]
        value["completionEvidence"] = ["schemaVersion": 1, "repositoryId": "repo:one", "mainWorktreeId": "main",
            "branchName": "main", "mainHead": "verified-main", "verifiedHeads": ["source"], "verifiedAt": "now"] as [String: Any]
        let completed = try JSONDecoder().decode(ClientWorktreeJob.self, from: JSONSerialization.data(withJSONObject: value))
        #expect(completed.completionEvidence?.mainHead == "verified-main")
        #expect(completed.completionEvidence?.verifiedHeads == ["source"])
        #expect(!completed.canCancel)
    }

    @Test func busyErrorsPreserveOptionalContextAndLegacyCompatibility() async throws {
        for rich in [false, true] {
            let context = rich ? #","busyContext":{"worktreeId":"tree","sessionId":"session","sessionTitle":"Busy Session","reason":"UNSETTLED_DELIVERY","count":3}"# : ""
            let data = Data((#"{"code":"TASK_HIERARCHY_BUSY","error":"TASK_HIERARCHY_BUSY""# + context + "}").utf8)
            let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!)
            let transport = BackendTransport(endpoint: endpoint, data: { request in
                (data, HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw URLError(.unsupportedURL) })
            do {
                _ = try await ClientWorktreeAPI(transport: transport).preparePlan(repositoryId: "repo")
                Issue.record("expected busy failure")
            } catch let failure as ClientServiceFailure {
                #expect(failure.statusCode == 409)
                #expect(failure.message == nil)
                #expect(failure.busyContext?.count == (rich ? 3 : nil))
                let message = try #require(ClientWorktreeBusyContext.failureMessage(code: failure.code, context: failure.busyContext, localize: { $0 }))
                #expect(!message.contains("TASK_HIERARCHY_BUSY"))
                if rich { #expect(message.contains("Busy Session")); #expect(message.contains("3")) }
            }
        }
        #expect(ClientWorktreeBusyContext.failureMessage(code: "UNRELATED", context: nil, localize: { $0 }) == nil)
    }

    @Test func busyReasonDescriptionsHaveSafeFallbacks() throws {
        for reason in ["ACTIVE_TURN", "WAITING_APPROVAL", "UNSETTLED_DELIVERY", "BACKGROUND_OPERATION", "INTEGRATION_JOB", "FUTURE_REASON"] {
            let data = Data("{\"reason\":\"\(reason)\"}".utf8)
            let context = try JSONDecoder().decode(ClientWorktreeBusyContext.self, from: data)
            let message = ClientWorktreeBusyContext.failureMessage(code: "TASK_HIERARCHY_BUSY", context: context, localize: { $0 })
            #expect(message?.isEmpty == false)
            #expect(message?.contains("%@") == false)
        }
    }

    @Test func integrationPlanUsesBackendOperationNamesAndOrderedSourcesOnWire() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeProtocol.self]
        let api = ClientWorktreeAPI(transport: try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!), configuration: configuration))
        for operation in ClientWorktreePlanOperation.allCases {
            WorktreeProtocol.handler = { request in
                #expect(request.httpMethod == "POST")
                #expect(request.url?.path == "/client/v1/worktrees/repositories/repo:one/integration-plans")
                let body = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
                #expect(body["operationType"] as? String == operation.rawValue)
                #expect(body["targetWorktreeId"] as? String == "main")
                #expect(body["sourceWorktreeIds"] as? [String] == (operation == .converge ? ["main", "b", "a"] : ["b", "a"]))
                return #"{"job":{"id":"job:1","repositoryId":"repo:one","status":"awaiting_confirmation","phase":"plan","planFingerprint":"fingerprint","createdAt":"now","updatedAt":"now","plan":{"repositoryId":"repo:one","mainWorktreeId":"main","mainPath":"/repo","mainHeadBefore":"abc","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":0,"total":2,"fraction":0}}}"#
            }
            let job = try await api.preparePlan(repositoryId: "repo:one", operationType: operation,
                                                sources: ["b", "a", "b"], target: "main")
            #expect(job.id == "job:1")
        }
    }

    @Test func unbornRepositoryPlanDecodesWithoutAHeadCommit() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeProtocol.self]
        let api = ClientWorktreeAPI(transport: try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!), configuration: configuration))
        WorktreeProtocol.handler = { request in
            #expect(request.url?.path == "/client/v1/worktrees/repositories/repo:empty/integration-plans")
            return #"{"job":{"id":"job:empty","repositoryId":"repo:empty","status":"awaiting_confirmation","phase":"plan","planFingerprint":"fingerprint","createdAt":"now","updatedAt":"now","plan":{"repositoryId":"repo:empty","mainWorktreeId":"main","mainPath":"/repo","mainHeadBefore":null,"inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":0,"total":0,"fraction":0}}}"#
        }

        let job = try await api.preparePlan(repositoryId: "repo:empty")

        #expect(job.plan.mainHeadBefore == nil)
    }

    @Test func invalidPlanSelectionIsRejectedBeforeTransport() throws {
        #expect(throws: ClientServiceFailure.self) {
            try ClientWorktreePlanRequest(operation: .merge, sources: ["main"], target: "main")
        }
        #expect(throws: ClientServiceFailure.self) {
            try ClientWorktreePlanRequest(operation: .synchronize, sources: ["a"], target: "")
        }
        #expect(throws: ClientServiceFailure.self) {
            try ClientWorktreePlanRequest(operation: .merge, sources: ["main", "a"], target: "main")
        }
    }
    @Test func fullRepositoryContractAndActionsStayOnClosedClientRoutes() async throws {
        WorktreeProtocol.handler = { request in
            #expect(request.url?.host == "127.0.0.1")
            if request.httpMethod == "POST" {
                #expect(request.url?.path == "/client/v1/worktrees/repositories/repo:one/workspaces/tree:one/actions/push")
                return #"{"projectId":"repo:one","workspaceId":"tree:one","action":"push","result":{"pushed":true,"committed":false,"commitMessage":null,"headOid":"abc","branch":"task/test","destinationUrl":"https://github.com/example/repo"},"project":{"worktrees":[]}}"#
            }
            #expect(request.url?.path == "/client/v1/worktrees/repositories/repo:one")
            #expect(request.url?.query == "forceFresh=true")
            return #"{"repository":{"id":"repo:one","path":"/repo","name":"Repo","discoveredAt":"now","lastValidatedAt":"now","mainPath":"/repo","availability":"available","worktreeCount":1},"project":{"repositoryId":"repo:one","inventoryVersion":"1","mainWorktreeId":"tree:one","mainPath":"/repo","mainBranch":"main","mainHeadOid":"abc","pendingWorktreeCount":0,"worktrees":[{"worktreeId":"tree:one","path":"/repo","isMain":true,"availability":"available","headOid":"abc","branchName":"main","isDetached":false,"isLocked":false,"lockReason":null,"isPrunable":false,"pruneReason":null,"state":"ready","dirty":false,"statusSummary":"clean","diffStat":null,"changedFiles":[],"operationState":null,"conflictFiles":[],"mergedIntoMain":true,"synchronizedWithMain":true,"aheadOfMain":0,"behindMain":0,"pendingIntegration":false,"associations":[],"deletionBlocker":null,"gitHubPush":null}]},"latestJob":null}"#
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!),
                                             configuration: configuration)
        let api = ClientWorktreeAPI(transport: transport)
        let detail = try await api.repository("repo:one", forceFresh: true)
        #expect(detail.project.worktrees.first?.branchName == "main")
        let result = try await api.push(repositoryId: "repo:one", worktreeId: "tree:one")
        #expect(result.pushed)
        #expect(result.branch == "task/test")
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
        if count == 0 { break }
        body.append(contentsOf: buffer.prefix(count))
    }
    return body
}

private final class WorktreeProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> String)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let json = try Self.handler?(request) ?? "{}"
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
