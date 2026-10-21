import Foundation
import Testing
@testable import CorptieClientCore

struct WorkLocalStateTests {
    @Test func worktreeDiagnosisAndRepairUseOneBoundRouteWithoutPathOverrides() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!)
        let transport = BackendTransport(endpoint: endpoint, data: { request in
            #expect(request.url?.path == "/client/v1/worktrees/repositories/repo:r/worktrees/tree:t/local-state")
            if request.httpMethod == "POST" { #expect(request.httpBody == Data("{}".utf8)) }
            else { #expect(request.httpMethod == "GET") }
            return (Data(#"{"schemaVersion":1,"state":"ready","scope":"worktreeLocal"}"#.utf8),
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        let api = ClientWorktreeAPI(transport: transport)
        #expect(try await api.localState(repositoryId: "repo:r", worktreeId: "tree:t").isReady)
        #expect(try await api.localState(repositoryId: "repo:r", worktreeId: "tree:t", repair: true).isReady)
    }
    @Test func oldManagementDoesNotAdvertiseRepair() throws {
        let body = Data(#"{"schemaVersion":1,"work":{"id":"work:w","name":"W","description":"","status":"active"},"actions":{"edit":{"available":true},"delete":{"available":true}}}"#.utf8)
        let value = try JSONDecoder().decode(ClientWorkManagement.self, from: body)
        #expect(value.actions.repairLocalState == nil)
        #expect(ClientWorkCommand.repairLocalState.kind == "work_repair-local-state")
    }

    @Test func diagnosisUsesTheBoundWorkRouteAndVersionedContract() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!)
        let transport = BackendTransport(endpoint: endpoint, data: { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/client/v1/works/work:w/local-state")
            return (Data(#"{"schemaVersion":1,"state":"missing","scope":"projectShared","gitStatus":null,"code":null}"#.utf8),
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        let value = try await ClientSessionAPI(transport: transport).workLocalState(workId: "work:w")
        #expect(!value.isReady)
        #expect(value.titleKey == "尚未初始化本地目录")
    }

    @Test func desktopDiagnosisMayOmitTheGatewayEnvelopeVersion() throws {
        let value = try JSONDecoder().decode(ClientWorkLocalState.self, from:
            Data(#"{"state":"ready","scope":"projectShared","gitStatus":"ignored-untracked"}"#.utf8))
        #expect(value.isReady)
        #expect(value.schemaVersion == nil)
    }
}
