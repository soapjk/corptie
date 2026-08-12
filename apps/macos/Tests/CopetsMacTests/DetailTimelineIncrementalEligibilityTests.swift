import XCTest
@testable import CorptieMac

final class DetailTimelineIncrementalEligibilityTests: XCTestCase {
    func testHistoryPrependCannotReuseTailOnlyDisplayCache() {
        XCTAssertFalse(
            DetailTimelineIncrementalEligibility.canReuseCachedWindow(
                cachedVisibleMessageLimit: 7,
                requestedVisibleMessageLimit: 107
            )
        )
    }

    func testStreamingTailUpdateCanReuseUnchangedDisplayWindow() {
        XCTAssertTrue(
            DetailTimelineIncrementalEligibility.canReuseCachedWindow(
                cachedVisibleMessageLimit: 107,
                requestedVisibleMessageLimit: 107
            )
        )
    }
}
