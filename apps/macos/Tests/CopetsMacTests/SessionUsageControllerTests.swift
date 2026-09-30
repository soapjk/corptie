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
    func applyingEvent(_ data: String, sessionID: String?, current: SessionUsageResponse?) -> SessionUsageResponse? { nil }
}
