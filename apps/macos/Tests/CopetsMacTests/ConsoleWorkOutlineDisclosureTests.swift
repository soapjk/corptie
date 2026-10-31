import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class ConsoleWorkOutlineDisclosureTests: XCTestCase {
    private final class State: ObservableObject {
        @Published var expanded = false
    }
    private struct Probe: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }
    private final class GeometryProbe: NSView {
        override var isFlipped: Bool { true }
    }
    @MainActor private final class Lifetime {
        let view = GeometryProbe()
        var created = 0
        var removed = 0
    }
    private struct LifetimeProbe: NSViewRepresentable {
        let lifetime: Lifetime
        func makeCoordinator() -> Lifetime { lifetime }
        func makeNSView(context: Context) -> NSView { lifetime.created += 1; return lifetime.view }
        func updateNSView(_ nsView: NSView, context: Context) {}
        static func dismantleNSView(_ nsView: NSView, coordinator: Lifetime) { coordinator.removed += 1 }
    }
    private struct Surface: View {
        @ObservedObject var state: State
        let probe: NSView
        let lifetime: Lifetime
        var body: some View {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    DisclosureGroup(isExpanded: $state.expanded) {
                        VStack(spacing: 2) {
                            ForEach(0..<6) { index in Text("Task \(index)").frame(height: 22) }
                        }
                        .background(LifetimeProbe(lifetime: lifetime))
                    } label: { Text("Work") }
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                    .background(Probe(view: probe))
                    Text("Next Work")
                }
            }
        }
    }
    private func settle(_ duration: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(duration))
    }

    func testExpandedAndCollapsedGroupHeightsHaveIntermediateFrames() throws {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        let collapsed = probe.frame.height
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) { state.expanded = true }
        settle(0.05)
        let expanding = probe.frame.height
        let enteringTop = probe.convert(lifetime.view.bounds, from: lifetime.view).minY
        settle(0.25)
        let expanded = probe.frame.height
        let settledTop = probe.convert(lifetime.view.bounds, from: lifetime.view).minY
        XCTAssertLessThan(enteringTop, settledTop - 1, "Rows must slide down from the Work title edge")
        XCTAssertGreaterThan(expanded, collapsed + 100)
        XCTAssertGreaterThan(expanding, collapsed + 1)
        XCTAssertLessThan(expanding, expanded - 1)
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) { state.expanded = false }
        settle(0.05)
        let collapsing = probe.frame.height
        // Native child model frames need not follow the removal presentation;
        // verify the collapsing container and eventual native-view release.
        XCTAssertGreaterThan(collapsing, collapsed + 1)
        XCTAssertLessThan(collapsing, expanded - 1)
        settle(0.25)
        XCTAssertEqual(probe.frame.height, collapsed, accuracy: 1)
        XCTAssertEqual(lifetime.created, 1, "Animation must not recreate the child host each frame")
        XCTAssertEqual(lifetime.removed, 1, "Collapsed content must release its native views")
    }
}
