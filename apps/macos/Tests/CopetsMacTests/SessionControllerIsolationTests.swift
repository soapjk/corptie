import Combine
import XCTest
@testable import CorptieMac

@MainActor
final class SessionControllerIsolationTests: XCTestCase {
    func testCommandAndSupplementaryUpdatesDoNotInvalidateBackendClient() {
        let client = BackendClient()
        var backendInvalidations = 0
        let cancellable = client.objectWillChange.sink {
            backendInvalidations += 1
        }

        client.sessionCommandController.isSendingMessage = true
        client.supplementaryDataController.selectedContextReferences = []
        client.supplementaryDataController.isLoadingContextReferences = true

        XCTAssertEqual(backendInvalidations, 0)
        withExtendedLifetime(cancellable) {}
    }

    func testSelectionStillInvalidatesComputedSelectedSessionSurface() {
        let client = BackendClient()
        var backendInvalidations = 0
        let cancellable = client.objectWillChange.sink {
            backendInvalidations += 1
        }

        client.sessionSelectionController.select("session:selection-isolation")

        XCTAssertEqual(backendInvalidations, 1)
        withExtendedLifetime(cancellable) {}
    }

    func testGesturePositionStoresDoNotPublishSwiftUIInvalidations() {
        let controller = SessionViewportController(hotCapacity: 4, repository: nil)
        var invalidations = 0
        let cancellable = controller.objectWillChange.sink {
            invalidations += 1
        }

        controller.store(
            AppKitChatTimelinePosition(
                rowID: "message:one",
                offset: 12,
                absoluteScrollY: 200,
                followsLatest: false
            ),
            for: "session:one"
        )

        XCTAssertEqual(invalidations, 0)
        XCTAssertEqual(controller.position(for: "session:one")?.rowID, "message:one")
        withExtendedLifetime(cancellable) {}
    }

    func testTerminationFlushPersistsTheLastCapturedViewportBeforeReturning() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "session-controller-isolation-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = SessionTimelinePositionRepository(
            databaseURL: directory.appendingPathComponent("presentation.sqlite3")
        )
        let controller = SessionViewportController(hotCapacity: 4, repository: repository)
        let position = AppKitChatTimelinePosition(
            rowID: "process:last-turn",
            offset: 31,
            absoluteScrollY: 900,
            followsLatest: false
        )
        controller.store(position, for: "session:termination")

        XCTAssertTrue(controller.persistSynchronouslyForTermination())
        let stored = try await repository.load(sessionID: "session:termination")

        XCTAssertEqual(stored?.position, position)
    }
}
