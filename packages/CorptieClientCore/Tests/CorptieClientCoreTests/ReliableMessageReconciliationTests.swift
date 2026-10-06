import Foundation
import Testing
@testable import CorptieClientCore

struct ReliableMessageReconciliationTests {
    @Test(arguments: [200, 404, 502])
    func attachmentRetryQueriesOwnershipBeforeUploading(receiptStatus: Int) async throws {
        let probe = ReconciliationProbe(status: receiptStatus)
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: endpoint,
            data: { request in try await probe.handle(request) }, bytes: { _ in throw URLError(.cancelled) }))
        do {
            let receipt = try await api.reconcileOrDeliver(sessionId: "session", requestId: "request_123",
                createdAt: "2026-10-05T00:00:00Z", text: "tiny", images: [.init(fileName: "image.png", data: Data([1]))], previousAttempts: 1)
            #expect(receipt.status == "accepted")
            #expect(receiptStatus != 502)
        } catch {
            #expect(receiptStatus == 502)
        }
        #expect(await probe.methods == (receiptStatus == 404 ? ["GET", "POST"] : ["GET"]))
    }

    @Test func firstAttemptDoesNotAddAReceiptRoundTrip() async throws {
        let probe = ReconciliationProbe(status: 200)
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { request in try await probe.handle(request) }, bytes: { _ in throw URLError(.cancelled) }))
        _ = try await api.reconcileOrDeliver(sessionId: "session", requestId: "request_123",
            createdAt: "2026-10-05T00:00:00Z", text: "tiny", previousAttempts: 0)
        #expect(await probe.methods == ["POST"])
    }

    @Test func textRetryDoesNotAddAReceiptRoundTrip() async throws {
        let probe = ReconciliationProbe(status: 502)
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { request in try await probe.handle(request) }, bytes: { _ in throw URLError(.cancelled) }))
        _ = try await api.reconcileOrDeliver(sessionId: "session", requestId: "request_123",
            createdAt: "2026-10-05T00:00:00Z", text: "tiny", previousAttempts: 3)
        #expect(await probe.methods == ["POST"])
    }
}

private actor ReconciliationProbe {
    let status: Int
    var methods: [String] = []
    init(status: Int) { self.status = status }
    func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        methods.append(request.httpMethod ?? "GET")
        if request.httpMethod == "GET", status != 200 {
            throw ClientServiceFailure(statusCode: status, code: status == 404 ? "COMMAND_NOT_FOUND" : "UPSTREAM_UNAVAILABLE")
        }
        let body = Data(#"{"schemaVersion":1,"sessionId":"session","requestId":"request_123","kind":"send","status":"accepted","updatedAt":"now","messageId":"client:accepted"}"#.utf8)
        return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
