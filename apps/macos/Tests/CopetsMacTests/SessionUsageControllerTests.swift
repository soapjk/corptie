import XCTest
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

    private func sampleUsage() -> SessionUsageResponse {
        SessionUsageResponse(account: CodexAccountUsage(
            available: true, provider: "test", model: nil, rateLimits: nil, rateLimitsByLimitId: nil
        ), context: nil)
    }
}

@MainActor
private final class UsageServingStub: SessionUsageServing {
    var values: [String: SessionUsageResponse] = [:]
    var fetchCount = 0
    var onFetch: (String) async throws -> SessionUsageResponse? = { _ in nil }
    func cached(for sessionID: String) -> SessionUsageResponse? { values[sessionID] }
    func remember(_ usage: SessionUsageResponse, for sessionID: String) { values[sessionID] = usage }
    func fetch(for sessionID: String) async throws -> SessionUsageResponse? {
        fetchCount += 1
        return try await onFetch(sessionID)
    }
    func applyingEvent(_ data: String, sessionID: String?, current: SessionUsageResponse?) -> SessionUsageResponse? { nil }
}
