import Foundation
import Testing
@testable import CorptieClientCore

@Suite(.serialized) struct ClientWorktreeAPITests {
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
