import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct EarlierHistoryLoadingTests {
    @MainActor
    @Test func slowHistoryPageRemainsAwaitableAndPublishesTerminalPageData() async throws {
        let session = makeSession()
        EarlierHistoryURLProtocol.handler = { request in
            #expect(request.timeoutInterval == 15)
            Thread.sleep(forTimeInterval: 0.12)
            return (200, Self.exhaustedPage)
        }
        let clock = ContinuousClock()
        let startedAt = clock.now

        let page = try await BackendClient.requestEarlierHistoryPage(
            at: URL(string: "http://127.0.0.1:9999/sessions/session%3Aone/history")!,
            urlSession: session
        )

        #expect(startedAt.duration(to: clock.now) >= .milliseconds(100))
        #expect(page.items.count == 1)
        #expect(page.hasMoreHistory == false)
        #expect(page.historyItemsCount == 0)
    }

    @MainActor
    @Test func historyHTTPFailureIsSurfacedInsteadOfBecomingFalseExhaustion() async {
        let session = makeSession()
        EarlierHistoryURLProtocol.handler = { _ in
            (500, #"{"error":"history storage temporarily unavailable"}"#)
        }

        do {
            _ = try await BackendClient.requestEarlierHistoryPage(
                at: URL(string: "http://127.0.0.1:9999/sessions/session%3Aone/history")!,
                urlSession: session
            )
            Issue.record("Expected the history request to fail")
        } catch {
            #expect(error.localizedDescription.contains("history storage temporarily unavailable"))
        }
    }

    @MainActor
    @Test func invalidCursorIsRetryableFailureInsteadOfNoMoreHistory() async {
        let session = makeSession()
        EarlierHistoryURLProtocol.handler = { _ in
            (200, #"{"sessionId":"session:one","items":[],"hasMoreHistory":false,"historyItemsCount":0,"cursorStatus":"invalid"}"#)
        }

        do {
            _ = try await BackendClient.requestEarlierHistoryPage(
                at: URL(string: "http://127.0.0.1:9999/sessions/session%3Aone/history")!,
                urlSession: session
            )
            Issue.record("Expected an invalid cursor to remain retryable")
        } catch {
            #expect(
                error.localizedDescription.contains("cursor")
                    || error.localizedDescription.contains("游标")
            )
        }
    }

    @Test func timelineLoadsEarlierHistoryAutomaticallyWithoutOverlayControls() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let view = try String(
            contentsOf: sourceRoot.appendingPathComponent("FloatingRootView.swift"),
            encoding: .utf8
        )
        let backend = try String(
            contentsOf: sourceRoot.appendingPathComponent("BackendClient.swift"),
            encoding: .utf8
        )

        #expect(view.contains("let previousVisibleMessageLimit = visibleMessageLimit"))
        #expect(view.contains("visibleMessageLimit += 100"))
        #expect(view.contains("visibleMessageLimit = previousVisibleMessageLimit"))
        #expect(view.contains("onNearTop: loadEarlierMessagesIfNeeded"))
        #expect(view.contains("onUnderfilledHistory: loadEarlierMessagesForUnderfilledViewport"))
        #expect(view.contains("loadEarlierMessages(preservingLatestFollow: true)"))
        #expect(!view.contains("EarlierHistoryStatusView"))
        #expect(!view.contains("Load earlier messages"))
        #expect(backend.contains("earlierHistoryLoadSessionIDs.insert(session.id).inserted"))
        #expect(backend.contains("setEarlierHistoryLoadState(.loading"))
        #expect(backend.contains("EarlierHistoryLoadState.failed"))
        #expect(backend.contains("request.timeoutInterval = timeoutInterval"))
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EarlierHistoryURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static let exhaustedPage = #"{"sessionId":"session:one","logicalSessionId":"logical:one","items":[{"id":"older-1","turnId":"turn:one","turnStatus":"complete","type":"agentMessage","title":"Agent","text":"Earlier","options":null,"status":null,"createdAt":"2026-08-28T00:00:00Z"}],"hasMoreHistory":false,"historyItemsCount":0}"#
}

private final class EarlierHistoryURLProtocol: URLProtocol, @unchecked Sendable {
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
