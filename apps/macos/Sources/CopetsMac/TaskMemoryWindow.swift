import AppKit
import SwiftUI

/// One native window per Task; close releases the view and its observations.
@MainActor
final class TaskMemoryWindowManager: NSObject, NSWindowDelegate {
    static let shared = TaskMemoryWindowManager()
    private var windows: [String: NSWindow] = [:]

    func show(taskID: String, title: String) {
        if let window = windows[taskID] {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 580),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "工作项记忆 · \(title)"
        window.contentMinSize = NSSize(width: 520, height: 360)
        window.contentViewController = NSHostingController(rootView:
            MemoryManagementView(scope: .owner(type: "task", id: taskID)).padding(16)
        )
        window.isReleasedWhenClosed = false
        window.delegate = self
        windows[taskID] = window
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let id = windows.first(where: { $0.value === window })?.key else { return }
        windows.removeValue(forKey: id)
    }
}
