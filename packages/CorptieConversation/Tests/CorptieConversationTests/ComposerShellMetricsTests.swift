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
    @Test @MainActor func regularModelMenuHugsShortLabelsAndCapsLongLabels() {
        func size(_ model: String, limit: CGFloat) -> CGSize {
            let host = NSHostingView(rootView: ComposerModelMenuLabel(
                modelLabel: model, reasoningShortLabel: "中等", isBusy: false,
                maxWidth: limit, showsSurface: false, presentation: .regular))
            return host.fittingSize
        }
        let short = size("GPT-6", limit: 240)
        #expect(short.width < 120)
        #expect(abs(short.width - size("GPT-6", limit: 176).width) < 1)
        for limit: CGFloat in [176, 200, 240] {
            let long = size(String(repeating: "Long model name ", count: 8), limit: limit)
            #expect(long.width <= limit + 1)
            #expect(long.height == short.height)
        }
    }

    @MainActor private final class Mounts { var count = 0 }
    private struct EditorProbe: NSViewRepresentable {
        let mounts: Mounts
        var identifier = "test.resident-editor"
        func makeNSView(context: Context) -> NSView {
            mounts.count += 1
            let view = NSView()
            view.identifier = .init(identifier)
            return view
        }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    @Test @MainActor func footerReservesRealUsageWidthAndKeepsControlsSeparate() throws {
        let mounts = Mounts()
        func surface(stopping: Bool) -> some View {
            ComposerEditorRowLayout(minimumEditorWidth: 100, preservesLeadingContentWidth: true) {
                HStack(spacing: 6) {
                    Image(systemName: "plus").frame(width: 28, height: 28)
                    ConversationComposerStatusRow(isReady: true, readinessTitle: "", readinessMessage: "",
                        readinessCode: nil, executionState: .complete, activity: nil) {
                        HStack(spacing: 10) {
                            ConversationComposerUsageSlot {
                                SessionUsageItem(icon: "text.alignleft", value: "上下文已用 70.7%", progress: 0.707, color: .red)
                            }
                            ConversationComposerUsageSlot {
                                SessionUsageItem(icon: "bolt.fill", value: "额度剩余 36%", progress: 0.36, color: .red)
                            }
                        }.font(.system(size: 9, weight: .semibold)).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }.background(EditorProbe(mounts: mounts, identifier: "usage"))
                HStack(spacing: 6) {
                    Image(systemName: "cpu").frame(width: 14, height: 14)
                    ComposerModelMenuLabel(modelLabel: "GPT-6.1", reasoningShortLabel: "中",
                        isBusy: false, maxWidth: 176, showsSurface: false, presentation: .regular,
                        showsDisclosureIndicator: true)
                    if stopping { Color.red.frame(width: 32, height: 32) }
                    Image(systemName: "arrow.up").frame(width: 28, height: 28)
                }.background(EditorProbe(mounts: mounts, identifier: "controls"))
            }
        }
        func find(_ id: String, _ view: NSView) -> NSView? {
            if view.identifier?.rawValue == id { return view }
            return view.subviews.lazy.compactMap { find(id, $0) }.first
        }
        for stopping in [false, true] {
            let host = NSHostingView(rootView: surface(stopping: stopping))
            for width: CGFloat in [264, 320, 390, 560, 740] {
                host.frame = CGRect(x: 0, y: 0, width: width, height: 120)
                host.layoutSubtreeIfNeeded()
                let usage = try #require(find("usage", host)), controls = try #require(find("controls", host))
                let left = usage.convert(usage.bounds, to: host), right = controls.convert(controls.bounds, to: host)
                #expect(left.minX >= -1 && left.maxX <= width + 1)
                #expect(right.minX >= -1 && right.maxX <= width + 1)
                #expect(left.intersection(right).isEmpty)
                if width == 740 { #expect(abs(left.midY - right.midY) < 1) }
            }
        }
    }

    @Test @MainActor func unifiedComposerKeepsEditorAboveFooterAcrossNarrowWidths() throws {
        let editorMounts = Mounts(), footerMounts = Mounts()
        let host = NSHostingView(rootView: ConversationComposerChrome(verticalPadding: 10, contentSpacing: 8, headerAtBottom: true) {
            ComposerEditorRowLayout(minimumEditorWidth: 100) {
                EditorProbe(mounts: footerMounts, identifier: "test.footer.status").frame(height: 30)
                Text("Model and send").frame(width: 180, height: 30)
            }
        } content: {
            EditorProbe(mounts: editorMounts).frame(height: 72)
        })
        func find(_ identifier: String, in view: NSView) -> NSView? {
            if view.identifier?.rawValue == identifier { return view }
            return view.subviews.lazy.compactMap { find(identifier, in: $0) }.first
        }
        var original: NSView?
        for width: CGFloat in [640, 264, 640] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: 200)
            host.layoutSubtreeIfNeeded()
            let editor = try #require(find("test.resident-editor", in: host))
            let footer = try #require(find("test.footer.status", in: host))
            if let original { #expect(editor === original) } else { original = editor }
            let editorRect = editor.convert(editor.bounds, to: host)
            let footerRect = footer.convert(footer.bounds, to: host)
            #expect(editorRect.height == 72)
            #expect(editorRect.minX >= 0 && editorRect.maxX <= width + 1)
            #expect(footerRect.minX >= 0 && footerRect.maxX <= width + 1)
            #expect(host.isFlipped ? editorRect.maxY <= footerRect.minY : footerRect.maxY <= editorRect.minY)
        }
        #expect(editorMounts.count == 1)
        #expect(footerMounts.count == 1)
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

    @Test func regularMenusCapLongNamesWithoutChangingCompactCallers() {
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
