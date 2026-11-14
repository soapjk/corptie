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
                // Track the real accessory height. A taller probe would spill
                // out of the pinned header band and falsely overlap the
                // transcript in this geometry test.
                NativeProbe(view: header).frame(height: MainWindowPageLayoutMetrics.headerRowHeight)
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
                #expect(abs(headerFrame.height - MainWindowPageLayoutMetrics.headerRowHeight) < 2)
                if let previousHeader { #expect(headerFrame == previousHeader) }
                previousHeader = headerFrame
                let docked = visible && width >= AdaptiveConversationColumns<Color, Color, EmptyView>.minimumDockedWidth
                let reserved = docked ? AdaptiveConversationColumns<Color, Color, EmptyView>.dockedReservedWidth : 0
                #expect(abs(transcriptFrame.width - (width - reserved)) < 2)
                #expect(!headerFrame.intersects(transcriptFrame.insetBy(dx: 1, dy: 1)))
                if visible && inspector.window === window {
                    let railFrame = inspector.convert(inspector.bounds, to: host)
                    #expect(!headerFrame.intersects(railFrame.insetBy(dx: 1, dy: 1)))
                    #expect(abs(railFrame.height - transcriptFrame.height) < 2)
                    #expect(abs(railFrame.width - ConversationDetailWidgetMetrics.railWidth) < 2)
                    #expect(docked)
                    // A docked rail owns its whole width: it never reaches into
                    // the transcript, so the reading lane has equal blank
                    // gutters on the leading edge and before the rail.
                    #expect(railFrame.minX >= transcriptFrame.maxX - 2,
                        "The rail must not consume the trailing reading gutter")
                    let lane = WorkbenchStyle.lane(viewportWidth: transcriptFrame.width)
                    let leadingGutter = lane.minX
                    let trailingGutter = railFrame.minX
                        - (transcriptFrame.minX + lane.maxX)
                    #expect(abs(leadingGutter - trailingGutter) < 2,
                        "Messages stay centred between the window edge and the rail")
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
                ? AdaptiveConversationColumns<Color, Color, EmptyView>.dockedReservedWidth : 0
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
            // Let the rail's hide transition finish before asserting it is gone.
            try await Task.sleep(for: .milliseconds(280))
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
    func toggleMouseDownCannotDismissBeforeItsMouseUpAction() async throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        let region = DetailOutsideClickView(frame: NSRect(x: 500, y: 0, width: 324, height: 500))
        let toggle = NSView(frame: NSRect(x: 50, y: 550, width: 28, height: 28))
        root.addSubview(region); root.addSubview(toggle)
        window.contentView = root
        defer { region.update(enabled: false, dismiss: {}); window.contentView = nil }
        let exclusion = DetailToggleExclusion()
        exclusion.view = toggle
        region.toggleExclusion = exclusion
        var visible = true
        for _ in 0..<3 {
            visible = true
            region.update(enabled: true) { visible = false }
            let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown,
                location: NSPoint(x: 60, y: 560), modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            region.observe(down)
            // Reproduce holding the button long enough for queued work to run.
            try await Task.sleep(for: .milliseconds(25))
            #expect(visible, "The outside monitor must not close Detail during the toggle press")
            visible.toggle() // The button's release action.
            try await Task.sleep(for: .milliseconds(25))
            #expect(!visible, "Releasing the toggle must close Detail rather than reopen it")
            region.update(enabled: false, dismiss: {})
        }
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

    @MainActor @Test
    func railHidesAsSoonAsTheTextLaneWouldStartShrinking() {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        // 760 (text) + 40 (two gutters) + 324 (full rail) = 1124. The rail
        // owns its whole width, so the lane centres in the space left over.
        #expect(WorkbenchStyle.readingInset == 20,
            "Narrowest gutter on either side of the text lane")
        #expect(Columns.dockedReservedWidth == ConversationDetailWidgetMetrics.railWidth,
            "Docking reserves the entire card width, not a partial overlap")
        #expect(Columns.minimumDockedWidth == WorkbenchStyle.readingWidth
            + 2 * WorkbenchStyle.readingInset + Columns.dockedReservedWidth)
        let threshold = Columns.minimumDockedWidth
        let laneAtThreshold = WorkbenchStyle.lane(viewportWidth: threshold - Columns.dockedReservedWidth)
        #expect(laneAtThreshold.width == WorkbenchStyle.readingWidth)
        let onePointNarrower = WorkbenchStyle.lane(
            viewportWidth: threshold - 1 - Columns.dockedReservedWidth)
        #expect(onePointNarrower.width < WorkbenchStyle.readingWidth,
            "One point past the threshold the text starts shrinking, so Detail must hide here")
        let railLeading = threshold - ConversationDetailWidgetMetrics.railWidth
        #expect(railLeading >= laneAtThreshold.maxX,
            "The rail starts outside the transcript, never over the text")
        #expect(abs(laneAtThreshold.minX - WorkbenchStyle.readingInset) < 1,
            "Leading gutter keeps its full width")
        #expect(abs((railLeading - laneAtThreshold.maxX) - WorkbenchStyle.readingInset) < 1,
            "Trailing gutter equals the leading one: messages are symmetric")
        for width: CGFloat in [threshold, 1200, 1400] {
            let lane = WorkbenchStyle.lane(viewportWidth: width - Columns.dockedReservedWidth)
            #expect(lane.width == WorkbenchStyle.readingWidth,
                "Docking must never shrink the text lane")
            let leading = lane.minX
            let trailing = (width - Columns.dockedReservedWidth) - lane.maxX
            #expect(abs(leading - trailing) < 1,
                "Both gutters grow symmetrically as the window widens")
        }
    }

    @MainActor @Test
    func detailHidesRightBelowTheTextLaneThreshold() async throws {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        let transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
            NativeProbe(view: transcript)
        } detail: {
            NativeProbe(view: inspector)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        #expect(inspector.window === window)
        #expect(abs(transcript.frame.width - (1200 - Columns.dockedReservedWidth)) < 2)
        let narrow = Columns.minimumDockedWidth - 1
        window.setContentSize(NSSize(width: narrow, height: 600))
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(350))
        host.layoutSubtreeIfNeeded()
        #expect(inspector.window == nil, "The text lane starts shrinking here, so Detail must be hidden")
        #expect(abs(transcript.frame.width - narrow) < 2)
    }

    @MainActor @Test
    func detailHideSlidesOutInsteadOfFadingOrDisappearingInOneFrame() async throws {
        // Reduce Motion intentionally skips the slide, so there is nothing to hold.
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        #expect(Columns.railSlideDuration > 0)
        let transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
            NativeProbe(view: transcript)
        } detail: {
            NativeProbe(view: inspector)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1300, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        // A layer animation only gets a presentation value once its window is
        // on screen. Off-screen windows keep the model value at every sample.
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.contentView = nil }
        func railPosition() throws -> any DetailRailSlidePositioning {
            var node: NSView? = inspector
            while let current = node {
                if let positioned = current as? any DetailRailSlidePositioning { return positioned }
                node = current.superview
            }
            throw TestError.railHostNotFound
        }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        #expect(inspector.window === window)
        let visibleRail = try railPosition()
        #expect(visibleRail.slideOffset == 0)
        #expect(visibleRail.railAlphaValue == 1)
        #expect(visibleRail.modelFrameIsStable)
        let narrow = Columns.minimumDockedWidth - 1
        window.setContentSize(NSSize(width: narrow, height: 600))
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(60))
        host.layoutSubtreeIfNeeded()
        #expect(abs(transcript.frame.width - narrow) < 2,
            "The transcript column must widen synchronously, without a width animation")
        #expect(inspector.window === window,
            "The rail must slide out over the transition instead of vanishing in one frame")
        let slidingRail = try railPosition()
        #expect(slidingRail.hasSlideAnimation,
            "The slide must be a layer animation, not a per-frame constraint write")
        #expect(slidingRail.modelFrameIsStable,
            "The hosting view's model frame must not change during the slide")
        #expect(slidingRail.slideOffset > 0,
            "Hiding moves the rail horizontally out to the right")
        #expect(slidingRail.railAlphaValue == 1,
            "The rail must not fade; opacity stays at full alpha for the whole slide")
        try await Task.sleep(for: .milliseconds(350))
        host.layoutSubtreeIfNeeded()
        #expect(inspector.window == nil)
    }

    @MainActor @Test
    func detailRailPaintsNoColumnCanvasOfItsOwn() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/ConsoleWindowSplitView.swift"),
            encoding: .utf8)
        // Canvas belongs to the message viewport, not the full transcript
        // column (which also contains the transparent shared input dock).
        #expect(!source.contains("WorkbenchStyle.canvas"))
        let conversation = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Conversation/SessionConversationContent.swift"), encoding: .utf8)
        let viewportStart = try #require(conversation.range(of: "private var messageViewport:"))
        let dockStart = try #require(conversation.range(of: "private var inputDock:"))
        #expect(conversation[viewportStart.lowerBound..<dockStart.lowerBound].contains("WorkbenchStyle.canvas"))
        let dockEnd = try #require(conversation.range(of: "private var conversationTopChrome:"))
        #expect(!conversation[dockStart.lowerBound..<dockEnd.lowerBound].contains("WorkbenchStyle.canvas"))
        #expect(!source.contains("ConversationColumnBackground(.inspector)"))
    }

    @MainActor @Test
    func detailCardsStayOpaqueWhileTheirRailIsTransparent() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let packageSources = root.appendingPathComponent(
            "packages/CorptieConversation/Sources/CorptieConversation")
        let inspector = try String(contentsOf: packageSources
            .appendingPathComponent("ConversationInspectorSection.swift"), encoding: .utf8)
        let surface = try String(contentsOf: packageSources
            .appendingPathComponent("ConversationContentSurface.swift"), encoding: .utf8)
        let canvas = try String(contentsOf: packageSources
            .appendingPathComponent("WorkbenchCanvasSurface.swift"), encoding: .utf8)

        // The rail keeps its clear canvas; only the cards become solid.
        #expect(canvas.contains("public static var color: Color { .clear }"))
        #expect(inspector.contains(".background(WorkbenchCanvasSurface.color)"))
        #expect(inspector.contains("isPanel: true, allowsMaterial: false"),
            "Detail module cards must be the panels that opt out of material")
        #expect(ConversationContentSurfacePolicy.isSolidPanel(isPanel: true, isMessage: false, allowsMaterial: false))
        #expect(!ConversationContentSurfacePolicy.isSolidPanel(isPanel: true, isMessage: false, allowsMaterial: true))
        #expect(!ConversationContentSurfacePolicy.isSolidPanel(isPanel: false, isMessage: false, allowsMaterial: false))
        #expect(!ConversationContentSurfacePolicy.isSolidPanel(isPanel: true, isMessage: true, allowsMaterial: false))
        #expect(surface.contains("if solidPanel { shape.fill(base) }"),
            "Each card needs an opaque backing, not a translucent fill")
        #expect(surface.contains("ConversationContentSurfacePolicy.solidPanelTintOpacity"))
        #expect(ConversationContentSurfacePolicy.solidPanelTintOpacity > 0)
        #expect(surface.contains("shape.fill(base.opacity(opaqueUser ? 1 : opacity))"),
            "Non-Detail surfaces keep their existing translucent appearance")
    }

    @MainActor @Test
    func widthBandsHoldTheDockingDecisionInsteadOfFlippingIt() {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        let threshold = Columns.minimumDockedWidth
        #expect(Columns.dockHysteresis > 0)
        #expect(Columns.redockWidth == threshold + Columns.dockHysteresis)
        #expect(Columns.widthBand(for: threshold - 1) == .narrow)
        #expect(Columns.widthBand(for: threshold) == .hysteresis)
        #expect(Columns.widthBand(for: Columns.redockWidth - 1) == .hysteresis)
        #expect(Columns.widthBand(for: Columns.redockWidth) == .wide)
        // The extra width only delays re-docking. Hiding is still immediate.
        #expect(WorkbenchStyle.lane(
            viewportWidth: threshold - 1 - Columns.dockedReservedWidth).width
            < WorkbenchStyle.readingWidth)
    }

    @MainActor @Test
    func initialLayoutDocksInsideResizeHysteresis() async throws {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        for offset: CGFloat in [0, 12, 23] {
            let width = Columns.minimumDockedWidth + offset
            let transcript = NSView(), inspector = NSView()
            let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
                NativeProbe(view: transcript)
            } detail: { NativeProbe(view: inspector) })
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 600),
                styleMask: .borderless, backing: .buffered, defer: false)
            window.contentView = host
            defer { window.contentView = nil }
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(280))
            host.layoutSubtreeIfNeeded()
            #expect(inspector.window === window)
            #expect(abs(transcript.frame.width - (width - Columns.dockedReservedWidth)) < 2,
                "Initial layout must reserve the rail whenever it fits, including at the exact threshold")
        }
    }

    @MainActor @Test
    func explicitOpenRechecksFitAndExplicitCloseSurvivesResize() async throws {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        let preference = Visibility()
        let control = VisibilityControl(), transcript = NSView(), rail = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: Binding(
            get: { preference.isVisible }, set: { preference.isVisible = $0 })) {
                NativeProbe(view: transcript)
            } detail: { NativeProbe(view: rail) } header: { VisibilityProbe(control: control) })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func settle() async throws {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(280))
            host.layoutSubtreeIfNeeded()
        }
        try await settle()
        let open = try #require(control.value)
        open.wrappedValue = true
        try await settle()
        #expect(rail.window === window)
        #expect(abs(transcript.frame.width - 900) < 2, "An actually narrow window still uses an overlay")

        let width = Columns.minimumDockedWidth + 12
        window.setContentSize(NSSize(width: width, height: 600))
        try await settle()
        #expect(abs(transcript.frame.width - width) < 2, "Passive resizing keeps hysteresis")
        control.value?.wrappedValue = true
        try await settle()
        #expect(abs(transcript.frame.width - (width - Columns.dockedReservedWidth)) < 2,
            "An explicit open must dock even when the overlay was already visible")
        #expect(transcript.window === window)

        window.setContentSize(NSSize(width: 900, height: 600))
        try await settle()
        control.value?.wrappedValue = true
        try await settle()
        control.value?.wrappedValue = false
        try await settle()
        #expect(!preference.isVisible, "Explicit close also clears the wide-window preference")
        window.setContentSize(NSSize(width: Columns.redockWidth + 40, height: 600))
        try await settle()
        #expect(rail.window == nil, "Growing the window must not undo an explicit close")
        #expect(transcript.window === window)
    }

    @MainActor @Test
    func boundaryJitterDoesNotFlickerTheRailOrReflowTheTranscript() async throws {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        let threshold = Columns.minimumDockedWidth
        let transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
            NativeProbe(view: transcript)
        } detail: {
            NativeProbe(view: inspector)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1300, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func resize(_ width: CGFloat, settle: Int = 40) async throws {
            window.setContentSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(settle))
            host.layoutSubtreeIfNeeded()
        }

        try await resize(1300, settle: 150)
        #expect(inspector.window === window)
        try await resize(threshold - 1, settle: 320)
        #expect(inspector.window == nil, "Crossing into narrow hides decisively")

        // Jittering on the boundary used to re-dock on every point of change,
        // restarting the slide and jumping the transcript column by a full
        // rail width.
        for width: CGFloat in [threshold + 2, threshold + 11, threshold + 3,
                               Columns.redockWidth - 1, threshold + 1] {
            try await resize(width)
            #expect(inspector.window == nil,
                "The rail must not flash back inside the hysteresis band")
            #expect(abs(transcript.frame.width - width) < 2,
                "The transcript keeps a stable width while the decision is held")
        }

        try await resize(Columns.redockWidth + 20, settle: 320)
        #expect(inspector.window === window, "Only a clearly wide window re-docks")

        for width: CGFloat in [Columns.redockWidth - 2, threshold + 8, threshold + 1] {
            try await resize(width)
            #expect(inspector.window === window,
                "The rail must not hide early inside the hysteresis band")
            #expect(abs(transcript.frame.width - (width - Columns.dockedReservedWidth)) < 2,
                "Docking stays reserved through the band without a per-frame width jump")
        }

        try await resize(threshold - 1, settle: 320)
        #expect(inspector.window == nil, "One point into narrow still hides immediately")
    }

    @MainActor @Test
    func reversingMidSlideResumesFromTheOnScreenPosition() async throws {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        let transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
            NativeProbe(view: transcript)
        } detail: {
            NativeProbe(view: inspector)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1300, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        // A layer animation only gets a presentation value on an on-screen window.
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.contentView = nil }
        func railPosition() throws -> any DetailRailSlidePositioning {
            var node: NSView? = inspector
            while let current = node {
                if let positioned = current as? any DetailRailSlidePositioning { return positioned }
                node = current.superview
            }
            throw TestError.railHostNotFound
        }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        #expect(inspector.window === window)

        window.setContentSize(NSSize(width: Columns.minimumDockedWidth - 1, height: 600))
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(70))
        host.layoutSubtreeIfNeeded()
        let rail = try railPosition()
        let midpoint = rail.slideOffset
        #expect(midpoint > 0 && midpoint < ConversationDetailWidgetMetrics.railWidth,
            "The rail should be partway through its slide")

        window.setContentSize(NSSize(width: Columns.redockWidth + 60, height: 600))
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(30))
        #expect(rail.slideOffset < midpoint + 2,
            "Reversing must continue from the on-screen position, not snap back to the far edge")
        #expect(rail.railAlphaValue == 1)
    }

    private enum TestError: Error { case railHostNotFound }

}
