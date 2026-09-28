import XCTest
@testable import CorptieMac

@MainActor
final class SessionTimelineLocalOverlayTests: XCTestCase {
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
