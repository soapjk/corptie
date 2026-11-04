import XCTest
@testable import CorptieMac

@MainActor
final class SessionTimelineLocalOverlayTests: XCTestCase {
    func testImmediateSubmissionCanFailWithoutDeletingAnAuthoritativeEcho() throws {
        let fixture = ChatPerformanceFixture.make(configuration: .init(turnCount: 1, rawItemCount: 3, longMessageCharacters: 32))
        let overlay = SessionTimelineLocalOverlay()
        let local = overlay.acknowledge("hello", messageID: "instant", deliveryID: "instant-delivery",
            to: fixture.session, residentDetail: fixture.detail, now: fixture.detail.updatedAt, submitting: true)
        XCTAssertEqual(local.items.last?.status, "processing")
        XCTAssertEqual(local.items.last?.sourceType, "local_submission")
        let projected = makeChatDisplayEntries(from: local.items)
        XCTAssertTrue(projected.last?.isProcessGroup == true)
        let failed = try XCTUnwrap(overlay.removeSubmission(messageID: "instant", sessionID: fixture.session.id, from: local))
        XCTAssertFalse(failed.items.contains { $0.id == "instant" })
        XCTAssertEqual(overlay.reconcile(fixture.detail, for: fixture.session.id), fixture.detail)
        let second = overlay.acknowledge("hello", messageID: "instant", deliveryID: "instant-delivery",
            to: fixture.session, residentDetail: fixture.detail, now: fixture.detail.updatedAt, submitting: true)
        let server = SessionTimelineLocalOverlay.detailReplacingItems(second) { item in
            var value = item
            if value.id == "instant" { value.sourceType = nil; value.userMessageStatus = "queued" }
            return value
        }
        let reconciled = overlay.reconcile(server, for: fixture.session.id)
        XCTAssertTrue(reconciled.items.contains { $0.id == "instant" && $0.userMessageStatus == "queued" })
        let retained = try XCTUnwrap(overlay.removeSubmission(messageID: "instant", sessionID: fixture.session.id, from: reconciled))
        XCTAssertEqual(retained, reconciled)
    }

    func testSendPublishesProcessingSynchronouslyAndFailureRemovesOnlyTheLocalRow() async throws {
        for reloadDetail in [true, false] {
            let fixture = ChatPerformanceFixture.make(configuration: .init(turnCount: 1, rawItemCount: 3, longMessageCharacters: 32))
            let commands = SessionCommandController()
            var current = fixture.detail
            var failed = false
            let controller = SessionMessageController(baseURL: URL(string: "http://127.0.0.1:1")!, commands: commands,
                timelineLocalOverlay: SessionTimelineLocalOverlay(), currentSession: { reloadDetail ? fixture.session : nil },
                currentDetail: { current }, activeSessions: { [fixture.session] }, cachedDetail: { _ in current },
                storeDetail: { value, _ in current = value }, publishReplacement: { _ in }, selectSession: { _ in },
                loadWorkspaceRecoveryStatus: { _ in }, currentError: { nil }, reportError: { _ in })
            XCTAssertTrue(controller.sendText("instant request", images: [], to: fixture.session, reloadDetail: reloadDetail,
                isChoiceSelection: false, onSuccess: {}, onFailure: { failed = true }))
            XCTAssertEqual(current.items.last?.text, "instant request", "Publication must happen before sendText returns")
            XCTAssertEqual(current.items.last?.sourceType, "local_submission")
            for _ in 0..<200 where !failed { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(failed)
            XCTAssertFalse(current.items.contains { $0.sourceType == "local_submission" })
            XCTAssertNotNil(commands.sendFailures[fixture.session.id])
        }
    }

    func testAcknowledgementSurvivesDelayedSnapshotAndClearsAfterServerEcho() {
        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 1, rawItemCount: 3, longMessageCharacters: 32
        ))
        let overlay = SessionTimelineLocalOverlay()
        let local = overlay.acknowledge(
            "hello", messageID: "delivery-message", deliveryID: "delivery",
            to: fixture.session, residentDetail: fixture.detail, now: fixture.detail.updatedAt
        )
        XCTAssertEqual(local.items.last?.id, "delivery-message")
        XCTAssertEqual(
            overlay.reconcile(fixture.detail, for: fixture.session.id).items.last?.id,
            "delivery-message"
        )
        XCTAssertEqual(overlay.reconcile(local, for: fixture.session.id), local)
        // A cache containing a local row is not an authoritative server echo.
        XCTAssertEqual(overlay.reconcile(fixture.detail, for: fixture.session.id).items.last?.id, "delivery-message")
        let serverEcho = SessionTimelineLocalOverlay.detailReplacingItems(local) { item in
            var value = item
            if value.id == "delivery-message" { value.sourceType = nil }
            return value
        }
        XCTAssertEqual(overlay.reconcile(serverEcho, for: fixture.session.id), serverEcho)
        // Once echoed, the local queue no longer resurrects an acknowledged row.
        XCTAssertEqual(overlay.reconcile(fixture.detail, for: fixture.session.id), fixture.detail)
    }

    func testLocalAcknowledgementsAreSessionScopedAndCanCreateColdDetail() {
        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 1, rawItemCount: 3, longMessageCharacters: 32
        ))
        let overlay = SessionTimelineLocalOverlay()
        let cold = overlay.acknowledge(
            "hello", messageID: "cold-message", deliveryID: "delivery",
            to: fixture.session, residentDetail: nil, now: fixture.detail.updatedAt
        )
        XCTAssertEqual(cold.items.map(\.id), ["cold-message"])
        XCTAssertEqual(cold.id, fixture.session.external?.threadId ?? fixture.session.id)
        XCTAssertEqual(overlay.reconcile(fixture.detail, for: "other-session"), fixture.detail)
        XCTAssertEqual(
            overlay.reconcile(fixture.detail, for: fixture.session.id).items.last?.id,
            "cold-message"
        )
    }

    func testHandledChoiceIsRememberedWithoutResidentDetail() {
        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 1, rawItemCount: 3, longMessageCharacters: 32
        ))
        let overlay = SessionTimelineLocalOverlay()
        let itemID = fixture.detail.items[0].id
        XCTAssertNil(overlay.markChoiceHandled(choiceId: itemID, selectedOptionId: "yes", in: nil))
        let choices = SessionTimelineLocalOverlay.detailReplacingItems(fixture.detail) { item in
            CodexThreadItem(
                id: item.id, turnId: item.turnId, turnStatus: item.turnStatus,
                type: "choice", title: item.title, text: item.text,
                options: nil, status: "pending", createdAt: item.createdAt
            )
        }
        let updated = overlay.applyingHandledChoices(to: choices)
        XCTAssertEqual(updated.items[0].status, "selected")
        XCTAssertEqual(updated.items[1].status, "pending")
        XCTAssertEqual(overlay.applyingHandledChoices(to: updated), updated)
    }
}
