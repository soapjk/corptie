import XCTest
@testable import CorptieMac

@MainActor
final class BackgroundTaskCenterTests: XCTestCase {
    func testStatusActionsUseReadableHitTargetsAndAccessibleNames() throws {
        XCTAssertEqual(BackgroundTaskStatusBar.actionHitSize, CGSize(width: 24, height: 22))
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/BackgroundTaskCenter.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        XCTAssertTrue(contents.contains(".contentShape(Rectangle())"))
        XCTAssertTrue(contents.contains(".accessibilityLabel(L10n(\"重试\"))"))
        XCTAssertTrue(contents.contains(".accessibilityLabel(L10n(\"关闭\"))"))
        XCTAssertTrue(contents.contains(".accessibilityElement(children: .contain)"))
        let closeButton = try XCTUnwrap(contents.range(of: "center.dismiss(id: record.id)"))
        XCTAssertNotNil(contents.range(
            of: "in: Circle()",
            range: closeButton.lowerBound..<contents.endIndex
        ))
    }

    func testSuccessfulTaskAutomaticallyDisappearsAfterConfiguredDelay() async throws {
        XCTAssertEqual(BackgroundTaskCenter.defaultSuccessVisibilityDuration, .seconds(3))
        let center = BackgroundTaskCenter(successVisibilityDuration: .milliseconds(200))
        XCTAssertTrue(center.start(id: "work:auto-dismiss", title: "Create Work") {
            .success("Created")
        })

        try await waitForState(.succeeded, id: "work:auto-dismiss", center: center)
        XCTAssertEqual(center.records.count, 1)
        try await waitForRemoval(id: "work:auto-dismiss", center: center)
        XCTAssertTrue(center.records.isEmpty)
    }

    func testFailedTaskRemainsVisiblePastSuccessDismissalDelay() async throws {
        let center = BackgroundTaskCenter(successVisibilityDuration: .milliseconds(20))
        XCTAssertTrue(center.start(id: "work:failure", title: "Create Work") {
            .failure("Backend unavailable")
        })

        try await waitForState(.failed, id: "work:failure", center: center)
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertEqual(center.records.first?.state, .failed)
    }

    func testDuplicateStartIsRejectedWhileOperationIsRunning() async throws {
        let center = BackgroundTaskCenter()
        var invocationCount = 0

        let first = center.start(id: "work:stable", title: "Create Work") {
            invocationCount += 1
            try? await Task.sleep(for: .milliseconds(40))
            return .success("Created")
        }
        let duplicate = center.start(id: "work:stable", title: "Create Work") {
            invocationCount += 1
            return .success("Duplicate")
        }

        XCTAssertTrue(first)
        XCTAssertFalse(duplicate)
        try await waitForState(.succeeded, id: "work:stable", center: center)
        XCTAssertEqual(invocationCount, 1)
    }

    func testFailureRemainsVisibleAndRetryUsesSameOperation() async throws {
        let center = BackgroundTaskCenter()
        var invocationCount = 0
        XCTAssertTrue(center.start(id: "task:stable", title: "Create CorptieTask") {
            invocationCount += 1
            if invocationCount == 1 { return .failure("Backend unavailable") }
            return .success("Created")
        })

        try await waitForState(.failed, id: "task:stable", center: center)
        XCTAssertEqual(center.records.first?.detail, "Backend unavailable")
        XCTAssertTrue(center.retry(id: "task:stable"))
        try await waitForState(.succeeded, id: "task:stable", center: center)
        XCTAssertEqual(invocationCount, 2)
    }

    func testRunningTaskCannotBeDismissedAndCompletedTaskCan() async throws {
        let center = BackgroundTaskCenter()
        XCTAssertTrue(center.start(id: "work:dismiss", title: "Create Work") {
            try? await Task.sleep(for: .milliseconds(30))
            return .success("Created")
        })
        center.dismiss(id: "work:dismiss")
        XCTAssertEqual(center.records.count, 1)
        try await waitForState(.succeeded, id: "work:dismiss", center: center)
        center.dismiss(id: "work:dismiss")
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

    private func waitForRemoval(id: String, center: BackgroundTaskCenter) async throws {
        for _ in 0..<100 {
            if !center.records.contains(where: { $0.id == id }) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for removal of \(id)")
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
