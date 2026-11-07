import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@Suite(.serialized) @MainActor
struct PadWorktreeTests {
    private func policyJob(version: Int = 1) throws -> ClientWorktreeJob {
        try JSONDecoder().decode(ClientWorktreeJob.self, from: policyData(version: version))
    }

    private func policyData(version: Int = 1) throws -> Data {
        var value = try JSONSerialization.jsonObject(with: Data(Self.job.utf8)) as! [String: Any]
        value["status"] = "paused"
        value["availableActions"] = ["resolve_commit_policy", "cancel"]
        value["commitPolicyBlocker"] = ["id": "blocker", "version": version, "worktreeId": "source",
            "files": [["path": "plan.md", "supportedActions": ["ignore", "track"], "appliedAction": NSNull()]]] as [String: Any]
        return try JSONSerialization.data(withJSONObject: value)
    }

    @Test func markdownVersionChangeNeverReusesAnOlderDecision() async throws {
        let (store, connection) = try fixture()
        let reviewed = try policyJob()
        store.job = try policyJob(version: 2)
        #expect(!PadWorktreeStore.markdownReviewMatches(reviewed, current: store.job))
        #expect(!(await store.handleMarkdown(jobID: reviewed.id, decisions: [.init(path: "plan.md", action: "track")],
            reviewedJob: reviewed, connection: connection)))
        #expect(WorktreeStateProtocol.calls.isEmpty)
        #expect(store.errorMessage?.contains("处理要求已变化") == true)
    }

    @Test func markdownDecisionsRequireReviewAndExactSupportedPathsAndActions() async throws {
        let (store, connection) = try fixture()
        let reviewed = try policyJob()
        store.job = reviewed
        #expect(!(await store.handleMarkdown(jobID: reviewed.id, decisions: [.init(path: "plan.md", action: "track")], connection: connection)))
        let choices: [[ClientWorktreeMarkdownDecision]] = [[], [.init(path: "other.md", action: "track")],
            [.init(path: "plan.md", action: "delete")], [.init(path: "plan.md", action: "track"), .init(path: "plan.md", action: "track")]]
        for choice in choices {
            #expect(!(await store.handleMarkdown(jobID: reviewed.id, decisions: choice, reviewedJob: reviewed, connection: connection)))
        }
        #expect(WorktreeStateProtocol.calls.isEmpty)
    }

    @Test func markdownReviewInvalidatesWhenResidueOrSupportedActionsChange() throws {
        let reviewed = try policyJob()
        #expect(PadWorktreeStore.markdownReviewMatches(reviewed, current: reviewed))
        var value = try JSONSerialization.jsonObject(with: policyData()) as! [String: Any]
        value["commitPolicyResidue"] = ["id": "residue", "paths": ["old.md"], "supportedActions": ["keep_ignore"]]
        let residue = try JSONDecoder().decode(ClientWorktreeJob.self, from: JSONSerialization.data(withJSONObject: value))
        #expect(!PadWorktreeStore.markdownReviewMatches(reviewed, current: residue))
        var changed = try JSONSerialization.jsonObject(with: policyData()) as! [String: Any]
        var blocker = changed["commitPolicyBlocker"] as! [String: Any]
        var files = blocker["files"] as! [[String: Any]]
        files[0]["supportedActions"] = ["ignore"]
        blocker["files"] = files
        changed["commitPolicyBlocker"] = blocker
        let supportedActionsChanged = try JSONDecoder().decode(ClientWorktreeJob.self, from: JSONSerialization.data(withJSONObject: changed))
        #expect(!PadWorktreeStore.markdownReviewMatches(reviewed, current: supportedActionsChanged))
        #expect(!PadWorktreeStore.markdownReviewMatches(nil, current: reviewed))
    }

    @Test func rollbackCannotBePreparedFromAnUnconfirmedPlanOrConfirmedWithoutAReview() async throws {
        let (store, connection) = try fixture()
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.utf8))
        do { _ = try await store.prepareRollback(jobID: "job:test", connection: connection); Issue.record("Unexpected prepare") } catch { }
        do { try await store.confirmRollback(jobID: "job:test", reviewID: "invented", discardChanges: true,
            includeAdditionalCommits: true, connection: connection); Issue.record("Unexpected rollback") } catch { }
        #expect(WorktreeStateProtocol.calls.isEmpty)
    }

    @Test func acceptedMarkdownDecisionsSendTheReviewedVersionOnce() async throws {
        let (store, connection) = try fixture()
        let reviewed = try policyJob()
        store.job = reviewed
        WorktreeStateProtocol.response = { _ in (200, "{\"job\":\(Self.job)}") }
        #expect(await store.handleMarkdown(jobID: reviewed.id, decisions: [.init(path: "plan.md", action: "track")],
            reviewedJob: reviewed, connection: connection))
        #expect(WorktreeStateProtocol.calls == ["POST /client/v1/worktrees/jobs/job:test/actions/commit-policy-decisions"])
    }

    private func rollbackFixture(_ store: PadWorktreeStore, targets: String = "[]") throws {
        let reviewJob = Self.job.replacingOccurrences(of: "awaiting_confirmation", with: "paused")
            .replacingOccurrences(of: "\"phase\":\"plan\"", with: "\"phase\":\"rollback_review\"")
            .replacingOccurrences(of: "[\"confirm\",\"cancel\"]", with: "[\"rollback\",\"resume\",\"cancel\"]")
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(reviewJob.utf8))
        WorktreeStateProtocol.response = { _ in (200, "{\"job\":\(reviewJob),\"rollback\":{\"id\":\"review:exact\",\"jobId\":\"job:test\",\"targets\":\(targets)}}") }
    }

    @Test func rollbackRequiresTheLatestPreparedReviewAndCannotReplayAfterFailure() async throws {
        let (store, connection) = try fixture()
        try rollbackFixture(store)
        _ = try await store.prepareRollback(jobID: "job:test", connection: connection)
        #expect(!store.jobBusy)
        WorktreeStateProtocol.calls = []
        do { try await store.confirmRollback(jobID: "job:test", reviewID: "stale", discardChanges: false,
            includeAdditionalCommits: false, connection: connection); Issue.record("Stale review accepted") } catch { }
        #expect(WorktreeStateProtocol.calls.isEmpty)
        WorktreeStateProtocol.response = { _ in (409, #"{"code":"ROLLBACK_REVIEW_REQUIRED","error":"Review changed"}"#) }
        for _ in 0..<2 {
            do { try await store.confirmRollback(jobID: "job:test", reviewID: "review:exact", discardChanges: false,
                includeAdditionalCommits: false, connection: connection); Issue.record("Unexpected rollback success") } catch { }
        }
        #expect(WorktreeStateProtocol.calls.count == 1, "A failed write invalidates the review; it is never silently replayed")
    }

    @Test func rollbackDoesNotDiscardEditsOrExtraHistoryWithoutBothChoices() async throws {
        let (store, connection) = try fixture()
        let targets = #"[{"worktreeId":"main","path":"/fixture","baselineHead":"before","currentHead":"after","changedFiles":["edit"],"ownedCommits":[],"additionalCommits":["extra"],"requiresPreservation":true,"published":true,"mode":"review_additional_history"}]"#
        try rollbackFixture(store, targets: targets)
        _ = try await store.prepareRollback(jobID: "job:test", connection: connection)
        WorktreeStateProtocol.calls = []
        for (discard, history) in [(false, false), (true, false), (false, true)] {
            do { try await store.confirmRollback(jobID: "job:test", reviewID: "review:exact", discardChanges: discard,
                includeAdditionalCommits: history, connection: connection); Issue.record("Missing consent accepted") } catch { }
        }
        #expect(WorktreeStateProtocol.calls.isEmpty)
    }

    @Test func nullRollbackPreviewWaitsWithoutInventingAReview() async throws {
        let (store, connection) = try fixture()
        try rollbackFixture(store)
        let reviewJob = try #require(store.job)
        let json = Self.job.replacingOccurrences(of: "awaiting_confirmation", with: "paused")
            .replacingOccurrences(of: "\"phase\":\"plan\"", with: "\"phase\":\"rollback_review\"")
            .replacingOccurrences(of: "[\"confirm\",\"cancel\"]", with: "[\"rollback\",\"resume\",\"cancel\"]")
        WorktreeStateProtocol.response = { _ in (200, "{\"job\":\(json),\"rollback\":null}") }
        let (preview, waiting) = try await store.prepareRollback(jobID: reviewJob.id, connection: connection)
        #expect(preview == nil)
        #expect(waiting)
        #expect(!store.jobBusy)
        WorktreeStateProtocol.calls = []
        do { try await store.confirmRollback(jobID: reviewJob.id, reviewID: "invented", discardChanges: true,
            includeAdditionalCommits: true, connection: connection); Issue.record("Missing review accepted") } catch { }
        #expect(WorktreeStateProtocol.calls.isEmpty)
    }

    @Test func markdownDecisionsCannotBeSentToAReplacementOrUnrelatedJob() async throws {
        let (store, connection) = try fixture()
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.utf8))
        #expect(!(await store.handleMarkdown(jobID: "another-job", decisions: [.init(path: "plan.md", action: "delete")], connection: connection)))
        #expect(WorktreeStateProtocol.calls.isEmpty)
        #expect(!(await store.handleMarkdown(jobID: "job:test", decisions: [.init(path: "plan.md", action: "delete")], connection: connection)))
        #expect(WorktreeStateProtocol.calls.isEmpty)
        #expect(store.errorMessage?.contains("处理要求已变化") == true)
    }
    @Test func serverFailurePreservesFullTextAndUnavailableRetryIsExplained() async throws {
        let full = String(repeating: "Git error line\n", count: 2_000) + "LAST_GIT_DETAIL"
        let message = PadWorktreeFailure.describe(ClientServiceFailure(statusCode: 500,
            code: "MERGE_FAILED", message: full), stage: "继续合并", mutation: true)
        #expect(message.contains(full))
        let (store, connection) = try fixture()
        let json = Self.job.replacingOccurrences(of: "\"status\":\"awaiting_confirmation\"",
            with: "\"status\":\"paused\",\"availableActions\":[\"repreflight\",\"cancel\"],\"recovery\":{\"kind\":\"repreflight\",\"message\":\"必须重新生成计划\"}")
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(json.utf8))
        #expect(!(await store.jobAction("retry", connection: connection)))
        #expect(store.errorMessage == "必须重新生成计划")
        #expect(WorktreeStateProtocol.calls.isEmpty)
    }
    private func fixture() throws -> (PadWorktreeStore, PadConnection) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeStateProtocol.self]
        let connection = PadConnection(transportOverride: try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:1")!), configuration: configuration))
        connection.serverID = "worktree-test-\(UUID())"
        let store = PadWorktreeStore()
        store.detail = try JSONDecoder().decode(ClientManagedRepositoryDetail.self, from: Data(Self.repository.utf8))
        WorktreeStateProtocol.calls = []
        WorktreeStateProtocol.failPost = false
        WorktreeStateProtocol.serveRepository = false
        WorktreeStateProtocol.response = nil
        return (store, connection)
    }

    @Test func busyFailureNamesTheBlockingSessionAndRetainsLegacyFallback() throws {
        let context = try JSONDecoder().decode(ClientWorktreeBusyContext.self, from: Data(#"{"sessionTitle":"Busy Session","reason":"UNSETTLED_DELIVERY","count":3}"#.utf8))
        let message = PadWorktreeFailure.describe(ClientServiceFailure(statusCode: 409,
            code: "TASK_HIERARCHY_BUSY", busyContext: context), stage: "准备合并")
        #expect(message.contains("Busy Session"))
        #expect(message.contains("3 条"))
        #expect(message.contains("未结束的消息投递"))
        let legacy = PadWorktreeFailure.describe(ClientServiceFailure(statusCode: 409,
            code: "TASK_HIERARCHY_BUSY"), stage: "准备合并")
        #expect(legacy.contains("会话或 Git 操作"))
    }

    @Test func simultaneousPlanRequestsOnlySendOnce() async throws {
        let (store, connection) = try fixture()
        let first = Task { await store.preparePlan(operation: .merge, sources: ["source"], target: "main", connection: connection) }
        let second = Task { await store.preparePlan(operation: .merge, sources: ["source"], target: "main", connection: connection) }
        await first.value
        await second.value
        #expect(WorktreeStateProtocol.calls.filter { $0.hasPrefix("POST") }.count == 1)
        #expect(store.job?.id == "job:test")
        #expect(!store.planning)
        UserDefaults.standard.removeObject(forKey: "corptie.worktree.job:\(connection.serverID):\(connection.address):repo:test")
    }

    @MainActor private final class PollProbe { var received = false }

    @Test func pollingResponseCannotReplaceANewerCommandSnapshot() async throws {
        let store = PadWorktreeStore()
        let probe = PollProbe()
        let running = Self.job.replacingOccurrences(of: "awaiting_confirmation", with: "running")
        let repository = Self.repository.replacingOccurrences(of: "\"latestJob\":null", with: "\"latestJob\":\(running)")
        let completed = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job
            .replacingOccurrences(of: "awaiting_confirmation", with: "completed")
            .replacingOccurrences(of: "fingerprint:one", with: "fingerprint:new").utf8))
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
            let json: String
            if request.url!.path == "/client/v1/worktrees/repositories/repo:test" { json = repository }
            else if request.url!.path == "/client/v1/worktrees/jobs/job:test" {
                // A command finishes while this older GET is still in flight.
                await MainActor.run { store.job = completed; probe.received = true }
                json = "{\"job\":\(running)}"
            } else { throw URLError(.resourceUnavailable) }
            return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!)
        }, bytes: { _ in throw URLError(.unsupportedURL) })
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = "poll-test-\(UUID())"
        defer {
            store.reset()
            UserDefaults.standard.removeObject(forKey: "corptie.worktree.job:\(connection.serverID):\(connection.address):repo:test")
        }
        await store.load("repo:test", connection: connection)
        let deadline = ContinuousClock.now + .seconds(3)
        while !probe.received, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(probe.received)
        try await Task.sleep(for: .milliseconds(100))
        #expect(store.job == completed)
    }

    @Test func staleReviewedPlanNeverConfirmsTheReplacement() async throws {
        let (store, connection) = try fixture()
        let reviewed = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.utf8))
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.replacingOccurrences(of: "fingerprint:one", with: "fingerprint:two").utf8))
        await store.jobAction("confirm", reviewedJob: reviewed, connection: connection)
        #expect(WorktreeStateProtocol.calls.isEmpty)
        #expect(store.errorMessage?.contains("重新查看") == true)
    }

    @Test func staleReviewedPlanNeverCancelsTheReplacement() async throws {
        let (store, connection) = try fixture()
        let reviewed = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.utf8))
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.replacingOccurrences(of: "fingerprint:one", with: "fingerprint:two").utf8))
        let cancelled = await store.jobAction("cancel", reviewedJob: reviewed, connection: connection)
        #expect(!cancelled)
        #expect(WorktreeStateProtocol.calls.isEmpty)
    }

    @Test func successfulServiceActionWithFailedReadIsNotReportedAsFailedMutation() async throws {
        let (store, connection) = try fixture()
        await store.serviceAction("restart", connection: connection)
        #expect(store.errorMessage == nil)
        #expect(store.notice?.contains("已提交，但状态读取失败") == true)
        #expect(WorktreeStateProtocol.calls.filter { $0.hasPrefix("POST") }.count == 1)
        #expect(!store.serviceBusy)
    }

    @Test func repositoryRendersWhenOptionalDevelopmentServiceFails() async throws {
        let (store, connection) = try fixture()
        store.detail = nil
        WorktreeStateProtocol.serveRepository = true
        await store.load("repo:test", connection: connection)
        #expect(store.detail?.repository.id == "repo:test")
        #expect(store.service == nil)
        #expect(store.errorMessage == nil)
        #expect(!store.loading)
    }

    @Test func rejectedPlanKeepsConcreteErrorAndDoesNotRetry() async throws {
        let (store, connection) = try fixture()
        WorktreeStateProtocol.failPost = true
        await store.preparePlan(operation: .merge, sources: ["source"], target: "main", connection: connection)
        #expect(store.errorMessage?.contains("BRANCH_OPERATION_INVALID") == true)
        #expect(WorktreeStateProtocol.calls.count == 1)
        #expect(!store.planning)
    }

    @Test func mergeSelectionDefaultsToEveryPendingNonMainWorktree() throws {
        func tree(_ id: String, main: Bool = false, pending: Bool) -> String {
            #"{"worktreeId":"\#(id)","path":"/repo/\#(id)","isMain":\#(main),"availability":"available","branchName":"\#(id)","isDetached":false,"isLocked":false,"state":"readyToMerge","changedFiles":[],"conflictFiles":[],"pendingIntegration":\#(pending),"associations":[]}"#
        }
        let json = #"{"repositoryId":"repo:test","inventoryVersion":"1","mainWorktreeId":"main","mainPath":"/repo","pendingWorktreeCount":2,"worktrees":["#
            + [tree("main", main: true, pending: false), tree("one", pending: true),
               tree("merged", pending: false), tree("two", pending: true)].joined(separator: ",") + "]}"
        let project = try JSONDecoder().decode(ClientManagedGitProject.self, from: Data(json.utf8))
        #expect(PadWorktreePlanDefaults.sources(in: project) == ["one", "two"])
    }

    @Test func individualOperationUsesStateAwareDefaultsAndRequiresExplicitProtectionDecision() throws {
        let json = #"{"worktreeId":"source","path":"/repo/source","isMain":false,"availability":"available","branchName":"source","isDetached":false,"isLocked":false,"state":"readyToMerge","dirty":true,"changedFiles":["secret.txt"],"conflictFiles":[],"mergedIntoMain":false,"synchronizedWithMain":false,"pendingIntegration":true,"associations":[]}"#
        let protectionJSON = #"{"repositoryRoot":"/repo/source","requiresDecision":true,"protectedPaths":["secret.txt"],"suggestedIgnorePatterns":["secret.txt"],"warningEnabled":true}"#
        let tree = try JSONDecoder().decode(ClientManagedWorktree.self, from: Data(json.utf8))
        let protection = try JSONDecoder().decode(ClientGitCommitProtectionStatus.self, from: Data(protectionJSON.utf8))
        var draft = PadWorktreeOperationDraft(worktree: tree, commitMessage: "Commit", protection: protection)
        #expect(draft.mergeIntoMain)
        #expect(draft.synchronizeWithMain)
        #expect(!draft.restartService)
        #expect(!draft.canExecute)
        draft.privateFilesDecision = "exclude"
        #expect(!draft.canExecute)
        draft.privateFilesDecision = "ignore"
        #expect(draft.canExecute)
        draft.mergeIntoMain = false
        draft.synchronizeWithMain = false
        #expect(!draft.canExecute)
    }

    @Test func freshMergePlanCancelsOnlyAnUnconfirmedDraftBeforePreparing() async throws {
        let (store, connection) = try fixture()
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.utf8))
        await store.preparePlan(replacingDraft: true, connection: connection)
        #expect(WorktreeStateProtocol.calls.filter { $0.hasPrefix("POST") } == [
            "POST /client/v1/worktrees/jobs/job:test/actions/cancel",
            "POST /client/v1/worktrees/repositories/repo:test/integration-plans"
        ])
        #expect(store.errorMessage == nil)
        UserDefaults.standard.removeObject(forKey: "corptie.worktree.job:\(connection.serverID):\(connection.address):repo:test")
    }

    nonisolated static let job = #"{"id":"job:test","repositoryId":"repo:test","status":"awaiting_confirmation","availableActions":["confirm","cancel"],"phase":"plan","planFingerprint":"fingerprint:one","createdAt":"now","updatedAt":"now","plan":{"repositoryId":"repo:test","mainWorktreeId":"main","mainPath":"/repo","mainHeadBefore":"abc","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":0,"total":1,"fraction":0}}"#
    private static let repository = #"{"repository":{"id":"repo:test","path":"/repo","name":"Repo","discoveredAt":"now","lastValidatedAt":"now","mainPath":"/repo","availability":"available","worktreeCount":0},"project":{"repositoryId":"repo:test","inventoryVersion":"1","mainWorktreeId":"main","mainPath":"/repo","mainBranch":"main","mainHeadOid":"abc","pendingWorktreeCount":0,"worktrees":[]},"latestJob":null}"#
}

private final class WorktreeStateProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var calls: [String] = []
    nonisolated(unsafe) static var failPost = false
    nonisolated(unsafe) static var serveRepository = false
    nonisolated(unsafe) static var response: ((URLRequest) -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.calls.append("\(request.httpMethod ?? "") \(request.url!.path)")
        if let response = Self.response {
            let (status, json) = response(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let isPost = request.httpMethod == "POST"
        let isRepository = request.url!.path == "/client/v1/worktrees/repositories/repo:test"
        let status = isPost ? (Self.failPost ? 400 : 200) : (Self.serveRepository && isRepository ? 200 : 503)
        let json = status == 400 ? #"{"code":"BRANCH_OPERATION_INVALID","error":"invalid operation"}"#
            : status == 503 ? #"{"code":"READ_UNAVAILABLE","error":"unavailable"}"#
            : isRepository ? #"{"repository":{"id":"repo:test","path":"/repo","name":"Repo","discoveredAt":"now","lastValidatedAt":"now","mainPath":"/repo","availability":"available","worktreeCount":0},"project":{"repositoryId":"repo:test","inventoryVersion":"1","mainWorktreeId":"main","mainPath":"/repo","mainBranch":"main","mainHeadOid":"abc","pendingWorktreeCount":0,"worktrees":[]},"latestJob":null}"#
            : request.url!.path.hasSuffix("integration-plans") ? "{\"job\":\(PadWorktreeTests.job)}"
            : request.url!.path.hasSuffix("/cancel")
                ? "{\"job\":\(PadWorktreeTests.job.replacingOccurrences(of: "awaiting_confirmation", with: "cancelled"))}"
                : "{}"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
