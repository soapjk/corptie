import XCTest
@testable import CorptieMac

@MainActor
final class SessionContextReferenceControllerTests: XCTestCase {
    func testMissingSelectionClearsReferencesWithoutRequest() async {
        let api = ContextReferenceAPIStub()
        let state = SessionSupplementaryDataController()
        state.selectedContextReferences = [reference()]
        let controller = SessionContextReferenceController(
            api: api, state: state, selectedSession: { nil }, reportError: { _ in }
        )
        await controller.loadContextReferences()
        XCTAssertTrue(state.selectedContextReferences.isEmpty)
        XCTAssertEqual(api.listCount, 0)
    }

    func testResponseAfterSelectionChangeDoesNotReplaceTheNewSessionsReferences() async {
        let api = ContextReferenceAPIStub()
        let state = SessionSupplementaryDataController()
        var selected: TaskSession? = session()
        let target = selected!
        let preserved = reference(id: "new-selection")
        state.selectedContextReferences = [preserved]
        let returned = reference(id: "old-response")
        api.onList = { _ in selected = nil; return [returned] }
        let controller = SessionContextReferenceController(
            api: api, state: state, selectedSession: { selected }, reportError: { _ in }
        )
        await controller.loadContextReferences(for: target)
        XCTAssertEqual(state.selectedContextReferences, [preserved])
        XCTAssertFalse(state.isLoadingContextReferences)
    }

    func testListFailureReportsErrorAndReleasesLoadingWithoutDiscardingExistingData() async {
        let api = ContextReferenceAPIStub()
        let state = SessionSupplementaryDataController()
        let target = session()
        let preserved = reference()
        state.selectedContextReferences = [preserved]
        var reported: String?
        api.onList = { _ in throw BackendError.message("unavailable") }
        let controller = SessionContextReferenceController(
            api: api, state: state, selectedSession: { target }, reportError: { reported = $0 }
        )
        await controller.loadContextReferences()
        XCTAssertTrue(reported?.contains("unavailable") == true)
        XCTAssertFalse(state.isLoadingContextReferences)
        XCTAssertEqual(state.selectedContextReferences, [preserved])
    }

    func testEnableMutationUsesSelectedSessionAndReloadsSharedPanel() async {
        let api = ContextReferenceAPIStub()
        let state = SessionSupplementaryDataController()
        let target = session()
        let item = reference()
        api.onList = { _ in [item] }
        let controller = SessionContextReferenceController(
            api: api, state: state, selectedSession: { target }, reportError: { _ in }
        )
        await controller.setContextReferenceEnabled(item, enabled: false)
        XCTAssertEqual(api.updatedSessionID, target.id)
        XCTAssertEqual(api.updatedReferenceID, item.referenceId)
        XCTAssertEqual(api.updatedBody?["enabled"] as? Bool, false)
        XCTAssertEqual(api.listCount, 1)
        XCTAssertEqual(state.selectedContextReferences, [item])
    }

    private func session() -> TaskSession {
        var session = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 1, rawItemCount: 3, longMessageCharacters: 32
        )).session
        session.sessionKind = .assistantChat
        return session
    }

    private func reference(id: String = "reference:1") -> SessionContextReference {
        SessionContextReference(
            referenceId: id, ownerSessionId: "session:1", targetType: .webURL,
            targetKey: "example", targetId: nil, locator: "https://example.com",
            displayName: "Example", inclusionMode: "snapshot", enabled: true,
            priority: 0, status: "ready", snapshotTitle: nil, snapshotAt: nil,
            contentHash: nil, createdAt: "2026-09-27", updatedAt: "2026-09-27"
        )
    }
}

@MainActor
private final class ContextReferenceAPIStub: SessionContextReferenceServing {
    var listCount = 0
    var updatedSessionID: String?
    var updatedReferenceID: String?
    var updatedBody: [String: Any]?
    var onList: (String) async throws -> [SessionContextReference] = { _ in [] }
    func list(sessionID: String) async throws -> [SessionContextReference] {
        listCount += 1
        return try await onList(sessionID)
    }
    func add(sessionID: String, type: SessionContextReferenceType, targetID: String?, locator: String?, displayName: String?) async throws {}
    func refresh(sessionID: String, referenceID: String) async throws {}
    func delete(sessionID: String, referenceID: String) async throws {}
    func update(sessionID: String, referenceID: String, body: [String: Any]) async throws {
        updatedSessionID = sessionID
        updatedReferenceID = referenceID
        updatedBody = body
    }
}
