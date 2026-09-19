import AppKit
import SwiftUI

/// One native window per Task; close releases the view and its observations.
@MainActor
final class TaskMemoryWindowManager: NSObject, NSWindowDelegate {
    static let shared = TaskMemoryWindowManager()
    private var windows: [String: NSWindow] = [:]

    func show(taskID: String, title: String) {
        show(ownerType: "task", ownerID: taskID, title: title)
    }

    func show(workID: String, title: String) {
        show(ownerType: "work", ownerID: workID, title: title)
    }

    private func show(ownerType: String, ownerID: String, title: String) {
        let key = "\(ownerType):\(ownerID)"
        if let window = windows[key] {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 580),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "\(ownerType == "work" ? "Work 记忆" : "工作项记忆") · \(title)"
        window.contentMinSize = NSSize(width: 520, height: 360)
        window.contentViewController = NSHostingController(rootView:
            MemoryManagementView(scope: .owner(type: ownerType, id: ownerID)).padding(16)
        )
        window.isReleasedWhenClosed = false
        window.delegate = self
        windows[key] = window
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let id = windows.first(where: { $0.value === window })?.key else { return }
        windows.removeValue(forKey: id)
    }
}
