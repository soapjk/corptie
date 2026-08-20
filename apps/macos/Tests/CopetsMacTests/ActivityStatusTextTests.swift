import CoreGraphics
import XCTest
@testable import CorptieMac

@MainActor
final class ActivityStatusTextTests: XCTestCase {
    func testTerminalAuthoritativeDetailClearsStaleStartingActivity() {
        XCTAssertNil(BackendClient.reconciledActivityStatus(
            authoritativeStatus: .complete,
            authoritativeActivityStatus: nil,
            fallbackActivityStatus: "Starting Codex"
        ))
    }

    func testRunningAuthoritativeDetailMayRetainLastKnownActivity() {
        XCTAssertEqual(BackendClient.reconciledActivityStatus(
            authoritativeStatus: .running,
            authoritativeActivityStatus: nil,
            fallbackActivityStatus: "Running command"
        ), "Running command")
    }

    func testWideParentProposalCannotStretchStatusPastItsTextWidth() {
        let fitted = ActivityStatusText.fittedSize(
            proposedWidth: 900,
            proposedHeight: 40,
            intrinsicSize: CGSize(width: 84, height: 13)
        )

        XCTAssertEqual(fitted, CGSize(width: 84, height: 13))
    }

    func testNarrowParentProposalCompressesStatusInsteadOfExpandingTheRow() {
        let fitted = ActivityStatusText.fittedSize(
            proposedWidth: 48,
            proposedHeight: 40,
            intrinsicSize: CGSize(width: 84, height: 13)
        )

        XCTAssertEqual(fitted, CGSize(width: 48, height: 13))
    }

    func testUnboundedProposalUsesIntrinsicTextSize() {
        let fitted = ActivityStatusText.fittedSize(
            proposedWidth: .infinity,
            proposedHeight: nil,
            intrinsicSize: CGSize(width: 84, height: 13)
        )

        XCTAssertEqual(fitted, CGSize(width: 84, height: 13))
    }
}
