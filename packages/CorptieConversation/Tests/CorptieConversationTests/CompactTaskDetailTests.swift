import SwiftUI
import Testing
import Observation
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit

@MainActor struct CompactTaskDetailTests {
    @MainActor @Observable final class Commands {
        var busy = false
        var values: [Bool] = []
        var targets: [String] = []
    }

    @MainActor private final class Fixture {
        let repository = ClientDetailBusinessRepository()
        let presentation = ConversationDetailPresentationRepository()
        let handle: ClientDetailBusinessHandle
        let commands = Commands()
        let window: NSWindow
        let host: NSHostingView<AnyView>
        var revision = 0

        init() throws {
            _ = NSApplication.shared
            let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "test", principalID: "test",
                sessionID: "session:current", taskID: "task:current", workID: "work:current")
            handle = repository.entry(for: scope)
            let selection = ClientDetailConfiguration.Selection(id: "fixture", title: "Fixture", choices: [], canSelect: false)
            let adapters = ConversationDetailAdapters(configuration: .init(provider: selection, model: selection, reasoning: selection),
                selectConfiguration: { _, _ in }, reloadConfiguration: {},
                readTurnSummary: { _ in throw ClientDetailConfigurationFailure.unavailable },
                readTurnTrace: { _, _ in throw ClientDetailConfigurationFailure.unavailable },
                worktreeAPI: { _ in throw ClientDetailConfigurationFailure.unavailable }, onWorktreeJob: { _ in }, resident: .init())
            let retained = presentation.entry(for: scope)
            let handle = handle, commands = commands
            host = NSHostingView(rootView: AnyView(ConversationDetailDashboard {
                ConversationNativeBusinessDetail(store: handle.store, api: nil, actions: nil,
                    context: .init(sessionKind: "worker", taskID: scope.taskID, workID: scope.workID),
                    adapters: adapters, handle: handle, arrangement: retained.arrangement, refresh: {},
                    canCommand: { _, action in handle.store.isCurrent && action.available && !commands.busy },
                    perform: { _, action, fields in
                        commands.values.append(fields["coordinationEnabled"] == .bool(true))
                        commands.targets.append(action.target?.id ?? "")
                    })
                    .environment(\.detailPresentation, retained)
            }))
            window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: 324, height: 650),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        }

        func publish(focus: String = "核对当前布局", progress: String = "已完成排查", enabled: Bool = false,
                     supported: Bool = true, available: Bool = true, hiddenLength: Int = 1) throws {
            revision += 1
            let hidden = String(repeating: "REMOVED_CONTENT", count: hiddenLength)
            let data: [String: Any] = ["taskId": "task:current", "title": hidden, "status": "active",
                "description": hidden, "acceptanceCriteria": hidden, "verificationCriteria": hidden,
                "resourceRevision": "\(revision)", "coordinationEnabled": enabled,
                "coordinationExecution": ["status": supported ? "enforced" : "unsupported", "reason": hidden],
                "coordinationDispatches": (0..<5).map { ["dispatchId": "dispatch:\($0)", "title": hidden, "status": "completed"] },
                "summary": ["state": "ready", "focus": focus, "progress": progress, "intervention": "required",
                            "reason": hidden, "nextAction": hidden, "current": true]]
            let command: [String: Any] = ["id": "coordination", "kind": "command", "operation": "task.coordination.update",
                "label": ["fallback": "协调模式"], "available": available,
                "target": ["resourceType": "task", "id": "task:current"], "expectedResourceRevision": "\(revision)"]
            let edit: [String: Any] = ["id": "edit", "kind": "navigation", "operation": "editor.open",
                "label": ["fallback": "REMOVED_EDITOR"], "available": true,
                "target": ["resourceType": "task", "id": "task:current"]]
            let cards: [[String: Any]] = [
                ["id": "session", "kind": "sessionInfo", "version": 1, "revision": "1", "loadState": "ready",
                 "actions": [], "data": ["sessionId": "session:current", "workName": "REMOVED_WORK"]],
                ["id": "task", "kind": "taskInfo", "version": 1, "revision": "\(revision)", "loadState": "ready",
                 "actions": [command, edit], "data": data]]
            try handle.store.receive(.decode(JSONSerialization.data(withJSONObject: ["protocolVersion": 1,
                "catalog": "native-business-v1", "documentId": "detail", "sessionId": "session:current",
                "generation": "fixture", "revision": "\(revision)", "cards": cards, "order": ["session", "task"]])))
        }

        func settle() async throws {
            try await Task.sleep(for: .milliseconds(60))
            host.layoutSubtreeIfNeeded()
        }
        func views<T: NSView>(_ type: T.Type) -> [T] {
            func all(_ view: NSView) -> [T] { (view as? T).map { [$0] } ?? view.subviews.flatMap(all) }
            return all(host)
        }
        func clickSwitch() async throws {
            let control = try #require(views(NSSwitch.self).first)
            if control.isEnabled { control.performClick(nil) }
            try await settle()
        }
        func cardHeight() throws -> CGFloat {
            let cards = views(DetailCardProbe.View.self)
            #expect(cards.count == 1, "The removed Session card must leave no slot or native host")
            return try #require(cards.first).bounds.height
        }
        func close() { window.orderOut(nil); window.contentView = nil; window.close() }
    }

    @Test func taskCardContainsOnlyFocusProgressAndSwitchAndFitsChangingText() async throws {
        let f = try Fixture(); defer { f.close() }
        try f.publish(); try await f.settle()
        #expect(f.views(NSScrollView.self).count == 1, "Only the Detail rail scrolls")
        let baseline = try f.cardHeight()
        #expect(baseline > 80 && baseline < 210)
        let state = try #require(f.handle.store.orderedCards.last)
        try f.publish(hiddenLength: 100); try await f.settle()
        #expect(abs(try f.cardHeight() - baseline) < 1, "Removed fields must not reserve height")
        #expect(f.handle.store.orderedCards.last === state)
        let long = String(repeating: "目前只保留当前重点与进展，并确保完整显示。", count: 8)
        try f.publish(focus: long); try await f.settle()
        #expect(try f.cardHeight() > baseline + 50, "Focus text must be fully rendered")
        try f.publish(progress: long); try await f.settle()
        #expect(try f.cardHeight() > baseline + 50, "Progress text must be fully rendered")
        try f.publish(focus: long, progress: long); try await f.settle()
        #expect(try f.cardHeight() > baseline + 100)
        f.window.setContentSize(.init(width: 244, height: 650)); try await f.settle()
        let narrow = try f.cardHeight()
        f.window.setContentSize(.init(width: 324, height: 650)); try await f.settle()
        #expect(try f.cardHeight() < narrow)
        try f.publish(); try await f.settle()
        #expect(abs(try f.cardHeight() - baseline) < 1)
        for _ in 0..<16 { f.host.layoutSubtreeIfNeeded() }
        #expect(abs(try f.cardHeight() - baseline) < 1)
        #expect(f.commands.values.isEmpty)
        print("COMPACT_TASK baseline=\(baseline) longNarrow=\(narrow) scrolls=\(f.views(NSScrollView.self).count)")
    }

    @Test func compactCoordinationKeepsBoundActionAndCapabilityGuards() async throws {
        let f = try Fixture(); defer { f.close() }
        try f.publish(); try await f.settle()
        try await f.clickSwitch()
        #expect(f.commands.values == [true])
        #expect(f.commands.targets == ["task:current"])
        f.commands.busy = true; try await f.settle(); try await f.clickSwitch()
        #expect(f.commands.values == [true], "Updating must disable repeat commands")
        f.commands.busy = false
        try f.publish(enabled: false, supported: false); try await f.settle(); try await f.clickSwitch()
        #expect(f.commands.values == [true], "Unsupported mode cannot be enabled")
        try f.publish(enabled: true, supported: false); try await f.settle(); try await f.clickSwitch()
        #expect(f.commands.values == [true, false], "An unsupported active mode can still be disabled")
        try f.publish(available: false); try await f.settle(); try await f.clickSwitch()
        #expect(f.commands.values == [true, false])
        try f.publish(); f.handle.store.markRefreshing(); try await f.settle(); try await f.clickSwitch()
        #expect(f.commands.values == [true, false])
        #expect(f.commands.targets == ["task:current", "task:current"])
    }
}
#endif
