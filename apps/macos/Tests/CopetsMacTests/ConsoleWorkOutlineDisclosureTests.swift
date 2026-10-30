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
    private final class Lifetime {
        var created = 0
        var removed = 0
    }
    private struct LifetimeProbe: NSViewRepresentable {
        let lifetime: Lifetime
        func makeCoordinator() -> Lifetime { lifetime }
        func makeNSView(context: Context) -> NSView { lifetime.created += 1; return NSView() }
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
        let state = State(), probe = NSView(), lifetime = Lifetime()
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
        settle(0.25)
        let expanded = probe.frame.height
        XCTAssertGreaterThan(expanded, collapsed + 100)
        XCTAssertGreaterThan(expanding, collapsed + 1)
        XCTAssertLessThan(expanding, expanded - 1)
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) { state.expanded = false }
        settle(0.05)
        let collapsing = probe.frame.height
        XCTAssertGreaterThan(collapsing, collapsed + 1)
        XCTAssertLessThan(collapsing, expanded - 1)
        settle(0.25)
        XCTAssertEqual(probe.frame.height, collapsed, accuracy: 1)
        XCTAssertEqual(lifetime.created, 1, "Animation must not recreate the child host each frame")
        XCTAssertEqual(lifetime.removed, 1, "Collapsed content must release its native views")
    }
}
