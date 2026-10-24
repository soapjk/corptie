import Foundation
import Testing
@testable import CorptieClientCore

@Suite struct ClientTaskStartupTests {
    @Test func bothRoutesCarryExactTaskAndFailedOperationWithoutAutomaticRetry() async throws {
        for paired in [false, true] {
            let probe = StartupProbe(paired: paired)
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
                data: { try await probe.handle($0) }, bytes: { _ in throw URLError(.cancelled) })
            let api = ClientTaskStartupAPI(transport: transport, route: paired ? .paired : .desktop, sourceSessionId: "session:source")
            let failed = try await api.status(taskId: "task:child")
            #expect(failed.canRetry)
            #expect(failed.reasonKey.contains("未提交改动"))
            #expect(await probe.methods == ["GET"])
            _ = try await api.retry(taskId: failed.taskId, startupOperationId: "startup:failed")
            #expect(await probe.methods == ["GET", "POST"])
        }
    }

    @Test func oldSuccessfulCreationAndNewPartialFailureBothDecode() throws {
        let decoder = JSONDecoder()
        let old = try decoder.decode(ClientTaskCreationResult.self,
            from: Data(#"{"taskId":"t","sessionId":"s","workId":"w"}"#.utf8))
        #expect(old.startupOperationId == nil)
        let failed = try decoder.decode(ClientCommandReceipt.self, from: Data(#"{"schemaVersion":1,"requestId":"r","sessionId":"source","kind":"create_task","status":"failed","errorCode":"PARENT_WORKTREE_DIRTY","updatedAt":"now","taskResult":{"taskId":"t","sessionId":"","workId":"w","startupOperationId":"failed"}}"#.utf8))
        #expect(failed.taskResult?.taskId == "t")
        #expect(failed.taskResult?.startupOperationId == "failed")
        #expect(failed.status != "completed")
    }
}

private actor StartupProbe {
    let paired: Bool
    var methods: [String] = []
    init(paired: Bool) { self.paired = paired }
    func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        methods.append(request.httpMethod ?? "GET")
        #expect(request.url?.path == (paired ? "/client/v1/sessions/session:source/task-startup" : "/tasks/task:child/startup-recovery"))
        if !paired { #expect(request.value(forHTTPHeaderField: "X-Corptie-Logical-Session-Id") == "session:source") }
        if request.httpMethod == "POST" {
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
            #expect(body["startupOperationId"] == "startup:failed")
            #expect(body["taskId"] == (paired ? "task:child" : nil))
        } else if paired {
            #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == "task:child")
        }
        let data = Data(#"{"taskId":"task:child","workId":"work","parentTaskId":"parent","status":"failed","startupOperationId":"startup:failed","sessionId":null,"canRetry":true,"error":{"code":"PARENT_WORKTREE_DIRTY","retryable":true}}"#.utf8)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
