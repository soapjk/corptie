import XCTest
@testable import CorptieMac

@MainActor
final class BackgroundTaskCenterTests: XCTestCase {
    func testDuplicateStartIsRejectedWhileOperationIsRunning() async throws {
        let center = BackgroundTaskCenter()
        var invocationCount = 0

        let first = center.start(id: "objective:stable", title: "Create Objective") {
            invocationCount += 1
            try? await Task.sleep(for: .milliseconds(40))
            return .success("Created")
        }
        let duplicate = center.start(id: "objective:stable", title: "Create Objective") {
            invocationCount += 1
            return .success("Duplicate")
        }

        XCTAssertTrue(first)
        XCTAssertFalse(duplicate)
        try await waitForState(.succeeded, id: "objective:stable", center: center)
        XCTAssertEqual(invocationCount, 1)
    }

    func testFailureRemainsVisibleAndRetryUsesSameOperation() async throws {
        let center = BackgroundTaskCenter()
        var invocationCount = 0
        XCTAssertTrue(center.start(id: "work_item:stable", title: "Create WorkItem") {
            invocationCount += 1
            if invocationCount == 1 { return .failure("Backend unavailable") }
            return .success("Created")
        })

        try await waitForState(.failed, id: "work_item:stable", center: center)
        XCTAssertEqual(center.records.first?.detail, "Backend unavailable")
        XCTAssertTrue(center.retry(id: "work_item:stable"))
        try await waitForState(.succeeded, id: "work_item:stable", center: center)
        XCTAssertEqual(invocationCount, 2)
    }

    func testRunningTaskCannotBeDismissedAndCompletedTaskCan() async throws {
        let center = BackgroundTaskCenter()
        XCTAssertTrue(center.start(id: "objective:dismiss", title: "Create Objective") {
            try? await Task.sleep(for: .milliseconds(30))
            return .success("Created")
        })
        center.dismiss(id: "objective:dismiss")
        XCTAssertEqual(center.records.count, 1)
        try await waitForState(.succeeded, id: "objective:dismiss", center: center)
        center.dismiss(id: "objective:dismiss")
        XCTAssertTrue(center.records.isEmpty)
    }

    func testAuthoritativeSuccessReconcilesAStaleBackendConnectionFailure() async throws {
        let center = BackgroundTaskCenter()
        XCTAssertTrue(center.start(
            id: BackgroundTaskCenter.backendConnectionTaskID,
            title: L10n("Connect to the server")
        ) {
            .failure("Connection refused")
        })
        try await waitForState(
            .failed,
            id: BackgroundTaskCenter.backendConnectionTaskID,
            center: center
        )

        XCTAssertTrue(center.completeSuccessfully(
            id: BackgroundTaskCenter.backendConnectionTaskID,
            detail: L10n("Connected to the server")
        ))
        XCTAssertEqual(center.records.first?.state, .succeeded)
        XCTAssertEqual(center.records.first?.detail, L10n("Connected to the server"))
        XCTAssertFalse(center.retry(id: BackgroundTaskCenter.backendConnectionTaskID))
    }

    func testBackendConnectionFirstAttemptObservesWithoutDuplicateRefresh() async {
        let state = BackendConnectionTestState(connected: true)
        let operation = BackendConnectionStatusOperation(
            timeout: .milliseconds(20),
            pollInterval: .milliseconds(1),
            isConnected: { state.connected },
            errorMessage: { nil },
            retryConnection: { state.refreshCount += 1 }
        )

        let firstOutcome = await operation.run()
        XCTAssertEqual(firstOutcome, .success(L10n("Connected to the server")))
        XCTAssertEqual(state.refreshCount, 0)

        state.connected = false
        _ = await operation.run()
        XCTAssertEqual(state.refreshCount, 1)
    }

    func testBackendConnectionFailureIsVisibleAndRetryCanRecover() async throws {
        let center = BackgroundTaskCenter()
        let state = BackendConnectionTestState(connected: false)
        let operation = BackendConnectionStatusOperation(
            timeout: .milliseconds(20),
            pollInterval: .milliseconds(1),
            isConnected: { state.connected },
            errorMessage: { "Connection refused" },
            retryConnection: {
                state.refreshCount += 1
                state.connected = true
            }
        )
        XCTAssertTrue(center.start(
            id: BackgroundTaskCenter.backendConnectionTaskID,
            title: L10n("Connect to the server")
        ) {
            await operation.run()
        })

        try await waitForState(
            .failed,
            id: BackgroundTaskCenter.backendConnectionTaskID,
            center: center
        )
        XCTAssertTrue(center.records[0].detail.contains("Connection refused"))
        XCTAssertTrue(center.retry(id: BackgroundTaskCenter.backendConnectionTaskID))
        try await waitForState(
            .succeeded,
            id: BackgroundTaskCenter.backendConnectionTaskID,
            center: center
        )
        XCTAssertEqual(state.refreshCount, 1)
    }

    private func waitForState(
        _ state: BackgroundTaskState,
        id: String,
        center: BackgroundTaskCenter
    ) async throws {
        for _ in 0..<100 {
            if center.records.first(where: { $0.id == id })?.state == state { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for \(state) for \(id)")
    }
}

@MainActor
private final class BackendConnectionTestState {
    var connected: Bool
    var refreshCount = 0

    init(connected: Bool) {
        self.connected = connected
    }
}
