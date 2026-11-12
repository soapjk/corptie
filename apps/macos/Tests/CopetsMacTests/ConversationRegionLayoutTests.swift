import AppKit
import SwiftUI
import CorptieConversation
import XCTest
@testable import CorptieMac

@MainActor final class ConversationRegionLayoutTests: XCTestCase {
    private struct ScrollProbe: NSViewRepresentable {
        let scroll: FirstLayoutRestoringScrollView
        func makeNSView(context: Context) -> FirstLayoutRestoringScrollView { scroll }
        func updateNSView(_ view: FirstLayoutRestoringScrollView, context: Context) { }
    }
    func testFloatingHeightChangeUpdatesClearanceWithoutResizingViewport() {
        let scroll = FirstLayoutRestoringScrollView(frame: .zero)
        let view = ConversationRegionContainer(content: ScrollProbe(scroll: scroll), accessory: Color.clear.frame(height: 100),
            atTop: false, height: nil, floating: AnyView(Color.clear.frame(height: 34)))
        view.frame.size = CGSize(width: 700, height: 600)
        view.layoutSubtreeIfNeeded()
        let viewport = view.content.frame
        var clearance: CGFloat?
        scroll.onFloatingClearance = { clearance = $0 }
        XCTAssertEqual(scroll.currentFloatingClearance, 34)
        view.applyRoots(content: ScrollProbe(scroll: scroll), accessory: Color.clear.frame(height: 100), overlap: 0,
            floating: AnyView(Color.clear.frame(height: 154)))
        view.floatingHost.invalidateIntrinsicContentSize()
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.content.frame, viewport)
        XCTAssertEqual(clearance ?? -1, 154, accuracy: 0.5)
    }

    func testRealQuickActionsFloatAboveEditorWithoutMovingTheViewportBoundary() {
        for width in [540.0, 920.0] {
            for height in [80.0, 160.0] {
                let editor = ConversationComposerDock(quickMessages: { EmptyView() }) {
                    ConversationComposerChrome(verticalPadding: 10, contentSpacing: 8, headerAtBottom: true) {
                        HStack { Text("Model"); Spacer(); Button("Send") {} }
                    } content: {
                        TextEditor(text: .constant("Draft")).frame(height: height)
                    }
                }
                let floating = VStack(spacing: 0) {
                    Image(systemName: "arrow.down").frame(height: 30)
                    Text("Checklist").frame(height: height == 160 ? 120 : 0)
                    ConversationQuickMessages(items: [], enabled: true) { _ in }
                        .padding(.bottom, 4)
                }
                let view = ConversationRegionContainer(content: Color.clear, accessory: editor,
                    atTop: false, height: nil, floating: AnyView(floating))
                let window = NSWindow(contentRect: .init(x: 0, y: 0, width: width, height: 700),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = view
                defer { window.contentView = nil }
                view.layoutSubtreeIfNeeded()
                XCTAssertEqual(view.content.frame.minY, view.accessory.frame.maxY, accuracy: 0.5)
                XCTAssertEqual(view.floatingHost.frame.minY, view.accessory.frame.maxY, accuracy: 0.5)
                XCTAssertGreaterThan(view.floatingHost.frame.height, 30)
                XCTAssertTrue(view.content.frame.contains(view.floatingHost.frame))
            }
        }
    }

    func testEmptyHeaderDoesNotReserveTitleHeight() throws {
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(false),
            transcript: { Color.clear }, detail: { Color.clear }))
        host.frame = CGRect(x: 0, y: 0, width: 600, height: 500)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        func find(_ view: NSView) -> ConversationRegionContainer<AnyView, AnyView>? {
            (view as? ConversationRegionContainer<AnyView, AnyView>) ?? view.subviews.lazy.compactMap(find).first
        }
        let region = try XCTUnwrap(find(host))
        XCTAssertEqual(region.accessory.frame.height, 0, accuracy: 0.5)
    }
    func testHeaderKeepsTopEdgeAcrossContainerResize() {
        let view = ConversationRegionContainer(content: Color.clear, accessory: Text("Title"), atTop: true, height: 64)
        for size in [CGSize(width: 800, height: 600), CGSize(width: 500, height: 400), CGSize(width: 900, height: 720)] {
            view.frame.size = size
            view.layoutSubtreeIfNeeded()
            XCTAssertEqual(view.accessory.frame.maxY, view.bounds.maxY, accuracy: 0.5)
            XCTAssertEqual(view.accessory.frame.height, 64, accuracy: 0.5)
            XCTAssertEqual(view.content.frame.maxY, view.accessory.frame.minY, accuracy: 0.5)
        }
    }
    func testInputGrowthOnlyShrinksMessageViewport() {
        let view = ConversationRegionContainer(content: Color.clear, accessory: Color.clear.frame(height: 40), atTop: false, height: nil)
        view.frame.size = CGSize(width: 700, height: 500)
        view.layoutSubtreeIfNeeded()
        let old = view.content.frame.height
        view.accessory.contentRoot = Color.clear.frame(height: 90)
        view.accessory.invalidateIntrinsicContentSize()
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.accessory.frame.minY, view.bounds.minY, accuracy: 0.5)
        XCTAssertEqual(view.content.frame.maxY, view.bounds.maxY, accuracy: 0.5)
        XCTAssertEqual(old - view.content.frame.height, 50, accuracy: 0.5)
    }

    private struct ResponsiveToolbarFixture: View {
        var editorHeight: CGFloat = 44
        var body: some View {
            ConversationComposerChrome(verticalPadding: 10, contentSpacing: 8, headerAtBottom: true) {
                ComposerEditorRowLayout(minimumEditorWidth: 100, preservesLeadingContentWidth: true) {
                    DockMarker(name: "leading").frame(width: 280, height: 32)
                    DockMarker(name: "actions").frame(width: 400, height: 30)
                }
            } content: {
                DockMarker(name: "responsive-editor").frame(height: editorHeight).padding(.horizontal, 10)
            }
            .modifier(WorkbenchReadingLane(compact: false))
        }
    }

    func testAccessoryIdealHeightUsesNativeWidthAcrossToolbarWrapAndEditorGrowth() throws {
        let view = ConversationRegionContainer(content: Color.clear, accessory: ResponsiveToolbarFixture(), atTop: false, height: nil)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 1233, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close() }
        func find(_ id: String, in view: NSView) -> NSView? {
            if view.identifier?.rawValue == id { return view }
            return view.subviews.lazy.compactMap { find(id, in: $0) }.first
        }
        var editor: NSView?
        for editorHeight: CGFloat in [44, 96] {
            view.applyRoots(content: Color.clear, accessory: ResponsiveToolbarFixture(editorHeight: editorHeight), overlap: 0)
            for width: CGFloat in [1233, 340, 1233] {
                window.setContentSize(.init(width: width, height: 700)); view.layoutSubtreeIfNeeded()
                let current = try XCTUnwrap(find("responsive-editor", in: view))
                if let editor { XCTAssertTrue(current === editor) } else { editor = current }
                let frame = current.convert(current.bounds, to: view.accessory)
                let topGap = view.accessory.isFlipped ? frame.minY : view.accessory.bounds.maxY - frame.maxY
                XCTAssertEqual(topGap, 10, accuracy: 0.5)
                XCTAssertEqual(view.accessory.frame.height, editorHeight + (width == 1233 ? 60 : 98), accuracy: 0.5)
                XCTAssertEqual(view.accessory.rootView.width ?? -1, width, accuracy: 0.5)
                XCTAssertEqual(view.content.frame.minY, view.accessory.frame.maxY, accuracy: 0.5)
                XCTAssertEqual(view.accessory.frame.minY, 0, accuracy: 0.5)
                print("WIDTH_BOUND window=\(width) editorHeight=\(editorHeight) accessory=\(view.accessory.frame) editorLocal=\(frame) topGap=\(topGap)")
            }
        }
    }
    func testAccessoryWidthBindingSettlesAfterFirstProposalAndHiddenResize() async throws {
        let view = ConversationRegionContainer(content: Color.clear, accessory: ResponsiveToolbarFixture(), atTop: false, height: nil)
        XCTAssertNil(view.accessory.rootView.width, "Before native constraints there is no invented viewport width")
        XCTAssertTrue(view.accessory.intrinsicContentSize.height.isFinite)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 1233, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close() }
        func editor(in view: NSView) -> NSView? {
            if view.identifier?.rawValue == "responsive-editor" { return view }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        view.layoutSubtreeIfNeeded()
        let original = try XCTUnwrap(editor(in: view))
        let commits = view.rootCommitCount
        for width: CGFloat in [340, 1233, 340, 1233] {
            view.isHidden = true
            window.setContentSize(.init(width: width, height: 700))
            view.layoutSubtreeIfNeeded()
            view.isHidden = false
            try await Task.sleep(for: .milliseconds(40))
            view.layoutSubtreeIfNeeded()
            let settledAccessory = view.accessory.frame, settledViewport = view.content.frame
            for _ in 0..<16 {
                view.layoutSubtreeIfNeeded()
                XCTAssertEqual(view.accessory.frame, settledAccessory)
                XCTAssertEqual(view.content.frame, settledViewport)
            }
            XCTAssertFalse(view.needsLayout)
            XCTAssertFalse(view.accessory.needsLayout)
            XCTAssertFalse(view.needsUpdateConstraints)
            XCTAssertEqual(view.accessory.rootView.width ?? -1, width, accuracy: 0.5)
            XCTAssertEqual(view.accessory.frame.height, width == 1233 ? 104 : 142, accuracy: 0.5)
            XCTAssertEqual(view.rootCommitCount, commits)
            XCTAssertTrue(editor(in: view) === original)
        }
    }

    func testQuickMessagesOverlapViewportWhileRemainingInInputHost() {
        // 34pt quick actions + 66pt editor share the same accessory host.
        let view = ConversationRegionContainer(content: Color.clear,
            accessory: Color.clear.frame(height: 100), atTop: false, height: nil, overlap: 34)
        for size in [CGSize(width: 700, height: 500), CGSize(width: 540, height: 380)] {
            view.frame.size = size
            view.layoutSubtreeIfNeeded()
            XCTAssertEqual(view.accessory.frame.height, 100, accuracy: 0.5)
            XCTAssertEqual(view.content.frame.minY, view.accessory.frame.maxY - 34, accuracy: 0.5)
            XCTAssertEqual(view.content.frame.intersection(view.accessory.frame).height, 34, accuracy: 0.5)
            XCTAssertGreaterThan(view.subviews.firstIndex(of: view.accessory)!, view.subviews.firstIndex(of: view.content)!, "Input controls remain above messages; the independent floating host is topmost")
        }
        // A pinned checklist uses normal stacking, with the same two hosts.
        view.setAccessoryOverlap(0)
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.content.frame.minY, view.accessory.frame.maxY, accuracy: 0.5)
    }
    private final class Marker: ObservableObject { }
    private struct EnvironmentProbe: View {
        @EnvironmentObject var marker: Marker
        @Environment(\.locale) var locale
        let report: (Marker, String) -> Void
        var body: some View {
            Color.clear.onAppear { report(marker, locale.identifier) }
        }
    }
    func testBothHostsInheritEnvironmentAndSharedObjects() {
        let marker = Marker()
        var received: [Marker] = []
        var locales: [String] = []
        let probe = { EnvironmentProbe { received.append($0); locales.append($1) } }
        let host = NSHostingView(rootView: ConversationRegionStack(accessoryAtTop: true, accessoryHeight: 64,
            content: probe, accessory: probe).environmentObject(marker).environment(\.locale, Locale(identifier: "zh_CN")))
        host.frame = CGRect(x: 0, y: 0, width: 600, height: 500)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(received.count, 2)
        XCTAssertTrue(received.allSatisfy { $0 === marker })
        XCTAssertEqual(locales, ["zh_CN", "zh_CN"])
    }

    private struct DockMarker: NSViewRepresentable {
        let name: String
        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            view.identifier = .init(name)
            return view
        }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    private struct DockFixture: View {
        let showsQuickMessages: Bool
        let editorHeight: CGFloat
        var body: some View {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ConversationComposerDock {
                    if showsQuickMessages { DockMarker(name: "quick").frame(height: 28) }
                } composer: {
                    DockMarker(name: "editor").frame(height: editorHeight)
                }
            }
        }
    }

    func testQuickMessagesAndEditorStayJoinedAtBottomWithoutExtraInsets() throws {
        let host = NSHostingView(rootView: DockFixture(showsQuickMessages: true, editorHeight: 80))
        func marker(_ name: String, in view: NSView) -> NSView? {
            if view.identifier?.rawValue == name { return view }
            return view.subviews.lazy.compactMap { marker(name, in: $0) }.first
        }
        var editor: NSView?
        for (height, editorHeight, showsQuick) in [(400.0, 80.0, true), (700.0, 80.0, true),
                                                  (500.0, 150.0, true), (600.0, 80.0, false),
                                                  (400.0, 80.0, true)] {
            host.rootView = DockFixture(showsQuickMessages: showsQuick, editorHeight: editorHeight)
            host.frame = .init(x: 0, y: 0, width: 600, height: height)
            host.layoutSubtreeIfNeeded()
            let current = try XCTUnwrap(marker("editor", in: host))
            if let editor { XCTAssertTrue(current === editor, "Quick-action visibility must retain the editor") }
            else { editor = current }
            let frame = current.convert(current.bounds, to: host)
            let bottom = host.isFlipped ? host.bounds.maxY - frame.maxY : frame.minY
            XCTAssertEqual(bottom, 0, accuracy: 0.5, "The dock must not add its own bottom inset")
            if showsQuick {
                let quick = try XCTUnwrap(marker("quick", in: host))
                let quickFrame = quick.convert(quick.bounds, to: host)
                let gap = host.isFlipped ? frame.minY - quickFrame.maxY : quickFrame.minY - frame.maxY
                XCTAssertEqual(gap, 0, accuracy: 0.5,
                    "Quick messages must follow the editor edge during resizing and editor growth")
            } else { XCTAssertNil(marker("quick", in: host)) }
        }
    }

    private struct NoticeDockFixture: View {
        let message: String?
        let modelName: String
        let hasUsage: Bool
        var body: some View {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ConversationComposerDock {
                    DockMarker(name: "quick").frame(height: 30)
                } composer: {
                    VStack(spacing: 0) {
                        SessionSendFailureSurface(message: message)
                        VStack {
                            DockMarker(name: "editor").frame(height: 44)
                            HStack {
                                Text("执行中")
                                if hasUsage { Text("上下文已用 11.7%") }
                                Spacer(minLength: 0)
                                Text(modelName).lineLimit(1).frame(maxWidth: 176)
                                DockMarker(name: "send").frame(width: 28, height: 28)
                            }
                        }
                    }
                }
            }
        }
    }

    func testOnlyNonemptyNoticesSeparateQuickMessagesFromEditorAcrossContentAndWindowSizes() throws {
        func marker(_ name: String, in view: NSView) -> NSView? {
            if view.identifier?.rawValue == name { return view }
            return view.subviews.lazy.compactMap { marker(name, in: $0) }.first
        }
        let host = NSHostingView(rootView: NoticeDockFixture(message: nil, modelName: "GPT", hasUsage: true))
        var originalEditor: NSView?
        for width: CGFloat in [320, 760] {
            for height: CGFloat in [400, 800] {
                for message in [nil, "", "   ", "发送失败"] as [String?] {
                    for hasUsage in [true, false] {
                        host.rootView = NoticeDockFixture(message: message,
                            modelName: hasUsage ? "GPT-6.1-Sol" : "WorkBuddy Local Long Model", hasUsage: hasUsage)
                        host.frame = .init(x: 0, y: 0, width: width, height: height)
                        host.layoutSubtreeIfNeeded()
                        let editor = try XCTUnwrap(marker("editor", in: host))
                        if let originalEditor { XCTAssertTrue(originalEditor === editor) }
                        else { originalEditor = editor }
                        let quick = try XCTUnwrap(marker("quick", in: host))
                        let ef = editor.convert(editor.bounds, to: host)
                        let qf = quick.convert(quick.bounds, to: host)
                        let gap = host.isFlipped ? ef.minY - qf.maxY : qf.minY - ef.maxY
                        if message == "发送失败" {
                            XCTAssertGreaterThan(gap, 6,
                                "A visible notice contributes its text height plus its existing 6pt bottom padding")
                        } else {
                            XCTAssertEqual(gap, 0, accuracy: 0.5,
                                "Absent and whitespace-only notices must not reserve an empty strip")
                        }
                        let send = try XCTUnwrap(marker("send", in: host))
                        XCTAssertEqual(send.convert(send.bounds, to: host).maxX, width, accuracy: 0.5)
                    }
                }
            }
        }
    }

    func testLiveResizeHoldsContentRootsAndCommitsLatestOnce() {
        let view = ConversationRegionContainer<AnyView, AnyView>(
            content: AnyView(Color.clear), accessory: AnyView(Text("Header")),
            atTop: true, height: 64)
        view.frame = NSRect(x: 0, y: 0, width: 800, height: 600)
        view.layoutSubtreeIfNeeded()
        let baseline = view.rootCommitCount

        view.liveResizeOverride = true
        for frame in 0..<10 {
            view.applyRoots(content: AnyView(Text("Messages \(frame)")),
                accessory: AnyView(Text("Header \(frame)")), overlap: 0)
        }
        XCTAssertEqual(view.rootCommitCount, baseline,
            "An AnyView root replacement rebuilds the whole transcript + rail tree")
        XCTAssertTrue(view.hasPendingRoots)

        // Geometry still reaches both hosts on every frame: text keeps wrapping
        // live while no view hierarchy is rebuilt.
        view.setFrameSize(NSSize(width: 620, height: 600))
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.content.frame.width, 620, accuracy: 0.5)
        XCTAssertEqual(view.accessory.frame.width, 620, accuracy: 0.5)
        XCTAssertEqual(view.rootCommitCount, baseline)

        view.liveResizeOverride = false
        view.commitPendingRoots()
        XCTAssertEqual(view.rootCommitCount, baseline + 1, "Exactly one commit at gesture end")
        XCTAssertFalse(view.hasPendingRoots)
        view.commitPendingRoots()
        XCTAssertEqual(view.rootCommitCount, baseline + 1, "Commit is idempotent")
    }

    func testDiscardingPendingRootsRestoresImmediateUpdates() {
        let view = ConversationRegionContainer<AnyView, AnyView>(
            content: AnyView(Color.clear), accessory: AnyView(Color.clear),
            atTop: true, height: 0)
        view.liveResizeOverride = true
        view.applyRoots(content: AnyView(Text("Held")), accessory: AnyView(Text("Held")), overlap: 0)
        XCTAssertTrue(view.hasPendingRoots)
        view.discardPendingRoots()
        XCTAssertFalse(view.hasPendingRoots)

        view.liveResizeOverride = false
        let baseline = view.rootCommitCount
        view.applyRoots(content: AnyView(Text("Fresh")), accessory: AnyView(Text("Fresh")), overlap: 0)
        XCTAssertEqual(view.rootCommitCount, baseline + 1)
        XCTAssertFalse(view.hasPendingRoots)
    }
}
