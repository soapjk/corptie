import Foundation
import Testing
@testable import CorptieClientCore

struct ClientSessionWorktreeTests {
    @Test func absentPreferenceIsOffAndBothHostsUseExactBoundMutationRoutes() async throws {
        #expect(try Self.detail().autoFollow?.enabled != true)
        for route in [ClientSessionWorktreeAPI.Route.desktop, .pairedDevice] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
                #expect(request.httpMethod == "POST")
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                let data: Data
                if request.url!.path.hasSuffix("worktree-auto-follow") {
                    #expect(request.url!.path == "/sessions/session/worktree-auto-follow")
                    #expect(body["enabled"] as? Bool == true)
                    #expect(body["expectedWorktreeId"] as? String == "tree")
                    data = Data(#"{"enabled":true,"status":"waiting"}"#.utf8)
                } else {
                    #expect(request.url!.path == "/client/v1/sessions/session/inspector/commands")
                    #expect(body["action"] as? String == "worktree.autoFollow")
                    let fields = body["fields"] as! [String: Any]
                    #expect(fields["enabled"] as? Bool == true)
                    #expect(fields["expectedWorktreeId"] as? String == "tree")
                    data = Data(#"{"schemaVersion":1,"requestId":"request","sessionId":"session","kind":"inspector:worktree.autoFollow","status":"completed","updatedAt":"now"}"#.utf8)
                }
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            try await ClientSessionWorktreeAPI(transport: transport, route: route)
                .setAutoFollow(sessionID: "session", worktreeID: "tree", enabled: true)
        }
    }

    @Test func uncertainPairedPreferenceReceiptDoesNotClaimSuccess() async throws {
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
            (Data(#"{"schemaVersion":1,"requestId":"request","sessionId":"session","kind":"inspector:worktree.autoFollow","status":"unknown","errorCode":"INSPECTOR_OUTCOME_UNCERTAIN","updatedAt":"now"}"#.utf8),
             HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        do {
            try await ClientSessionWorktreeAPI(transport: transport, route: .pairedDevice)
                .setAutoFollow(sessionID: "session", worktreeID: "tree", enabled: true)
            Issue.record("Unknown outcome must not be reported as success")
        } catch let error as ClientServiceFailure { #expect(error.code == "INSPECTOR_OUTCOME_UNCERTAIN") }
    }

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
