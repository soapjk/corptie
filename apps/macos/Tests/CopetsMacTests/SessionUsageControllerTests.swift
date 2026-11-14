import XCTest
import SwiftUI
import CorptieConversation
@testable import CorptieMac

@MainActor
final class SessionUsageControllerTests: XCTestCase {
    func testSelectionPublishesCachedUsageSynchronouslyWithoutFetching() {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let usage = sampleUsage()
        client.values["one"] = usage
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        controller.publishCachedUsage(for: "one")
        XCTAssertEqual(state.selectedSessionUsage, usage)
        XCTAssertEqual(client.fetchCount, 0)
    }

    func testLateResponseDoesNotPublishOrCacheAfterSelectionChanges() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        var selected = "one"
        let usage = sampleUsage()
        client.onFetch = { _ in selected = "two"; return usage }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { selected })
        await controller.loadUsage(for: "one")
        XCTAssertNil(state.selectedSessionUsage)
        XCTAssertTrue(client.values.isEmpty)
    }

    func testSuccessUpdatesTheExistingPanelAndCache() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let usage = sampleUsage()
        client.onFetch = { _ in usage }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        await controller.refreshSelectedUsage()
        XCTAssertEqual(state.selectedSessionUsage, usage)
        XCTAssertEqual(client.values["one"], usage)
    }

    func testOpeningQuotaPopoverCanRequestAnImmediateUsageRefresh() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let usage = sampleUsage()
        client.onFetch = { _ in usage }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })

        let succeeded = await controller.refreshSelectedUsageWithOutcome()
        XCTAssertTrue(succeeded)
        XCTAssertEqual(client.fetchCount, 1)
        XCTAssertEqual(state.selectedSessionUsage, usage)
    }

    func testFailedImmediateRefreshKeepsPreviousUsageButReportsFailure() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let usage = sampleUsage()
        state.selectedSessionUsage = usage
        client.onFetch = { _ in throw BackendError.message("unavailable") }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })

        let succeeded = await controller.refreshSelectedUsageWithOutcome()
        XCTAssertFalse(succeeded)
        XCTAssertEqual(state.selectedSessionUsage, usage)
    }

    func testSupplementaryFailurePreservesPreviouslyPublishedUsage() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let usage = sampleUsage()
        state.selectedSessionUsage = usage
        client.onFetch = { _ in throw BackendError.message("unavailable") }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        await controller.refreshSelectedUsage()
        XCTAssertEqual(state.selectedSessionUsage, usage)
        XCTAssertTrue(client.values.isEmpty)
    }

    func testExplicitFreshRefreshDoesNotReturnCachedUsageOnFailure() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        state.selectedSessionUsage = sampleUsage()
        client.onFreshFetch = { _ in throw BackendError.message("unavailable") }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })

        let result = await controller.refreshFreshAccount(for: "one")
        XCTAssertNil(result)
        XCTAssertEqual(client.freshFetchCount, 1)
        XCTAssertEqual(state.selectedSessionUsage, sampleUsage())
    }

    func testExplicitFreshRefreshPublishesOnlyTheFreshResponse() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let freshUsage = sampleUsage()
        client.onFreshFetch = { _ in freshUsage }
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })

        let result = await controller.refreshFreshAccount(for: "one")
        XCTAssertEqual(result, freshUsage)
        XCTAssertEqual(client.values["one"], freshUsage)
        XCTAssertEqual(state.selectedSessionUsage, freshUsage)
    }

    func testMissingSnapshotIsFailureAndNeverZero() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        controller.publishCachedUsage(for: "one")
        XCTAssertEqual(state.usageLoadState, .loading)
        await controller.loadUsage(for: "one")
        XCTAssertEqual(state.usageLoadState, .failed)
        XCTAssertNil(state.selectedSessionUsage)
    }

    func testStopInvalidatesInFlightResponseEvenWhenSelectionStaysTheSame() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        client.onFetch = { _ in controller.stopRefreshing(); return self.sampleUsage() }
        await controller.loadUsage(for: "one")
        XCTAssertNil(state.selectedSessionUsage)
    }

    func testProviderAndModelMustBothMatchBeforeDisplayingUsage() {
        let usage = sampleUsage()
        XCTAssertNotNil(usage.matching(provider: "test", model: nil))
        XCTAssertNil(usage.matching(provider: "other", model: nil))
        XCTAssertNil(usage.matching(provider: "test", model: "another-model"))
    }

    func testUsageRendersWithinNarrowAndWideComposerBudgets() throws {
        let populated = try JSONDecoder().decode(SessionUsageResponse.self, from: Data(
            #"{"account":{"available":true,"provider":"fixture","rateLimits":{"primary":{"usedPercent":25}}},"context":{"usedTokens":80,"contextWindow":100}}"#.utf8))
        for width in [240.0, 420.0, 700.0] {
            for snapshot in [populated, sampleUsage()] {
                let content = ChatUsageBar(sessionID: "fixture", usage: snapshot).frame(width: width).background(Color.white)
                let renderer = ImageRenderer(content: content)
                let image = try XCTUnwrap(renderer.nsImage)
                XCTAssertEqual(image.size.width, width, accuracy: 1)
                XCTAssertGreaterThan(image.size.height, 0)
                if let directory = ProcessInfo.processInfo.environment["CORPTIE_USAGE_CAPTURE_DIR"],
                   let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try png.write(to: URL(fileURLWithPath: directory).appending(path: "usage-\(Int(width))-\(snapshot.context == nil ? "empty" : "data").png"))
                }
            }
        }
    }

    func testMissingAndInvalidContextStayUnknownButReportedZeroIsValid() {
        XCTAssertNil(CodexContextUsage(usedTokens: nil, contextWindow: 100, remainingTokens: nil, usedPercent: nil).displayValues)
        XCTAssertNil(CodexContextUsage(usedTokens: -1, contextWindow: 100, remainingTokens: nil, usedPercent: nil).displayValues)
        XCTAssertNil(CodexContextUsage(usedTokens: 10, contextWindow: 0, remainingTokens: nil, usedPercent: nil).displayValues)
        XCTAssertEqual(CodexContextUsage(usedTokens: 0, contextWindow: 100, remainingTokens: nil, usedPercent: nil).displayValues?.used, 0)
        XCTAssertEqual(CodexContextUsage(usedTokens: 80, contextWindow: 100, remainingTokens: nil, usedPercent: nil).displayValues?.percent, 80)
    }

    func testPlaceholderStatesAreDistinct() {
        let states = [
            UsagePlaceholderPolicy.key(context: false, supported: false, loading: false, failed: false),
            UsagePlaceholderPolicy.key(context: false, supported: true, loading: true, failed: false),
            UsagePlaceholderPolicy.key(context: false, supported: true, loading: false, failed: true),
            UsagePlaceholderPolicy.key(context: false, supported: true, loading: false, failed: false)
        ]
        XCTAssertEqual(Set(states).count, 4)
        XCTAssertTrue(states.allSatisfy { !$0.contains("0") })
    }

    func testUsageEventsRejectOtherModelsProvidersAndSessions() {
        let client = SessionUsageClient(baseURL: URL(string: "http://127.0.0.1:1")!)
        let current = sampleUsage()
        let valid = #"{"payload":{"sessionId":"one","providerId":"test","model":null,"context":{"usedTokens":25,"contextWindow":100}}}"#
        XCTAssertEqual(client.applyingEvent(valid, sessionID: "one", current: current)?.context?.usedTokens, 25)
        XCTAssertNil(client.applyingEvent(valid, sessionID: "two", current: current))
        XCTAssertNil(client.applyingEvent(valid.replacingOccurrences(of: "test", with: "other"), sessionID: "one", current: current))
        XCTAssertNil(client.applyingEvent(valid.replacingOccurrences(of: "null", with: "\"old-model\""), sessionID: "one", current: current))
    }

    func testFreshAccountResponseIsDiscardedAfterConfigurationInvalidation() async {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        client.onFreshFetch = { _ in controller.invalidateConfiguration(); return self.sampleUsage() }
        let result = await controller.refreshFreshAccount(for: "one")
        XCTAssertNil(result)
        XCTAssertNil(state.selectedSessionUsage)
        XCTAssertEqual(state.usageLoadState, .loading)
    }

    func testStopCancelsDebouncedEventRefresh() async throws {
        let client = UsageServingStub()
        let state = SessionSupplementaryDataController()
        client.onEvent = sampleUsage()
        let controller = SessionUsageController(client: client, state: state, selectedSessionID: { "one" })
        controller.applyLiveEvent("fixture")
        controller.stopRefreshing()
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertEqual(client.fetchCount, 0)
    }

    private func sampleUsage() -> SessionUsageResponse {
        SessionUsageResponse(account: CodexAccountUsage(
            available: true, provider: "test", model: nil, rateLimits: nil, rateLimitsByLimitId: nil
        ), context: nil)
    }
}

@MainActor
private final class UsageServingStub: SessionUsageServing {
    var values: [String: SessionUsageResponse] = [:]
    var onEvent: SessionUsageResponse?
    var fetchCount = 0
    var freshFetchCount = 0
    var onFetch: (String) async throws -> SessionUsageResponse? = { _ in nil }
    var onFreshFetch: (String) async throws -> SessionUsageResponse? = { _ in nil }
    func cached(for sessionID: String) -> SessionUsageResponse? { values[sessionID] }
    func remember(_ usage: SessionUsageResponse, for sessionID: String) { values[sessionID] = usage }
    func fetch(for sessionID: String) async throws -> SessionUsageResponse? {
        fetchCount += 1
        return try await onFetch(sessionID)
    }
    func fetchFreshAccount(for sessionID: String) async throws -> SessionUsageResponse? {
        freshFetchCount += 1
        return try await onFreshFetch(sessionID)
    }
    func applyingEvent(_ data: String, sessionID: String?, current: SessionUsageResponse?) -> SessionUsageResponse? { onEvent }
}
