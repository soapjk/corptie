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
            contentsOf: sourceRoot.appendingPathComponent("Conversation/SessionConversationContent.swift"),
            encoding: .utf8
        )
        let historyController = try String(
            contentsOf: sourceRoot.appendingPathComponent("Backend/SessionTimelineHistoryController.swift"),
            encoding: .utf8
        )
        let readAPI = try String(
            contentsOf: sourceRoot.appendingPathComponent("Backend/SessionTimelineReadAPI.swift"),
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
        #expect(historyController.contains("earlierHistoryLoadSessionIDs.insert(session.id).inserted"))
        #expect(historyController.contains("setEarlierHistoryLoadState(.loading"))
        #expect(historyController.contains("EarlierHistoryLoadState.failed"))
        #expect(readAPI.contains("request.timeoutInterval = timeoutInterval"))
    }

    @Test func detachedTimelineCanPageAnUnselectedSession() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let view = try String(contentsOf: sourceRoot.appendingPathComponent(
            "Conversation/SessionConversationContent.swift"), encoding: .utf8)
        let history = try String(contentsOf: sourceRoot.appendingPathComponent(
            "Backend/SessionTimelineHistoryController.swift"), encoding: .utf8)
        let client = try String(contentsOf: sourceRoot.appendingPathComponent(
            "BackendClient.swift"), encoding: .utf8)

        let pageMethod = try #require(view.components(separatedBy: "private func loadEarlierMessages(preservingLatestFollow: Bool) {").last)
            .components(separatedBy: "private func restoreMissingHistoryAnchorIfNeeded()").first ?? ""
        #expect(pageMethod.contains("let session = selectedSession"))
        #expect(!pageMethod.contains("guard backendClient.selectedSession?.id == sessionId"))
        #expect(history.contains("let current = detailForSession(session.id)"))
        #expect(history.contains("SessionTimelineBindingReconciler.sameRoute(liveSession, session)"))
        #expect(history.contains("publishSessionDetail(merged, session.id)"))
        #expect(client.contains("self.storeCachedDetail(detail, for: id)"))
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

@Suite(.serialized)
@MainActor
struct DetachedHistoryControllerTests {
    @Test func removedWindowSessionDiscardsAnInFlightHistoryPage() async {
        let selection = SessionSelectionController()
        let windowSession = session("window")
        selection.select("main")
        var windowDetail = detail("window", items: [item("newest")], hasMore: true)
        var sessionExists = true
        let controller = SessionTimelineHistoryController(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            selection: selection,
            sessionForID: { id in
                id == windowSession.id && sessionExists ? windowSession : nil
            },
            detailForSession: { $0 == windowSession.id ? windowDetail : nil },
            publishSessionDetail: { updated, _ in windowDetail = updated },
            requestEarlierHistoryPage: { _ in
                sessionExists = false
                return SessionHistoryResponse(
                    sessionId: windowSession.id, logicalSessionId: nil,
                    items: [item("older")], hasMoreHistory: false,
                    historyItemsCount: nil, cursorStatus: nil
                )
            }
        )

        #expect(await controller.loadEarlierMessages(for: windowSession) == .idle)
        #expect(windowDetail.items.map(\.id) == ["newest"])
    }

    @Test func unselectedWindowRestoresAnUncachedHistoryAnchor() async {
        let selection = SessionSelectionController()
        let mainSession = session("main")
        let windowSession = session("window")
        selection.select(mainSession.id)
        var windowDetail = detail("window", items: [item("newest")], hasMore: true)
        var requestedAnchor: String?
        let controller = SessionTimelineHistoryController(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            selection: selection,
            sessionForID: { $0 == windowSession.id ? windowSession : nil },
            detailForSession: { $0 == windowSession.id ? windowDetail : nil },
            publishSessionDetail: { updated, id in
                #expect(id == windowSession.id)
                windowDetail = updated
            },
            requestTimelineWindow: { url in
                requestedAnchor = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "anchor" })?.value
                return SessionTimelineWindowResponse(
                    protocolVersion: nil, revision: nil,
                    sessionId: windowSession.id, logicalSessionId: nil,
                    items: [item("anchor")],
                    anchor: SessionTimelineAnchorResolution(
                        kind: "item", requestedId: "anchor", resolvedId: "anchor", status: "found"
                    ),
                    hasEarlier: false, hasLater: true
                )
            },
            requestEarlierHistoryPage: { _ in
                Issue.record("Anchor restoration must use the timeline window endpoint")
                throw URLError(.badURL)
            }
        )

        let result = await controller.loadTimelineWindow(
            for: windowSession, anchorRowID: "message:anchor",
            expectedSelectionGeneration: nil
        )
        #expect(result == .found)
        #expect(requestedAnchor == "anchor")
        #expect(windowDetail.items.map(\.id) == ["anchor", "newest"])
    }

    @Test func unselectedWindowLoadsConsecutiveHistoryPages() async {
        let selection = SessionSelectionController()
        let mainSession = session("main")
        let windowSession = session("window")
        selection.select(mainSession.id)
        var windowDetail = detail("window", items: [item("newest")], hasMore: true)
        var requestedCursors: [String] = []
        let controller = SessionTimelineHistoryController(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            selection: selection,
            sessionForID: { $0 == windowSession.id ? windowSession : nil },
            detailForSession: { $0 == windowSession.id ? windowDetail : nil },
            publishSessionDetail: { updated, id in
                #expect(id == windowSession.id)
                windowDetail = updated
            },
            requestEarlierHistoryPage: { url in
                let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "before" })?.value ?? ""
                requestedCursors.append(cursor)
                return SessionHistoryResponse(
                    sessionId: windowSession.id, logicalSessionId: nil,
                    items: [item(cursor == "newest" ? "older" : "oldest")],
                    hasMoreHistory: cursor == "newest", historyItemsCount: nil,
                    cursorStatus: nil
                )
            }
        )

        #expect(await controller.loadEarlierMessages(for: windowSession) == .idle)
        #expect(windowDetail.items.map(\.id) == ["older", "newest"])
        #expect(await controller.loadEarlierMessages(for: windowSession) == .exhausted)
        #expect(windowDetail.items.map(\.id) == ["oldest", "older", "newest"])
        #expect(requestedCursors == ["newest", "older"])
        #expect(selection.selectedSessionID == mainSession.id)
    }

    private func session(_ id: String) -> TaskSession {
        TaskSession(
            id: id, title: id, agent: "Agent", agentId: nil,
            status: .complete, progress: 1, summary: "", suggestedOptions: nil,
            suggestedPrompt: nil, activityStatus: nil,
            updatedAt: "2026-08-19T00:00:00Z", accent: .cyan,
            archived: false, pinned: false, sortOrder: nil,
            capabilities: nil, external: nil
        )
    }

    private func detail(_ id: String, items: [CodexThreadItem], hasMore: Bool) -> CodexThreadDetail {
        CodexThreadDetail(
            id: id, title: id, status: .complete, source: nil,
            connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil,
            activityStatus: nil, cwd: nil,
            createdAt: "2026-08-19T00:00:00Z", updatedAt: "2026-08-19T00:00:00Z",
            canSend: true, sendUnavailableReason: nil, capabilities: nil,
            turnCount: items.count, items: items, hasMoreHistory: hasMore
        )
    }

    private func item(_ id: String) -> CodexThreadItem {
        CodexThreadItem(
            id: id, turnId: "turn:\(id)", turnStatus: "complete",
            type: "agentMessage", title: "Agent", text: id,
            options: nil, status: nil, createdAt: "2026-08-19T00:00:00Z"
        )
    }
}
