import AppKit
import Testing
@testable import CorptieMac

@MainActor
struct ApplicationTerminationUITests {
    @Test func dismissesAttachedSheetBeforeTermination() {
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
        defer {
            sheet.close()
            parent.close()
        }
        parent.beginSheet(sheet)
        #expect(parent.attachedSheet === sheet)

        ApplicationTerminationUI.dismissAttachedSheets(from: [parent])

        #expect(parent.attachedSheet == nil)
        #expect(!sheet.isVisible)
    }
}
