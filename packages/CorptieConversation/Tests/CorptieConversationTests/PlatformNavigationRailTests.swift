#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import CorptieConversation

@MainActor
@Suite(.serialized)
struct PlatformNavigationRailTests {
    @Test func workToolbarFeedbackPreservesRepeatedActionsAndFixedLayout() throws {
        let driver = TabRailDriver()
        let window = tabTestWindow(WorkToolbarHarness(driver: driver), width: 220)
        defer { window.orderOut(nil); window.contentView = nil }
        let host = try #require(window.contentView)
        pumpTabs(0.08)
        let bounds = host.bounds
        var layers = 0
        var timings: [Double] = []
        for round in 0..<3 {
            for index in 0..<5 {
                let point = NSPoint(x: 10 + 18 + CGFloat(index) * 41,
                                    y: host.isFlipped ? 22 : host.bounds.height - 22)
                let started = ProcessInfo.processInfo.systemUptime
                try clickControl(at: point, host: host, window: window)
                pumpTabs(0.02)
                #expect(driver.activations[String(index)] == round + 1)
                #expect(host.bounds == bounds)
                if round > 0 { timings.append((driver.lastActivationTime - started) * 1_000) }
            }
            pumpTabs(0.8)
            if round == 0 { layers = tabLayerCount(host.layer) }
        }
        let finalLayers = tabLayerCount(host.layer)
        #expect(finalLayers <= layers + 8)
        let sorted = timings.sorted()
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        #expect(sorted.first ?? -1 >= 0)
        #expect(p95 < 16.7)
        print("WORK_TOOLBAR_PERF samples=\(sorted.count) activation_p95_ms=\(p95) warm_layers=\(layers) final_layers=\(finalLayers)")
    }

    @Test func macOSSelectionHasNoGlassBackdropEvenWhileMoving() throws {
        for moving in [false, true] {
            let window = tabTestWindow(FlatSelectionProbe(moving: moving))
            defer { window.close() }
            pumpTabs(0.05)
            let layer = try #require(window.contentView?.layer)
            func containsBackdrop(_ layer: CALayer) -> Bool {
                String(describing: type(of: layer)).contains("BackdropLayer")
                    || (layer.sublayers ?? []).contains(where: containsBackdrop)
            }
            #expect(!containsBackdrop(layer), "macOS selection must remain flat during and after travel")
        }
    }

    @Test func interruptedTravelSettlesOnlyTheLatestSelection() {
        let driver = TabRailDriver()
        let window = tabTestWindow(TabSelectionProbe(driver: driver))
        defer { window.close() }
        pumpTabs(0.05)
        driver.selection = "b"
        pumpTabs(0.13)
        #expect(driver.displayedID == "b")
        #expect(!driver.moving, "macOS must not enter the mobile glass phase")
        driver.selection = "c"
        pumpTabs(0.10)
        #expect(driver.displayedID == "c")
        #expect(!driver.moving, "Interrupted travel must keep the macOS indicator flat")
        pumpTabs(0.30)
        #expect(driver.displayedID == "c")
        #expect(!driver.moving)
    }

    @Test func selectionRespectsSystemAccessibilityPreferences() {
        let driver = TabRailDriver()
        let window = tabTestWindow(TabSelectionProbe(driver: driver))
        defer { window.close() }
        pumpTabs(0.04)
        driver.selection = "b"
        pumpTabs(0.04)
        #expect(driver.displayedID == "b")
        #expect(!driver.moving)
        pumpTabs(0.30)
        #expect(!driver.moving)
        driver.selection = "c"
        pumpTabs(0.04)
        #expect(driver.displayedID == "c")
        #expect(!driver.moving)
        pumpTabs(0.30)
        #expect(!driver.moving)
    }

    @Test func everyTabAndSettingsCanBeActivatedRepeatedlyWithoutLayoutOrLayerGrowth() throws {
        let driver = TabRailDriver()
        let window = tabTestWindow(TabRailHarness(driver: driver))
        // Release the hosted graph and hide the test-owned window without
        // dispatching application-level close events from the gesture test.
        defer { window.orderOut(nil); window.contentView = nil }
        let host = try #require(window.contentView)
        pumpTabs(0.08)
        let bounds = host.bounds
        var timings: [Double] = []
        var warmLayerCount = 0
        for round in 0..<3 {
            for (index, id) in ["a", "b", "c", "settings"].enumerated() {
                let started = ProcessInfo.processInfo.systemUptime
                try clickTab(index, host: host, window: window)
                pumpTabs(0.02)
                if round > 0 { timings.append((driver.lastActivationTime - started) * 1_000) }
                // Re-selecting the same tab must still execute its activation.
                let repeated = ProcessInfo.processInfo.systemUptime
                try clickTab(index, host: host, window: window)
                pumpTabs(0.02)
                if round > 0 { timings.append((driver.lastActivationTime - repeated) * 1_000) }
                host.layoutSubtreeIfNeeded()
                #expect(driver.selection == id)
                #expect(host.bounds == bounds)
            }
            pumpTabs(0.45)
            if round == 0 { warmLayerCount = tabLayerCount(host.layer) }
        }
        for id in ["a", "b", "c", "settings"] { #expect(driver.activations[id] == 6) }
        let finalLayers = tabLayerCount(host.layer)
        #expect(finalLayers <= warmLayerCount + 8, "Settled transitions must release temporary rendering layers")
        let sorted = timings.sorted()
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        print("TAB_RAIL_PERF samples=\(sorted.count) activation_p95_ms=\(p95) warm_layers=\(warmLayerCount) final_layers=\(finalLayers)")
        #expect(sorted.first ?? -1 >= 0)
        #expect(p95 < 16.7, "Warm tab activations should fit a 60 Hz frame budget")
    }
}

private struct WorkToolbarHarness: View {
    @ObservedObject var driver: TabRailDriver
    var body: some View {
        PlatformWorkOutlineToolbar(density: .compact) {
            ForEach(0..<4) { index in
                toolbarButton(index)
            }
        } trailing: { toolbarButton(4) }
        .frame(width: 220, height: 44)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    private func toolbarButton(_ index: Int) -> some View {
        Button { driver.activate(String(index)) } label: {
            PlatformWorkOutlineToolbarGlyph(symbol: "star", selected: driver.selection == String(index))
        }
        .platformWorkOutlineToolbarControl()
    }
}

private struct FlatSelectionProbe: View {
    @Namespace private var selection
    let moving: Bool
    var body: some View {
        PlatformTabSelectionIndicator(namespace: selection, moving: moving)
            .frame(width: 44, height: 44)
    }
}

@MainActor private final class TabRailDriver: ObservableObject {
    @Published var selection = "a"
    var displayedID = "a"
    var moving = false
    var activations: [String: Int] = [:]
    var lastActivationTime: TimeInterval = 0

    func activate(_ id: String) {
        lastActivationTime = ProcessInfo.processInfo.systemUptime
        activations[id, default: 0] += 1
        selection = id
    }
}

private struct TabRailHarness: View {
    @ObservedObject var driver: TabRailDriver
    var body: some View {
        PlatformNavigationRail(items: ["a", "b", "c"].map {
            PlatformNavigationItem(id: $0, title: $0, symbol: "star", accessibilityID: "test-tab-\($0)")
        }, selectedID: driver.selection, expanded: false,
        settingsSelected: driver.selection == "settings", settingsTitle: "Settings",
        settingsAccessibilityID: "test-tab-settings", onSelect: { driver.activate($0) },
        onSettings: { driver.activate("settings") })
        .frame(width: 54)
    }
}

private struct TabSelectionProbe: View {
    @Namespace private var selection
    @ObservedObject var driver: TabRailDriver
    var body: some View {
        PlatformAnimatedTabSelection(selectedID: driver.selection) { id, moving in
            VStack {
                ForEach(["a", "b", "c"], id: \.self) { item in
                    Color.clear.frame(width: 44, height: 44).background {
                        if id == item { PlatformTabSelectionIndicator(namespace: selection, moving: moving) }
                    }
                }
            }
            .background(TabSelectionCapture(driver: driver, id: id, moving: moving))
        }
    }
}

private struct TabSelectionCapture: NSViewRepresentable {
    let driver: TabRailDriver
    let id: String
    let moving: Bool
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        driver.displayedID = id
        driver.moving = moving
    }
}

@MainActor private func tabTestWindow<V: View>(_ view: V, width: CGFloat = 160) -> NSWindow {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 320),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: view)
    window.makeKeyAndOrderFront(nil)
    window.contentView?.layoutSubtreeIfNeeded()
    return window
}

@MainActor private func pumpTabs(_ seconds: TimeInterval) {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: seconds))
}

@MainActor private func clickTab(_ index: Int, host: NSView, window: NSWindow) throws {
    // Exercise the real SwiftUI Button gesture in this test-owned window. The
    // system accessibility tree is lazy when no accessibility client is attached.
    let fromTop: CGFloat = index < 3 ? 27 + CGFloat(index) * 46 : 176
    let point = NSPoint(x: host.bounds.midX, y: host.isFlipped ? fromTop : host.bounds.height - fromTop)
    try clickControl(at: point, host: host, window: window)
}

@MainActor private func clickControl(at point: NSPoint, host: NSView, window: NSWindow) throws {
    let location = host.convert(point, to: nil)
    let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: location,
        modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
        context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    let up = try #require(NSEvent.mouseEvent(with: .leftMouseUp, location: location,
        modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
        context: nil, eventNumber: 2, clickCount: 1, pressure: 0))
    window.sendEvent(down)
    window.sendEvent(up)
}

@MainActor private func tabLayerCount(_ layer: CALayer?) -> Int {
    guard let layer else { return 0 }
    return 1 + (layer.sublayers ?? []).reduce(0) { $0 + tabLayerCount($1) }
}
#endif
