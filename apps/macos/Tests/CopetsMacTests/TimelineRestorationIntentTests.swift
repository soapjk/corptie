import XCTest
@testable import CorptieMac

final class TimelineRestorationIntentTests: XCTestCase {
    func testLateReadingAnchorCannotReplaceAnEstablishedLatestViewport() {
        let latest = AppKitChatTimelinePosition(
            rowID: "message:latest",
            offset: 0,
            absoluteScrollY: 1_200,
            followsLatest: true
        )
        let staleReadingAnchor = AppKitChatTimelinePosition(
            rowID: "message:old-reading-anchor",
            offset: 8,
            absoluteScrollY: 320,
            followsLatest: false
        )

        var intent = TimelineRestorationIntent(initialPosition: nil)
        intent.observeViewport(latest)

        XCTAssertFalse(intent.offerRestoration(staleReadingAnchor))
        XCTAssertNil(intent.requestedAnchorRowID)
        XCTAssertEqual(intent.lastObservedPosition, latest)
    }

    func testInitialReadingAnchorIsAcceptedBeforeViewportEstablishes() {
        let readingAnchor = AppKitChatTimelinePosition(
            rowID: "message:reading-anchor",
            offset: 11,
            absoluteScrollY: 640,
            followsLatest: false
        )

        var intent = TimelineRestorationIntent(initialPosition: nil)

        XCTAssertTrue(intent.offerRestoration(readingAnchor))
        XCTAssertEqual(intent.requestedAnchorRowID, readingAnchor.rowID)
    }

    func testFollowingLatestRelinquishesTheHistoryProjectionAnchor() {
        let readingAnchor = AppKitChatTimelinePosition(
            rowID: "message:reading-anchor",
            offset: 11,
            absoluteScrollY: 640,
            followsLatest: false
        )
        let latest = AppKitChatTimelinePosition(
            rowID: "message:latest",
            offset: 0,
            absoluteScrollY: 1_200,
            followsLatest: true
        )

        var intent = TimelineRestorationIntent(initialPosition: readingAnchor)
        intent.observeViewport(readingAnchor)
        intent.observeViewport(latest)

        XCTAssertNil(intent.requestedAnchorRowID)
    }

    func testHoverTimestampIncludesSeconds() {
        let text = nativeTimelineTimestampText(createdAt: "2026-09-05T12:34:56Z")

        XCTAssertFalse(text.isEmpty)
        XCTAssertTrue(text.contains("56"), "Expected seconds in timestamp, got: \(text)")
    }
}
