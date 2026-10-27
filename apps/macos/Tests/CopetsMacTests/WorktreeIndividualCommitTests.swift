import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct WorktreeIndividualCommitTests {
    fileprivate static let worktree = """
    {"worktreeId":"tree:main","path":"/repo","isMain":true,"availability":"available","headOid":"abc","branchName":"main","isDetached":false,"isLocked":false,"state":"dirty","dirty":true,"changedFiles":["one.md"],"conflictFiles":[],"pendingIntegration":false,"associations":[]}
    """
    fileprivate static let blocker = """
    {"id":"review:one","version":1,"worktreeId":"tree:main","branchName":"main","checkedAt":"now","files":[{"path":"one.md","contentHash":"abc","byteLength":4,"code":"GIT_MARKDOWN_PROMOTION_REQUIRED","supportedActions":["ignore","delete","artifact","track"]}],"artifactOwners":[{"workId":"work:one","title":"One"}]}
    """
    fileprivate static let protection = """
    {"repositoryRoot":"/repo","protectedPaths":[],"localSymlinkPaths":[],"suggestedIgnorePatterns":[],"warningEnabled":true,"requiresDecision":false}
    """

    @Test func preparationDecodesLegacyAndVersionedContracts() throws {
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(WorktreeCommitPreparation.self, from: Data(Self.protection.utf8))
        #expect(legacy.value.reviewId == nil)
        let current = try decoder.decode(WorktreeCommitPreparation.self, from: Data("""
        {"schemaVersion":2,"reviewId":"review:one","protection":\(Self.protection),"commitPolicyBlocker":\(Self.blocker)}
        """.utf8))
        #expect(current.value.reviewId == "review:one")
        #expect(current.value.commitPolicyBlocker?.artifactOwners?.first?.workId == "work:one")
    }

    @MainActor
    @Test func directCommitRetainsBlockerAndSubmitsExplicitFileDecisions() async throws {
        let recorder = IndividualCommitRecorder()
        let client = makeClient(recorder)
        let tree = try JSONDecoder().decode(ManagedWorktree.self, from: Data(Self.worktree.utf8))
        let prepared = await client.prepareIndividualOperation(for: tree)
        #expect(prepared?.reviewId == "review:one")
        #expect(recorder.commitBodies.isEmpty)
        let outcome = await client.commitMainWorktreeChanges(worktree: tree, commitMessage: "My manual message", privateFilesDecision: nil, neverRemindPrivateFiles: false, reviewId: prepared?.reviewId, decisions: ["one.md": .track], artifactWorkId: "work:one")
        guard case let .blocked(blocker, reviewID, _, needsReview) = outcome else {
            Issue.record("Expected an inline Markdown blocker"); return
        }
        #expect(blocker.files.first?.path == "one.md")
        #expect(reviewID == "review:one")
        #expect(needsReview == false)
        #expect(client.errorMessage == nil)
        #expect(recorder.commitBodies.first?["commitMessage"] as? String == "My manual message")
        #expect(recorder.commitBodies.first?["reviewId"] as? String == "review:one")
        let decisions = recorder.commitBodies.first?["decisions"] as? [[String: String]]
        #expect(decisions == [["path": "one.md", "action": "track"]])
    }

    @MainActor
    @Test func preparationFailureIsExplicitAndStaleCommitRequiresReview() async throws {
        let recorder = IndividualCommitRecorder()
        recorder.preparationFails = true
        recorder.commitCode = "COMMIT_REVIEW_CHANGED"
        let client = makeClient(recorder)
        let tree = try JSONDecoder().decode(ManagedWorktree.self, from: Data(Self.worktree.utf8))
        #expect(await client.prepareIndividualOperation(for: tree) == nil)
        #expect(client.individualPreparationError != nil)
        #expect(client.errorMessage == nil)
        let outcome = await client.commitMainWorktreeChanges(worktree: tree, commitMessage: "Keep this draft", privateFilesDecision: nil, neverRemindPrivateFiles: false)
        guard case let .blocked(_, _, _, needsReview) = outcome else { Issue.record("Expected blocker"); return }
        #expect(needsReview)
    }

    @MainActor
    private func makeClient(_ recorder: IndividualCommitRecorder) -> WorktreeManagementClient {
        IndividualCommitURLProtocol.recorder = recorder
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [IndividualCommitURLProtocol.self]
        let client = WorktreeManagementClient(baseURL: URL(string: "http://127.0.0.1:9999")!, session: URLSession(configuration: config))
        client.selection.repositoryId = "repo:one"
        return client
    }
}

private final class IndividualCommitRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [[String: Any]] = []
    var preparationFails = false
    var commitCode = "GIT_ARTIFACT_POLICY_REJECTED"
    var commitBodies: [[String: Any]] { lock.withLock { bodies } }
    func response(_ request: URLRequest) -> (Int, String) {
        lock.withLock {
            if request.url?.path.hasSuffix("commit-prepare") == true {
                if preparationFails { return (500, "{\"error\":\"inspection failed\"}") }
                return (200, """
                {"result":{"schemaVersion":2,"reviewId":"review:one","protection":\(WorktreeIndividualCommitTests.protection),"commitPolicyBlocker":\(WorktreeIndividualCommitTests.blocker)}}
                """)
            }
            var data = request.httpBody
            if data == nil, let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    bytes.append(contentsOf: buffer.prefix(count))
                }
                data = bytes
            }
            if let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { bodies.append(body) }
            return (409, """
            {"error":"Markdown decisions required","code":"\(commitCode)","commitReviewId":"review:one","commitPolicyBlocker":\(WorktreeIndividualCommitTests.blocker)}
            """)
        }
    }
}

private final class IndividualCommitURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var recorder: IndividualCommitRecorder?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let recorder = Self.recorder, let url = request.url else { return }
        let (status, body) = recorder.response(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
