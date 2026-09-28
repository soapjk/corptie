import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

@MainActor
enum ApplicationTerminationUI {
    @discardableResult
    static func dismissBlockingUI(in application: NSApplication) -> Bool {
        var dismissedBlockingUI = dismissAttachedSheets(from: application.windows)
        if let modalWindow = application.modalWindow {
            application.abortModal()
            modalWindow.orderOut(nil)
            dismissedBlockingUI = true
        }
        return dismissedBlockingUI
    }

    @discardableResult
    static func dismissAttachedSheets(from windows: [NSWindow]) -> Bool {
        // AppKit rejects terminate() before applicationShouldTerminate whenever
        // any sheet is attached. Treat transient confirmation/edit sheets as
        // cancelled so the normal unfinished-session shutdown guard can run.
        var dismissedSheet = false
        for parentWindow in windows {
            guard let sheet = parentWindow.attachedSheet else { continue }
            parentWindow.endSheet(sheet, returnCode: .cancel)
            sheet.orderOut(nil)
            dismissedSheet = true
        }
        return dismissedSheet
    }
}
