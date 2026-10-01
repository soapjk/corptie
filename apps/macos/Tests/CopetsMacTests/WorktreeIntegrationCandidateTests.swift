import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct WorktreeIntegrationCandidateTests {
    @MainActor
    @Test func prepareUsesCandidateEndpointWithoutCancelingExistingJob() async throws {
        let recorder = CandidateRequestRecorder()
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"

        await client.prepareFreshPlan()

        #expect(client.candidate?.ttlMs == 300_000)
        #expect(client.candidate?.fingerprintVersion == 1)
        #expect(recorder.paths == [
            "/worktree-management/repositories/repository:one/integration-candidates"
        ])
        #expect(!recorder.paths.contains { $0.contains("/cancel") })

        client.discardCandidateReview()
        #expect(client.candidate == nil)
    }

    @MainActor
    @Test func confirmationUsesCandidateBoundOperationScope() async throws {
        let candidate = Self.candidateEnvelope
            .replacingOccurrences(of: "\"operationType\":\"merge\",\"sourceWorktreeIds\":[\"wt:feature\"],\"targetWorktreeId\":\"wt:main\",\"generatedAt\"", with: "\"operationType\":\"sync\",\"sourceWorktreeIds\":[\"wt:bound\"],\"targetWorktreeId\":\"wt:target\",\"generatedAt\"")
        let recorder = CandidateRequestRecorder(
            startResponses: [(202, Self.jobEnvelope)],
            candidateResponses: [(200, candidate)]
        )
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"

        await client.prepareFreshPlan()
        #expect(await client.confirmPlan())

        let body = recorder.startBodies.first
        #expect(body?["operationType"] as? String == "sync")
        #expect(body?["sourceWorktreeIds"] as? [String] == ["wt:bound"])
        #expect(body?["targetWorktreeId"] as? String == "wt:target")
    }

    @MainActor
    @Test func confirmationReusesItsIdempotencyKeyAcrossTransportRetry() async throws {
        let recorder = CandidateRequestRecorder(startResponses: [
            (500, "{\"error\":\"try again\",\"code\":\"TEMPORARY\"}"),
            (202, Self.jobEnvelope)
        ])
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()

        #expect(await client.confirmPlan() == false)
        #expect(await client.confirmPlan() == true)
        #expect(client.job?.id == "job:one")
        #expect(client.candidate == nil)

        let bodies = recorder.startBodies
        #expect(bodies.count == 2)
        guard bodies.count == 2 else { return }
        let firstKey = bodies[0]["idempotencyKey"] as? String
        #expect(firstKey?.isEmpty == false)
        #expect(bodies[0]["candidateId"] as? String == "candidate:1")
        #expect(bodies[0]["operationType"] as? String == "merge")
        #expect(bodies[0]["sourceWorktreeIds"] as? [String] == ["wt:feature"])
        #expect(bodies[0]["targetWorktreeId"] as? String == "wt:main")
        #expect(bodies[1]["idempotencyKey"] as? String == firstKey)
    }

    @MainActor
    @Test func confirmationBindsCommitProtectionDecisionToReviewedCandidate() async throws {
        let recorder = CandidateRequestRecorder(startResponses: [(202, Self.jobEnvelope)])
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()

        let decision = WorktreeCommitProtectionDecision(
            worktreeId: "wt:feature",
            decision: "ignore",
            neverRemind: true,
            candidateFingerprint: client.candidate?.planFingerprint,
            protectedPathsDigest: "protected-paths-digest"
        )
        #expect(await client.confirmPlan(commitProtectionDecisions: [decision]))

        let submitted = recorder.startBodies.first?["commitProtectionDecisions"] as? [[String: Any]]
        #expect(submitted?.count == 1)
        #expect(submitted?.first?["candidateFingerprint"] as? String == "fingerprint-one")
        #expect(submitted?.first?["protectedPathsDigest"] as? String == "protected-paths-digest")
    }

    @Test func legacyCandidateAndProtectionPayloadsDecodeWithoutBindingFields() throws {
        let legacyCandidate = Self.candidate()
            .replacingOccurrences(of: "\"fingerprintVersion\":1,", with: "")
            .replacingOccurrences(of: "\"mainHeadBefore\":\"abc123\"", with: "\"mainHeadBefore\":null")
        let decodedCandidate = try JSONDecoder().decode(
            WorktreeIntegrationCandidate.self,
            from: Data(legacyCandidate.utf8)
        )
        #expect(decodedCandidate.fingerprintVersion == nil)
        #expect(decodedCandidate.plan.mainHeadBefore == nil)

        let legacyProtection = """
        {"repositoryRoot":"/tmp/repository","protectedPaths":[".env"],"localSymlinkPaths":[],"suggestedIgnorePatterns":[".env"],"warningEnabled":true,"requiresDecision":true}
        """
        let decodedProtection = try JSONDecoder().decode(
            WorktreeIntegrationCommitProtectionStatus.self,
            from: Data(legacyProtection.utf8)
        )
        #expect(decodedProtection.protectedPathsDigest == nil)
    }

    @MainActor
    @Test func confirmationRejectsCandidateFromPreviouslySelectedRepository() async throws {
        let recorder = CandidateRequestRecorder()
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()

        client.selection.repositoryId = "repository:two"
        #expect(await client.confirmPlan() == false)
        #expect(client.candidate == nil)
        #expect(client.errorMessage?.isEmpty == false)
        #expect(recorder.startBodies.isEmpty)
    }

    @MainActor
    @Test func failedPreparationStaysInReviewAndRetriesTheSameRequest() async throws {
        let recorder = CandidateRequestRecorder(candidateResponses: [
            (500, "{\"error\":\"preflight unavailable\",\"code\":\"TEMPORARY\"}"),
            (200, Self.candidateEnvelope)
        ])
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"

        await client.prepareBranchOperation(
            operationType: "converge",
            sourceWorktreeIds: ["wt:feature"],
            targetWorktreeId: "wt:main"
        )
        #expect(client.candidate == nil)
        #expect(client.candidatePreparationError?.contains("preflight unavailable") == true)
        #expect(client.errorMessage == nil)

        await client.retryCandidatePreparation()
        #expect(client.candidate?.id == "candidate:1")
        #expect(client.candidatePreparationError == nil)
        #expect(recorder.candidateBodies.count == 2)
        #expect(recorder.candidateBodies[1]["operationType"] as? String == "converge")
        #expect(recorder.candidateBodies[1]["sourceWorktreeIds"] as? [String] == ["wt:feature"])
        #expect(recorder.candidateBodies[1]["targetWorktreeId"] as? String == "wt:main")
    }

    @MainActor
    @Test func changedConfirmationDecisionsRotateIdempotencyKey() async throws {
        let recorder = CandidateRequestRecorder(startResponses: [
            (500, "{\"error\":\"try again\"}"),
            (500, "{\"error\":\"try again\"}"),
            (202, Self.jobEnvelope)
        ])
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()
        let ignored = WorktreeCommitProtectionDecision(
            worktreeId: "wt:feature",
            decision: "ignore",
            neverRemind: false,
            candidateFingerprint: "fingerprint-one",
            protectedPathsDigest: "digest-one"
        )
        let included = WorktreeCommitProtectionDecision(
            worktreeId: "wt:feature",
            decision: "include",
            neverRemind: false,
            candidateFingerprint: "fingerprint-one",
            protectedPathsDigest: "digest-one"
        )

        #expect(await client.confirmPlan(commitProtectionDecisions: [ignored]) == false)
        #expect(await client.confirmPlan(commitProtectionDecisions: [ignored]) == false)
        #expect(await client.confirmPlan(commitProtectionDecisions: [included]) == true)
        let keys = recorder.startBodies.compactMap { $0["idempotencyKey"] as? String }
        #expect(keys.count == 3)
        guard keys.count == 3 else { return }
        #expect(keys[0] == keys[1])
        #expect(keys[2] != keys[1])
    }

    @MainActor
    @Test func candidateReviewCannotBeDiscardedWhileConfirmationIsInFlight() async throws {
        let recorder = CandidateRequestRecorder(
            startResponses: [(202, Self.jobEnvelope)],
            startDelay: 0.05
        )
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()

        let confirmation = Task { @MainActor in await client.confirmPlan() }
        for _ in 0..<100 where !client.isMutating { await Task.yield() }
        #expect(client.isMutating)
        client.discardCandidateReview()
        #expect(client.candidate?.id == "candidate:1")
        #expect(await confirmation.value)
    }

    @MainActor
    @Test func noWorkCandidateIsConfirmedIntoCurrentCompletedJob() async throws {
        let noWorkCandidate = Self.candidateEnvelope.replacingOccurrences(
            of: "\"noWorkRequired\":false",
            with: "\"noWorkRequired\":true"
        )
        let completedJob = Self.jobEnvelope
            .replacingOccurrences(of: "\"status\":\"queued\"", with: "\"status\":\"completed\"")
            .replacingOccurrences(of: "\"phase\":\"queued\"", with: "\"phase\":\"completed\"")
            .replacingOccurrences(of: "\"completedAt\":null", with: "\"completedAt\":\"2026-10-01T00:00:01Z\"")
        let recorder = CandidateRequestRecorder(
            startResponses: [(202, completedJob)],
            candidateResponses: [(200, noWorkCandidate)]
        )
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"

        await client.prepareFreshPlan()
        #expect(client.candidate?.noWorkRequired == true)
        #expect(await client.confirmPlan() == true)
        #expect(client.job?.status == "completed")
        #expect(client.job?.completedAt != nil)
        #expect(client.candidate == nil)
        #expect(recorder.startBodies.count == 1)
    }

    @MainActor
    @Test func refreshWithoutPlanDriftStillMarksReviewAsRefreshed() async throws {
        let refresh = """
        {"error":"candidate expired","code":"PLAN_REFRESH_REQUIRED","candidate":\(Self.candidate(sequence: 2, fingerprint: "fingerprint-two")),"diff":{"addedWorktreeIds":[],"removedWorktreeIds":[],"changedWorktrees":[],"risks":{"changed":false,"before":[],"after":[]},"mergeOrder":{"changed":false,"before":["wt:feature"],"after":["wt:feature"]},"changed":false}}
        """
        let recorder = CandidateRequestRecorder(startResponses: [(409, refresh)])
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()

        #expect(await client.confirmPlan() == false)
        #expect(client.candidate?.id == "candidate:2")
        #expect(client.candidateRefreshDiff?.isEmpty == true)
        #expect(client.candidateReview.wasRefreshed == true)
    }

    @MainActor
    @Test func refreshRequiredReplacesCandidateWithoutCreatingAJob() async throws {
        let refresh = """
        {"error":"review changed plan","code":"PLAN_REFRESH_REQUIRED","candidate":\(Self.candidate(sequence: 2, fingerprint: "fingerprint-two")),"diff":{"addedWorktreeIds":["wt:new"],"removedWorktreeIds":[],"changedWorktrees":[{"worktreeId":"wt:feature","changes":[{"field":"sourceHeadBefore","before":"abc123","after":"def456"}]}],"risks":{"changed":false,"before":[],"after":[]},"mergeOrder":{"changed":true,"before":["wt:feature"],"after":["wt:new","wt:feature"]},"contextChanges":[{"field":"inventoryVersion","before":"one","after":"two"}],"reason":null,"changed":true}}
        """
        let recorder = CandidateRequestRecorder(startResponses: [
            (409, refresh),
            (500, "{\"error\":\"try again\",\"code\":\"TEMPORARY\"}"),
            (202, Self.jobEnvelope)
        ])
        let client = makeClient(recorder)
        client.selection.repositoryId = "repository:one"
        await client.prepareFreshPlan()

        #expect(await client.confirmPlan() == false)
        #expect(client.job == nil)
        #expect(client.candidate?.id == "candidate:2")
        #expect(client.candidate?.planFingerprint == "fingerprint-two")
        #expect(client.candidateRefreshDiff?.addedWorktreeIds == ["wt:new"])
        #expect(client.candidateRefreshDiff?.mergeOrder.changed == true)
        #expect(client.candidateRefreshDiff?.contextChanges?.map(\.field) == ["inventoryVersion"])
        #expect(client.errorMessage == nil)

        #expect(await client.confirmPlan() == false)
        #expect(await client.confirmPlan() == true)
        let bodies = recorder.startBodies
        #expect(bodies.count == 3)
        guard bodies.count == 3 else { return }
        let staleKey = bodies[0]["idempotencyKey"] as? String
        let refreshedKey = bodies[1]["idempotencyKey"] as? String
        #expect(refreshedKey != staleKey)
        #expect(bodies[2]["idempotencyKey"] as? String == refreshedKey)
    }

    @MainActor
    private func makeClient(_ recorder: CandidateRequestRecorder) -> WorktreeManagementClient {
        CandidateURLProtocol.recorder = recorder
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CandidateURLProtocol.self]
        return WorktreeManagementClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            session: URLSession(configuration: configuration)
        )
    }

    fileprivate static func candidate(sequence: Int = 1, fingerprint: String = "fingerprint-one") -> String {
        """
        {"id":"candidate:\(sequence)","repositoryId":"repository:one","planFingerprint":"\(fingerprint)","fingerprint":"\(fingerprint)","fingerprintVersion":1,"operationType":"merge","sourceWorktreeIds":["wt:feature"],"targetWorktreeId":"wt:main","generatedAt":"2026-10-01T00:00:00Z","expiresAt":"2026-10-01T00:05:00Z","ttlMs":300000,"plan":\(plan),"progress":{"completed":0,"total":1,"fraction":0},"noWorkRequired":false}
        """
    }

    fileprivate static let candidateEnvelope = "{\"candidate\":\(candidate())}"

    fileprivate static let plan = """
    {"repositoryId":"repository:one","operationType":"merge","syncMode":null,"targetWorktreeId":"wt:main","targetBranchName":"main","sourceWorktreeIds":["wt:feature"],"executionPath":"/tmp/repository","mainWorktreeId":"wt:main","mainPath":"/tmp/repository","mainHeadBefore":"abc123","inventoryVersion":"inventory-one","mergeOrder":["wt:feature"],"blockingRisks":[],"items":[]}
    """

    fileprivate static let jobEnvelope = """
    {"job":{"id":"job:one","repositoryId":"repository:one","status":"queued","phase":"queued","planFingerprint":"fingerprint-one","error":null,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:01Z","confirmedAt":"2026-10-01T00:00:01Z","completedAt":null,"plan":\(plan),"currentWorktreeId":null,"progress":{"completed":0,"total":1,"fraction":0},"audit":[],"conflictResolution":null,"conflictAutomation":null,"commitProtectionDecisions":{}}}
    """
}

private final class CandidateRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [(Int, String)]
    private var candidateResponses: [(Int, String)]
    private let startDelay: TimeInterval
    private(set) var paths: [String] = []
    private(set) var candidateBodies: [[String: Any]] = []
    private(set) var startBodies: [[String: Any]] = []

    init(
        startResponses: [(Int, String)] = [],
        candidateResponses: [(Int, String)] = [],
        startDelay: TimeInterval = 0
    ) {
        responses = startResponses
        self.candidateResponses = candidateResponses
        self.startDelay = startDelay
    }

    func response(for request: URLRequest) -> (Int, String) {
        lock.withLock {
            let path = request.url?.path ?? ""
            paths.append(path)
            if path.hasSuffix("/integration-candidates") {
                if let data = Self.bodyData(from: request),
                   let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    candidateBodies.append(body)
                }
                return candidateResponses.isEmpty
                    ? (200, WorktreeIntegrationCandidateTests.candidateEnvelope)
                    : candidateResponses.removeFirst()
            }
            if path.hasSuffix("/integration-jobs") {
                if startDelay > 0 { Thread.sleep(forTimeInterval: startDelay) }
                if let data = Self.bodyData(from: request),
                   let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    startBodies.append(body)
                }
                return responses.isEmpty
                    ? (500, "{\"error\":\"missing response\"}")
                    : responses.removeFirst()
            }
            return (404, "{\"error\":\"unexpected path\"}")
        }
    }

    private static func bodyData(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { return body }
            body.append(contentsOf: buffer.prefix(count))
        }
    }
}

private final class CandidateURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var recorder: CandidateRequestRecorder?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let recorder = Self.recorder, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, body) = recorder.response(for: request)
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
