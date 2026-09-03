import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class ApplicationTerminationUITests: XCTestCase {
    // XCTest's Work-C invalid-object checker can over-release AppKit sheet
    // windows at the test autorelease-pool boundary. Retain these process-local
    // fixtures until the test bundle exits; the behavior under test still ends
    // and hides the sheet synchronously.
    private static var retainedWindows: [NSWindow] = []

    func testDismissesAttachedSheetBeforeTermination() {
        _ = NSApplication.shared
        let parent = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        let sheet = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        Self.retainedWindows.append(contentsOf: [parent, sheet])
        parent.orderFront(nil)
        parent.beginSheet(sheet)
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        XCTAssertTrue(parent.attachedSheet === sheet)

        let dismissedSheet = ApplicationTerminationUI.dismissAttachedSheets(from: [parent])

        XCTAssertTrue(dismissedSheet)
        XCTAssertNil(parent.attachedSheet)
        XCTAssertFalse(sheet.isVisible)
        parent.orderOut(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
}
