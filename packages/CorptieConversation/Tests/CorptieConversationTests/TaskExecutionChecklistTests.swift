#if os(macOS)
import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor @Suite(.serialized)
struct TaskExecutionChecklistTests {
    private func plan(count: Int, blocked: Bool = false, assigned: Bool = false) throws -> ConversationExecutionPlan {
        let steps: [[String: Any]] = (0..<count).map { index in
            var item: [String: Any] = ["stepId": "item:\(index)", "ordinal": index, "text": String(repeating: "长事项说明", count: 40), "status": "pending"]
            if blocked && index % 3 == 0 { item["reason"] = "等待用户输入"; item["status"] = "blocked" }
            if assigned { item["assignment"] = ["taskId": "task:child", "sessionId": "session:child", "title": "子任务", "status": "running"] }
            return item
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
        let point = NSPoint(x: 8, y: host.isFlipped ? 36 : host.bounds.height - 36)
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
    @Test func inlineExtentsMatchActualLayoutForEmptyShortLongAndBlockedLists() throws {
        for count in [0, 2, 8, 200] {
            for blocked in [false, true] {
                let value = try plan(count: count, blocked: blocked)
                for width: CGFloat in [240, 520, 780] {
                    let heights = TaskExecutionChecklist.heights(plan: value, width: width)
                    for expanded in [false, true] {
                        let expected = expanded ? heights.expanded : heights.collapsed
                        let host = NSHostingView(rootView: TaskExecutionChecklist(plan: value, width: width,
                            canEdit: false, isExpanded: expanded) { _ in Issue.record("Disclosure must not mutate the checklist") }
                            .frame(width: width))
                        host.frame = NSRect(x: 0, y: 0, width: width, height: expected)
                        host.layoutSubtreeIfNeeded()
                        #expect(host.fittingSize.height > 0)
                        #expect(abs(host.fittingSize.height - expected) <= 1)
                    }
                }
            }
        }
    }
    @Test func mouseDisclosureGrowsAndShrinksTheSameCardWithoutAPopup() async throws {
        let value = try plan(count: 8)
        let width: CGFloat = 240
        let heights = TaskExecutionChecklist.heights(plan: value, width: width)
        let host = NSHostingView(rootView: TaskExecutionChecklist(plan: value, width: width) { _ in
            Issue.record("Expanding must not submit business operations")
        }.frame(width: width))
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: heights.expanded))
        host.frame = NSRect(x: 0, y: 0, width: width, height: heights.collapsed)
        container.addSubview(host)
        let window = NSWindow(contentRect: container.bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = container
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(60))
        let visibleWindowCount = NSApp.windows.filter(\.isVisible).count
        for expanded in [true, false, true, false] {
            let height = host.fittingSize.height
            // Footer (16), gap (6) and half of the 18-point disclosure button.
            let fromTop = height - 31
            let point = NSPoint(x: 10, y: host.isFlipped ? fromTop : host.bounds.height - fromTop)
            let location = host.convert(point, to: nil)
            for (number, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
                let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: number + 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
                window.sendEvent(event)
            }
            try await Task.sleep(for: .milliseconds(30))
            let expected = expanded ? heights.expanded : heights.collapsed
            #expect(abs(host.fittingSize.height - expected) <= 1)
            host.setFrameSize(NSSize(width: width, height: expected))
            window.displayIfNeeded()
            #expect(window.childWindows?.isEmpty != false)
            #expect(NSApp.windows.filter(\.isVisible).count == visibleWindowCount)
        }
    }
    @Test func assignedRowsKeepMeasuredHeightAndMouseOpensChildWithoutCompletingItem() async throws {
        let value = try plan(count: 200, blocked: true, assigned: true)
        for width: CGFloat in [240, 520, 780] {
            for expanded in [false, true] {
                let heights = TaskExecutionChecklist.heights(plan: value, width: width)
                let expected = expanded ? heights.expanded : heights.collapsed
                let host = NSHostingView(rootView: TaskExecutionChecklist(plan: value, width: width, isExpanded: expanded) { _ in }
                    .frame(width: width))
                host.frame = NSRect(x: 0, y: 0, width: width, height: expected)
                host.layoutSubtreeIfNeeded()
                #expect(abs(host.fittingSize.height - expected) <= 1)
            }
        }
        var opened: String?
        let host = NSHostingView(rootView: TaskExecutionChecklist(plan: value, width: 520,
            openAssignment: { opened = $0.taskId }) { _ in Issue.record("Opening a child must not mutate completion") }
            .frame(width: 520, height: 240, alignment: .topLeading))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 240),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(80))
        host.layoutSubtreeIfNeeded(); window.displayIfNeeded()
        let point = NSPoint(x: 65, y: host.isFlipped ? 48 : host.bounds.height - 48)
        let location = host.convert(point, to: nil)
        for (number, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
            let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: number + 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        try await Task.sleep(for: .milliseconds(60))
        #expect(opened == "task:child")
    }

}
#endif
