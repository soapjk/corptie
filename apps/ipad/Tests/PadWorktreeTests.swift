import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@Suite(.serialized) @MainActor
struct PadWorktreeTests {
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
        return (store, connection)
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

    @Test func staleReviewedPlanNeverConfirmsTheReplacement() async throws {
        let (store, connection) = try fixture()
        let reviewed = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.utf8))
        store.job = try JSONDecoder().decode(ClientWorktreeJob.self, from: Data(Self.job.replacingOccurrences(of: "fingerprint:one", with: "fingerprint:two").utf8))
        await store.jobAction("confirm", reviewedJob: reviewed, connection: connection)
        #expect(WorktreeStateProtocol.calls.isEmpty)
        #expect(store.errorMessage?.contains("重新查看") == true)
    }

    @Test func successfulServiceActionWithFailedReadIsNotReportedAsFailedMutation() async throws {
        let (store, connection) = try fixture()
        await store.serviceAction("restart", connection: connection)
        #expect(store.errorMessage == nil)
        #expect(store.notice?.contains("已提交，但状态读取失败") == true)
        #expect(WorktreeStateProtocol.calls.filter { $0.hasPrefix("POST") }.count == 1)
        #expect(!store.serviceBusy)
    }

    @Test func rejectedPlanKeepsConcreteErrorAndDoesNotRetry() async throws {
        let (store, connection) = try fixture()
        WorktreeStateProtocol.failPost = true
        await store.preparePlan(operation: .merge, sources: ["source"], target: "main", connection: connection)
        #expect(store.errorMessage?.contains("BRANCH_OPERATION_INVALID") == true)
        #expect(WorktreeStateProtocol.calls.count == 1)
        #expect(!store.planning)
    }

    nonisolated static let job = #"{"id":"job:test","repositoryId":"repo:test","status":"awaiting_confirmation","phase":"plan","planFingerprint":"fingerprint:one","createdAt":"now","updatedAt":"now","plan":{"repositoryId":"repo:test","mainWorktreeId":"main","mainPath":"/repo","mainHeadBefore":"abc","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":0,"total":1,"fraction":0}}"#
    private static let repository = #"{"repository":{"id":"repo:test","path":"/repo","name":"Repo","discoveredAt":"now","lastValidatedAt":"now","mainPath":"/repo","availability":"available","worktreeCount":0},"project":{"repositoryId":"repo:test","inventoryVersion":"1","mainWorktreeId":"main","mainPath":"/repo","mainBranch":"main","mainHeadOid":"abc","pendingWorktreeCount":0,"worktrees":[]},"latestJob":null}"#
}

private final class WorktreeStateProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var calls: [String] = []
    nonisolated(unsafe) static var failPost = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.calls.append("\(request.httpMethod ?? "") \(request.url!.path)")
        let isPost = request.httpMethod == "POST"
        let status = isPost ? (Self.failPost ? 400 : 200) : 503
        let json = status == 400 ? #"{"code":"BRANCH_OPERATION_INVALID","error":"invalid operation"}"#
            : status == 503 ? #"{"code":"READ_UNAVAILABLE","error":"unavailable"}"#
            : request.url!.path.hasSuffix("integration-plans") ? "{\"job\":\(PadWorktreeTests.job)}" : "{}"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
