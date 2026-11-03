#if os(macOS)
import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor @Suite(.serialized)
struct TaskExecutionChecklistTests {
    private func plan(count: Int) throws -> ConversationExecutionPlan {
        let steps: [[String: Any]] = (0..<count).map { index in
            ["stepId": "item:\(index)", "ordinal": index, "text": String(repeating: "长事项说明", count: 40), "status": "pending"]
        }
        let source: [String: Any] = ["schemaVersion": 1, "planId": "checklist:task:one", "taskId": "task:one",
            "revision": 1, "lifecycle": "active", "completedCount": 0, "updatedAt": "2026-11-03T00:00:00Z", "steps": steps]
        return try JSONDecoder().decode(ConversationExecutionPlan.self, from: JSONSerialization.data(withJSONObject: source))
    }
    @Test func twoHundredLongItemsKeepPreviewBoundedAcrossColumnWidths() throws {
        let long = try plan(count: 200)
        for width: CGFloat in [240, 520, 780] {
            let host = NSHostingView(rootView: TaskExecutionChecklist(plan: long, width: width, canEdit: false) { _ in
                Issue.record("Read-only rendering must never execute a mutation")
            }.frame(width: width))
            host.frame = NSRect(x: 0, y: 0, width: width, height: 240)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.width <= width + 1)
            #expect(host.fittingSize.height < 220)
            #expect(TaskExecutionChecklist.previewHeight(plan: long, width: width) < 220)
        }
    }
    @Test func nativeMouseCompletionUsesTheStableItemAndCurrentRevision() async throws {
        let value = try plan(count: 200)
        var commands: [ExecutionChecklistCommand] = []
        let view = TaskExecutionChecklist(plan: value, width: 520) { command in commands.append(command) }
            .frame(width: 520, height: 220, alignment: .topLeading)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 220),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: view); window.contentView = host
        // Only the test-owned window becomes key; never activate another app.
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(100))
        _ = host.fittingSize
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let point = NSPoint(x: 12, y: host.isFlipped ? 42 : host.bounds.height - 42)
        let location = host.convert(point, to: nil)
        for (number, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
            let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: number + 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        try await Task.sleep(for: .milliseconds(100))
        #expect(commands.count == 1)
        #expect(commands.first?.itemId == "item:0")
        #expect(commands.first?.expectedRevision == 1)
        #expect(commands.first?.status == "completed")
    }
}
#endif
