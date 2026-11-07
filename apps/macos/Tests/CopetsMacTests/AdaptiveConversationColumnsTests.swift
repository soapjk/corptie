import AppKit
import SwiftUI
import CorptieConversation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct AdaptiveConversationColumnsTests {
    @MainActor private final class Visibility: ObservableObject {
        @Published var isVisible = false
    }

    private struct HeaderLayoutHarness: View {
        @ObservedObject var visibility: Visibility
        let header: NSView
        let transcript: NSView
        let inspector: NSView
        var body: some View {
            AdaptiveConversationColumns(isVisible: $visibility.isVisible) {
                NativeProbe(view: transcript)
            } detail: {
                NativeProbe(view: inspector)
            } header: {
                NativeProbe(view: header).frame(height: 64)
            }
        }
    }

    @MainActor @Test
    func adaptiveDetailReservesSpaceOnlyWhenFullReadingLaneFits() async throws {
        let visibility = Visibility()
        let header = NSView(), transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: HeaderLayoutHarness(visibility: visibility,
            header: header, transcript: transcript, inspector: inspector))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 700),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        // Layout only: never present the test window or inspect screen pixels.
        for width: CGFloat in [1400, 900, 1400] {
            window.setContentSize(NSSize(width: width, height: 700))
            var previousHeader: NSRect?
            for visible in [false, true, false] {
                visibility.isVisible = visible
                try await Task.sleep(for: .milliseconds(260))
                host.layoutSubtreeIfNeeded()
                let headerFrame = header.convert(header.bounds, to: host)
                let transcriptFrame = transcript.convert(transcript.bounds, to: host)
                #expect(abs(headerFrame.width - width) < 2)
                #expect(abs(headerFrame.height - 64) < 2)
                if let previousHeader { #expect(headerFrame == previousHeader) }
                previousHeader = headerFrame
                let docked = visible && width >= AdaptiveConversationColumns<Color, Color, EmptyView>.minimumDockedWidth
                let reserved = docked ? ConversationDetailWidgetMetrics.railWidth + MainWindowPageLayoutMetrics.columnSpacing : 0
                #expect(abs(transcriptFrame.width - (width - reserved)) < 2)
                #expect(!headerFrame.intersects(transcriptFrame.insetBy(dx: 1, dy: 1)))
                if visible && inspector.window === window {
                    let railFrame = inspector.convert(inspector.bounds, to: host)
                    #expect(!headerFrame.intersects(railFrame.insetBy(dx: 1, dy: 1)))
                    #expect(abs(railFrame.height - transcriptFrame.height) < 2)
                    #expect(abs(railFrame.width - ConversationDetailWidgetMetrics.railWidth) < 2)
                    #expect(docked)
                    #expect(!railFrame.intersects(transcriptFrame))
                    #expect(abs(railFrame.maxX - width) < 2)
                }
                #expect(transcript.window === window)
            }
        }
    }

    private struct NativeProbe: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    @MainActor @Test
    func detailOverlayKeepsTranscriptMountedAcrossWindowResizes() async throws {
        let transcript = NSView()
        let inspector = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
            NativeProbe(view: transcript)
        } detail: {
            NativeProbe(view: inspector)
                .frame(width: ConversationDetailWidgetMetrics.railWidth)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        for width: CGFloat in [900, 1400, 900] {
            window.setContentSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            host.layoutSubtreeIfNeeded()
            let reserved = width >= AdaptiveConversationColumns<Color, Color, EmptyView>.minimumDockedWidth
                ? ConversationDetailWidgetMetrics.railWidth + MainWindowPageLayoutMetrics.columnSpacing : 0
            #expect(abs(transcript.frame.width - (width - reserved)) < 2)
            #expect(transcript.window === window, "Resizing must keep the editor's native view mounted")
            if inspector.window === window { #expect(abs(inspector.frame.width - ConversationDetailWidgetMetrics.railWidth) < 2) }
        }
    }
    @MainActor private final class VisibilityControl {
        var value: Binding<Bool>?
    }
    private struct VisibilityProbe: NSViewRepresentable {
        @Environment(\.detailColumnVisibility) private var visibility
        let control: VisibilityControl
        func makeNSView(context: Context) -> NSView { NSView() }
        func updateNSView(_ view: NSView, context: Context) { control.value = visibility }
    }

    @MainActor @Test
    func narrowToggleIsTemporaryAndResizingDoesNotRemountTranscript() async throws {
        let preference = Visibility()
        preference.isVisible = true
        let control = VisibilityControl(), transcript = NSView(), rail = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: Binding(
            get: { preference.isVisible }, set: { preference.isVisible = $0 })) {
                NativeProbe(view: transcript)
            } detail: { NativeProbe(view: rail) } header: { VisibilityProbe(control: control) })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func settle() async throws {
            try await Task.sleep(for: .milliseconds(100))
            host.layoutSubtreeIfNeeded()
        }
        try await settle()
        #expect(rail.window === window)
        window.setContentSize(NSSize(width: 900, height: 600))
        try await settle()
        #expect(rail.window == nil)
        #expect(preference.isVisible, "Automatic compact mode must not overwrite the wide-window preference")
        #expect(control.value?.wrappedValue == false)
        control.value?.wrappedValue = true
        try await settle()
        #expect(rail.window === window)
        #expect(abs(transcript.frame.width - 900) < 2)
        let railFrame = rail.convert(rail.bounds, to: host)
        let transcriptFrame = transcript.convert(transcript.bounds, to: host)
        #expect(railFrame.intersects(transcriptFrame))
        func clickRegion(in view: NSView) -> DetailOutsideClickView? {
            if let result = view as? DetailOutsideClickView { return result }
            return view.subviews.lazy.compactMap { clickRegion(in: $0) }.first
        }
        let region = try #require(clickRegion(in: host))
        let regionFrame = region.convert(region.bounds, to: host)
        #expect(abs(regionFrame.width - railFrame.width) < 2)
        #expect(abs(regionFrame.height - railFrame.height) < 2)
        let event = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 10, y: 200),
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
            context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        region.observe(event)
        try await settle()
        #expect(control.value?.wrappedValue == false)
        #expect(rail.window == nil)
        window.setContentSize(NSSize(width: 1400, height: 600))
        try await settle()
        #expect(rail.window === window)
        #expect(transcript.window === window)
        #expect(control.value?.wrappedValue == true)
    }

    @MainActor @Test
    func outsideClickDismissalIgnoresCardClicksAndDisconnectsWhenDisabled() async throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        let region = DetailOutsideClickView(frame: NSRect(x: 500, y: 0, width: 324, height: 600))
        root.addSubview(region)
        window.contentView = root
        defer { region.update(enabled: false, dismiss: {}); window.contentView = nil }
        var dismissals = 0
        region.update(enabled: true) { dismissals += 1 }
        func click(_ x: CGFloat) throws -> NSEvent {
            try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: x, y: 200),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        }
        region.observe(try click(600))
        try await Task.sleep(for: .milliseconds(20))
        #expect(dismissals == 0)
        region.observe(try click(100))
        try await Task.sleep(for: .milliseconds(20))
        #expect(dismissals == 1)
        region.update(enabled: false, dismiss: {})
        region.observe(try click(100))
        try await Task.sleep(for: .milliseconds(20))
        #expect(dismissals == 1)
    }

}
