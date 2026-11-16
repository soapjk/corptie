#if os(macOS)
import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor @Suite(.serialized)
struct VerificationSwitchTests {
    private func value(shared: Bool, hasBudget: Bool = true, enabled: Bool = false) throws -> ClientVerificationPerformance {
        let budget: [String: Any] = ["instructionId":"original","taskId":"parent","sessionId":"logical:parent","instruction":"开发任务",
            "enabled":enabled,"limit":3,"used":34,"status":enabled ? "exhausted" : "disabled","paused":false,"running":false,"executionRunning":false,
            "revision":1,"resumeRequested":false,"resumeOperationIds":[],"runs":[],"runsHasMore":false]
        let source: [String: Any] = ["sessionId":shared ? "logical:child" : "logical:parent","taskId":shared ? "child" : "parent","available":true,
            "policyEditable":!shared,"revision":"1","policy":["enabled":false,"limit":3,"revision":0],"budgets":hasBudget ? [budget] : [],"limitation":"entry only"]
        return try JSONDecoder().decode(ClientVerificationPerformance.self, from: JSONSerialization.data(withJSONObject: source))
    }
    @Test func sharedBudgetSwitchIsActionableAndRetainsTheOriginalAccounting() async throws {
        var commands: [[String: ClientInspectorValue]] = []
        let host = NSHostingView(rootView: ConversationVerificationSection(value: try value(shared: true), perform: { commands.append($0) }).frame(width: 460))
        try await clickSwitch(host)
        #expect(commands.count == 1)
        #expect(commands.first?["action"] == .string("configure"))
        #expect(commands.first?["instructionId"] == .string("original"))
        #expect(commands.first?["enabled"] == .bool(true))
        #expect(commands.first?["limit"] == .number(37))
    }
    @Test func readOnlyViewCannotSendABudgetChange() async throws {
        var commands: [[String: ClientInspectorValue]] = []
        let host = NSHostingView(rootView: ConversationVerificationSection(value: try value(shared: true), canControl: false, perform: { commands.append($0) }).frame(width: 460))
        try await clickSwitch(host)
        #expect(commands.isEmpty)
    }
    @Test func primarySwitchChangesTheCurrentBudgetRatherThanTheFutureDefault() async throws {
        var commands: [[String: ClientInspectorValue]] = []
        let host = NSHostingView(rootView: ConversationVerificationSection(value: try value(shared: false), perform: { commands.append($0) }).frame(width: 460))
        try await clickSwitch(host)
        #expect(commands.first?["action"] == .string("configure"))
    }
    @Test func switchingOffPreservesTheLimitAndDoesNotRequestExtraRounds() async throws {
        var commands: [[String: ClientInspectorValue]] = []
        let host = NSHostingView(rootView: ConversationVerificationSection(value: try value(shared: true, enabled: true), perform: { commands.append($0) }).frame(width: 460))
        try await clickSwitch(host)
        #expect(commands.first?["enabled"] == .bool(false))
        #expect(commands.first?["limit"] == .number(3))
    }
    private func clickSwitch<Content: View>(_ host: NSHostingView<Content>) async throws {
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 460, height: host.fittingSize.height),styleMask: [.titled],backing: .buffered,defer: false)
        window.isReleasedWhenClosed = false;window.contentView = host;window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil);window.contentView = nil }
        try await Task.sleep(for: .milliseconds(80))
        func switches(_ view: NSView) -> [NSSwitch] {
            if let control = view as? NSSwitch { return [control] }
            return view.subviews.flatMap(switches)
        }
        let controls = switches(host)
        #expect(controls.count == 1, "The primary budget control must be a native switch, not a checkbox")
        let control = try #require(controls.first)
        let location = control.convert(.init(x: control.bounds.midX, y: control.bounds.midY), to: nil)
        for (number,type) in [NSEvent.EventType.leftMouseDown,.leftMouseUp].enumerated() {
            let event = try #require(NSEvent.mouseEvent(with:type,location:location,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,
                windowNumber:window.windowNumber,context:nil,eventNumber:number,clickCount:1,pressure:type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        try await Task.sleep(for: .milliseconds(60))
    }
}
#endif
