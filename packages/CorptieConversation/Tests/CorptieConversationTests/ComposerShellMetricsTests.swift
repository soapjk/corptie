import Testing
import Foundation
import CorptieClientCore
#if os(macOS)
import AppKit
import SwiftUI
#endif
@testable import CorptieConversation

@Suite("Shared composer input height")
struct ComposerShellMetricsTests {
    @Test func recommendationsDecodeTheSharedVersionedContract() throws {
        let data = Data(#"{"schemaVersion":1,"taskId":"task:a","items":[{"id":"a","text":"继续","scope":"task","count":3}]}"#.utf8)
        let value = try JSONDecoder().decode(ClientQuickMessageRecommendations.self, from: data)
        #expect(value.taskId == "task:a")
        #expect(value.items.first?.text == "继续")
        #expect(value.items.first?.count == 3)
    }

    #if os(macOS)
    @Test @MainActor func quickMessageRowStaysCompactWhenViewportIsTall() {
        let host = NSHostingView(rootView: ConversationQuickMessages(
            items: ClientQuickMessage.defaults, enabled: true, send: { _ in }))
        host.frame = NSRect(x: 0, y: 0, width: 320, height: 600)
        host.layoutSubtreeIfNeeded()
        #expect(host.fittingSize.height == 30)
        for width in [240.0, 480.0, 320.0] {
            host.setFrameSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height == 30)
        }
    }
    #endif
    #if os(macOS)
    @MainActor private final class Mounts { var count = 0 }
    private struct EditorProbe: NSViewRepresentable {
        let mounts: Mounts
        func makeNSView(context: Context) -> NSView {
            mounts.count += 1
            let view = NSView()
            view.identifier = .init("test.resident-editor")
            return view
        }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    @Test @MainActor func modelWrapKeepsTheSameNativeEditorAcrossTheBreakpoint() throws {
        let mounts = Mounts()
        let host = NSHostingView(rootView: ConversationComposerEditorRow(showsAttachments: false, showsModel: true) {
            EmptyView()
        } editor: {
            EditorProbe(mounts: mounts).frame(height: 30)
        } send: { EmptyView() } more: { EmptyView() } model: {
            ComposerModelMenuLabel(modelLabel: "A provider-neutral model with a long name", reasoningShortLabel: "Medium",
                isBusy: false, maxWidth: 200, showsSurface: false, presentation: .regular)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading))
        func editor(_ view: NSView) -> NSView? {
            if view.identifier?.rawValue == "test.resident-editor" { return view }
            return view.subviews.lazy.compactMap { editor($0) }.first
        }
        var original: NSView?
        for width: CGFloat in [640, 300, 640] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: 180)
            host.layoutSubtreeIfNeeded()
            let native = try #require(editor(host))
            if let original { #expect(native === original) } else { original = native }
            let frame = native.convert(native.bounds, to: host)
            #expect(frame.maxX <= width + 1)
            #expect(frame.width >= 176)
        }
        #expect(mounts.count == 1)
    }
    #endif

    @Test func regularMenusReserveReadableSpaceWithoutChangingCompactCallers() {
        for width: CGFloat in [0, 220, 360, 600, 1200] {
            let regular = ComposerShellMetrics.modelMenuMaxWidth(composerWidth: width, presentation: .regular)
            let compact = ComposerShellMetrics.modelMenuMaxWidth(composerWidth: width)
            #expect(regular >= 176 && regular <= 240)
            #expect(compact >= 54 && compact <= 74)
        }
        #expect(ComposerShellMetrics.modelMenuMaxWidth(composerWidth: .infinity, presentation: .regular).isFinite)
    }

    @Test("An empty or single-line input uses one row")
    func singleLineMinimum() {
        #expect(ComposerShellMetrics.minimumInputHeight == 30)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 0) == 30)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 28) == 30)
    }

    @Test("Wrapped content grows without exceeding the shared cap")
    func growsWithContent() {
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 30.2) == 31)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 63.2) == 64)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 140) == 96)
    }
}
