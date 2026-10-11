import Foundation
import Testing
@testable import CorptieClientCore

struct ClientSessionWorktreeTests {
    static func detail(ahead: Int = 3, behind: Int = 0, dirty: Bool = false, blocker: String? = nil) throws -> ClientSessionWorktreeDetail {
        try JSONDecoder().decode(ClientSessionWorktreeDetail.self, from: Data("""
        {"attached":true,"repositoryId":"repo","mainWorktreeId":"main","mainBranch":"develop",
         "blockedReason":\(blocker.map { "\"\($0)\"" } ?? "null"),"worktree":{"worktreeId":"tree","path":"/tree","branchName":"feature",
         "isMain":false,"availability":"available","dirty":\(dirty),"changedFiles":[],"aheadOfMain":\(ahead),
         "behindMain":\(behind),"operationState":null,"conflictFiles":[]}}
        """.utf8))
    }
    @Test func branchRelationsExposeOnlySafeApplicableOperations() throws {
        #expect(try Self.detail().canPerform(.merge))
        #expect(try !Self.detail().canPerform(.synchronize))
        #expect(try !Self.detail(ahead: 0).canPerform(.merge))
        #expect(try Self.detail(ahead: 0, behind: 2).canPerform(.synchronize))
        #expect(try !Self.detail(behind: 2).canPerform(.merge))
        #expect(try Self.detail(behind: 2).canPerform(.synchronize))
        #expect(try !Self.detail(dirty: true).canPerform(.merge))
        for code in ["SESSION_BUSY", "UNCOMMITTED_CHANGES", "GIT_OPERATION_IN_PROGRESS", "DETACHED_HEAD", "WORKTREE_UNAVAILABLE", "WORKTREE_LOCKED", "MAIN_WORKTREE"] {
            #expect(try !Self.detail(blocker: code).canPerform(.merge))
            #expect(try !Self.detail(behind: 2, blocker: code).canPerform(.synchronize))
        }
    }
    @Test func unboundAndUnknownRelationsAreNotInterpretedAsAligned() throws {
        let empty = try JSONDecoder().decode(ClientSessionWorktreeDetail.self, from: Data(#"{"attached":false,"worktree":null}"#.utf8))
        #expect(!empty.canPerform(.merge)); #expect(!empty.canPerform(.synchronize))
    }
    @Test func bothRoutesKeepRebaseSourceAsCurrentTreeAndTargetAsMain() async throws {
        for route in [ClientSessionWorktreeAPI.Route.desktop, .pairedDevice] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
                let path = request.url!.path
                let result: Data
                if path.hasSuffix("integration-plans") {
                    let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                    #expect(body["operationType"] as? String == "one_way_sync")
                    #expect(body["sourceWorktreeIds"] as? [String] == ["tree"])
                    #expect(body["targetWorktreeId"] as? String == "main")
                    result = Data(#"{"job":{"id":"job","repositoryId":"repo","status":"awaiting_confirmation","phase":"plan","planFingerprint":"proof","createdAt":"now","updatedAt":"now","plan":{"repositoryId":"repo","operationType":"sync","mainWorktreeId":"main","mainPath":"/main","inventoryVersion":"1","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":0,"total":1,"fraction":0}}}"#.utf8)
                } else {
                    #expect(path == "/sessions/session/worktree-detail" || path == "/client/v1/sessions/session/inspector/read")
                    if path.hasSuffix("read") {
                        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                        #expect(body["resource"] as? String == "session-worktree")
                    }
                    result = Data(#"{"attached":true,"repositoryId":"repo","mainWorktreeId":"main","mainBranch":"develop","worktree":{"worktreeId":"tree","path":"/tree","branchName":"feature","isMain":false,"availability":"available","dirty":false,"changedFiles":[],"aheadOfMain":3,"behindMain":2,"conflictFiles":[]}}"#.utf8)
                }
                return (result, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            let api = ClientSessionWorktreeAPI(transport: transport, route: route)
            #expect(try await api.prepare(sessionID: "session", action: .synchronize).plan.operationType == "sync")
        }
    }
}
