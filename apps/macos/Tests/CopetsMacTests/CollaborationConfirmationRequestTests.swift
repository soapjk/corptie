import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct CollaborationConfirmationRequestTests {
    @Test func confirmationActionCannotSilentlyDependOnTheSelectedSession() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/CopetsMac/BackendClient.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let actionStart = try #require(source.range(
            of: "func respondToCollaborationConfirmation(confirmationId: String, approve: Bool"
        ))
        let requestHelperStart = try #require(source.range(
            of: "nonisolated static func requestCollaborationConfirmationResolution("
        ))
        let action = String(source[actionStart.lowerBound..<requestHelperStart.lowerBound])

        #expect(!action.contains("guard session != nil || selectedSession != nil else { return }"))
        #expect(action.contains("pendingCollaborationConfirmationsBySessionID.first"))
        #expect(action.contains("requestCollaborationConfirmationResolution("))
        #expect(action.contains("Confirmation failed: %@"))
    }

    @Test func confirmationRequestDoesNotDependOnSelectedSessionState() async throws {
        let session = makeSession()
        CollaborationConfirmationURLProtocol.handler = { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/collaboration/confirmations/confirmation:one/confirm")
            return (200, #"{"confirmation":{"status":"confirmed"}}"#)
        }

        try await BackendClient.requestCollaborationConfirmationResolution(
            at: URL(string: "http://127.0.0.1:9999")!,
            confirmationId: "confirmation:one",
            approve: true,
            urlSession: session
        )
    }

    @Test func confirmationFailureSurfacesTheBackendReason() async {
        let session = makeSession()
        CollaborationConfirmationURLProtocol.handler = { _ in
            (409, #"{"code":"RECIPIENT_SESSION_UNAVAILABLE","error":"Target Session is archived."}"#)
        }

        do {
            try await BackendClient.requestCollaborationConfirmationResolution(
                at: URL(string: "http://127.0.0.1:9999")!,
                confirmationId: "confirmation:two",
                approve: true,
                urlSession: session
            )
            Issue.record("Expected confirmation resolution to fail")
        } catch {
            #expect(error.localizedDescription.contains("Target Session is archived"))
        }
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CollaborationConfirmationURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class CollaborationConfirmationURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
