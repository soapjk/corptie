import AppKit
import SwiftUI
import Testing
import CorptieConversation
@testable import CorptieMac

@MainActor @Suite(.serialized)
struct DetailRailBackdropGeometryTests {
    final class Visibility: ObservableObject { @Published var value = true }
    private struct Probe: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ view: NSView, context: Context) {}
    }
    private struct Harness: View {
        @ObservedObject var visibility: Visibility
        let transcript: NSView
        let inspector: NSView
        var body: some View {
            AdaptiveConversationColumns(isVisible: $visibility.value) {
                Probe(view: transcript)
            } detail: {
                Probe(view: inspector)
            }
        }
    }
    private func descendants<T>(_ view: NSView, as type: T.Type) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { descendants($0, as: type) }
    }

    @Test func exposedFadePreservesViewportAndPassesThroughMessageGestures() async throws {
        typealias Columns = AdaptiveConversationColumns<Color, Color, EmptyView>
        let visibility = Visibility(), transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: Harness(visibility: visibility, transcript: transcript, inspector: inspector))
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 1400, height: 600),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.contentView = nil; window.close() }
        func settle() async throws {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(350))
            host.layoutSubtreeIfNeeded()
        }
        #expect(DetailRailGeometry.leadingBackdropExtension == 32 - 12)
        #expect(DetailRailGeometry.leadingBackdropExtension <= WorkbenchStyle.readingInset)
        for width in [1400, Columns.minimumDockedWidth, 900, Columns.redockWidth] {
            window.setContentSize(CGSize(width: width, height: 600))
            try await settle()
            let backgrounds = descendants(host, as: DetailRailBackdropView.self)
            let transcriptFrame = transcript.convert(transcript.bounds, to: host)
            if width == 900 {
                #expect(backgrounds.isEmpty)
                #expect(abs(transcriptFrame.width - width) < 1)
                continue
            }
            let background = try #require(backgrounds.first)
            #expect(backgrounds.count == 1)
            let backdropFrame = background.convert(background.bounds, to: host)
            let inspectorFrame = inspector.convert(inspector.bounds, to: host)
            #expect(abs(inspectorFrame.width - ConversationDetailWidgetMetrics.railWidth) < 1)
            #expect(abs(transcriptFrame.width - (width - Columns.dockedReservedWidth)) < 1)
            #expect(abs(backdropFrame.width - DetailRailGeometry.viewportWidth) < 1)
            #expect(abs(backdropFrame.maxX - width) < 1)
            #expect(abs(inspectorFrame.minX - backdropFrame.minX - 20) < 1)
            let lane = WorkbenchStyle.lane(viewportWidth: transcriptFrame.width)
            #expect(backdropFrame.minX >= transcriptFrame.minX + lane.maxX - 1)
            let mask = try #require(background.layer?.mask as? CAGradientLayer)
            #expect(abs(try #require(mask.locations?[1]).doubleValue * backdropFrame.width - 32) < 1)
            let shell = try #require(descendants(host, as: NSView.self).first { $0 is any DetailRailSlidePositioning })
            let feather = shell.convert(CGPoint(x: 10, y: shell.bounds.midY), to: shell.superview)
            #expect(shell.hitTest(feather) == nil)
            let card = shell.convert(CGPoint(x: 100, y: shell.bounds.midY), to: shell.superview)
            #expect(shell.hitTest(card) != nil)
            print("DETAIL_BACKDROP width=\(width) transcript=\(transcriptFrame.width) rail=\(inspectorFrame.width) backdrop=\(backdropFrame.width) exposed=\(inspectorFrame.minX - backdropFrame.minX + 12)")
        }
        let shell = try #require(descendants(host, as: NSView.self).first { $0 is any DetailRailSlidePositioning })
        visibility.value = false
        try await settle()
        #expect(descendants(host, as: DetailRailBackdropView.self).isEmpty)
        #expect(shell.isHidden)
        #expect(shell.hitTest(shell.convert(CGPoint(x: 100, y: 30), to: shell.superview)) == nil)
        #expect(abs(try #require(shell.subviews.first?.layer).transform.m41 - DetailRailGeometry.viewportWidth) < 1)
    }
}
