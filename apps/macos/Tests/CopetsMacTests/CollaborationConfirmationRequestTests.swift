import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct CollaborationConfirmationRequestTests {
    @MainActor @Test func immediateFeedbackAndDelayedSnapshotDoNotResurrectButtons() async {
        var item = CodexThreadItem(id: "confirmation", turnId: "product", turnStatus: "waiting_approval",
                                  type: "collaborationConfirmation", title: "", text: "", options: nil, status: "pending", createdAt: nil)
        item.collaborationConfirmationId = "confirmation:one"
        item.collaborationConfirmationStatus = "pending"
        let pending = CodexThreadDetail(id: "session", title: "", status: .blocked, source: nil,
                                        connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil,
                                        activityStatus: nil, cwd: nil, createdAt: "now", updatedAt: "now",
                                        canSend: true, sendUnavailableReason: nil, capabilities: nil, turnCount: 1, items: [item])
        var resident = pending
        let (events, continuation) = AsyncStream<String>.makeStream()
        var requests = 0
        CollaborationConfirmationURLProtocol.handler = { _ in
            requests += 1
            return (200, #"{"request":{"status":"confirmed"}}"#)
        }
        let controller = CollaborationConfirmationController(
            baseURL: URL(string: "http://127.0.0.1:9999")!, commands: SessionCommandController(),
            activeSessions: { [] }, cachedDetail: { _ in resident },
            storeDetail: { detail, _, _ in
                resident = detail
                continuation.yield(detail.items[0].collaborationConfirmationStatus ?? "")
            }, loadMessages: { _ in }, reportError: { _ in continuation.finish() }, urlSession: makeSession())
        controller.updatePendingConfirmation(from: pending, for: "session")
        controller.respondToCollaborationConfirmation(confirmationId: "confirmation:one", approve: true)
        controller.respondToCollaborationConfirmation(confirmationId: "confirmation:one", approve: true)
        #expect(resident.items[0].collaborationConfirmationStatus == "submitting")
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == "submitting")
        #expect(await iterator.next() == "confirmed")
        #expect(requests == 1)
        let delayed = controller.reconcile(pending, for: "session")
        #expect(delayed.items[0].collaborationConfirmationStatus == "confirmed")
        #expect(BackendClient.pendingCollaborationConfirmation(in: delayed) == nil)
        let accepted = controller.reconcile(resident, for: "session")
        #expect(accepted.items[0].collaborationConfirmationStatus == "confirmed")
        continuation.finish()
    }
    @Test func confirmationActionCannotSilentlyDependOnTheSelectedSession() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/CopetsMac/Backend/CollaborationConfirmationController.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let actionStart = try #require(source.range(
            of: "func respondToCollaborationConfirmation(confirmationId: String, approve: Bool"
        ))
        let requestHelperStart = try #require(source.range(
            of: "nonisolated static func requestCollaborationConfirmationResolution("
        ))
        let action = String(source[actionStart.lowerBound..<requestHelperStart.lowerBound])

        #expect(!action.contains("guard session != nil || selectedSession != nil else { return }"))
        #expect(action.contains("pendingBySessionID.first"))
        #expect(action.contains("requestCollaborationConfirmationResolution("))
        #expect(action.contains("publishStatus(resolutionStatus"))
        #expect(action.contains("publishStatus(approve ? \"submitting\" : \"rejecting\""))
        #expect(!action.contains("Collaboration request sent"))
        #expect(action.contains("await loadMessages(sourceSession)"))
        #expect(action.contains("Confirmation failed: %@"))
    }

    @Test func confirmationRequestDoesNotDependOnSelectedSessionState() async throws {
        let session = makeSession()
        CollaborationConfirmationURLProtocol.handler = { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/collaboration/confirmations/confirmation:one/confirm")
            return (200, #"{"confirmation":{"status":"confirmed"}}"#)
        }

        let status = try await BackendClient.requestCollaborationConfirmationResolution(
            at: URL(string: "http://127.0.0.1:9999")!,
            confirmationId: "confirmation:one",
            approve: true,
            urlSession: session
        )
        #expect(status == "confirmed")
    }

    @Test func channelAuthorizationAndRejectionUseActualResponse() async throws {
        for approve in [true, false] {
            let expected = approve ? "confirmed" : "rejected"
            CollaborationConfirmationURLProtocol.handler = { _ in
                (200, "{\"request\":{\"status\":\"\(expected)\"}}")
            }
            let status = try await BackendClient.requestCollaborationConfirmationResolution(
                at: URL(string: "http://127.0.0.1:9999")!,
                confirmationId: "channel:one", approve: approve, urlSession: makeSession()
            )
            #expect(status == expected)
        }
    }

    @Test func httpSuccessWithoutMatchingConfirmationIsNotSuccess() async {
        for body in ["{}", "invalid", #"{"request":{"status":"pending"}}"#,
                     #"{"confirmation":{"status":"rejected"}}"#] {
            CollaborationConfirmationURLProtocol.handler = { _ in (200, body) }
            do {
                try await BackendClient.requestCollaborationConfirmationResolution(
                    at: URL(string: "http://127.0.0.1:9999")!,
                    confirmationId: "channel:one", approve: true, urlSession: makeSession()
                )
                Issue.record("Invalid confirmation response was accepted: \(body)")
            } catch {}
        }
    }

    @Test func durableAcceptanceShowsSentWithoutClaimingModelCompletion() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources/CopetsMac")
        let swiftUI = try String(contentsOf: root.appending(path: "Conversation/Presentation/ConversationDisplayProjection.swift"), encoding: .utf8)
            + String(contentsOf: root.appending(path: "Conversation/Timeline/ThreadItemView.swift"), encoding: .utf8)
            + String(contentsOf: root.appending(path: "Conversation/Presentation/ConversationNativeRowBuilder.swift"), encoding: .utf8)
        let appKit = try String(contentsOf: root.appending(path: "Conversation/Timeline/AppKitChatNativeTextCell.swift"), encoding: .utf8)
        #expect(swiftUI.contains("case \"confirmed\": isConfirmation ? L10n(\"已发送\")"))
        #expect(!swiftUI.contains("isSessionChannelAuthorization ? \"已授权\" : \"已发送\""))
        #expect(!swiftUI.contains("collaboration.confirmation.sent"))
        #expect(appKit.contains("NSTextField(labelWithString: L10n(\"已发送\"))"))
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
