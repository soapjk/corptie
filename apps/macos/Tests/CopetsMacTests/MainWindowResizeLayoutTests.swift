import SwiftUI
import Testing
import XCTest
@testable import CorptieMac

struct MainWindowResizeLayoutTests {
    @Test
    func mainWindowTopEdgeDoubleClickTogglesZoom() {
        #expect(MainWindowTitlebarZoomPolicy.shouldToggleZoom(
            clickCount: 2,
            locationY: 758,
            contentHeight: 760
        ))
        #expect(MainWindowTitlebarZoomPolicy.shouldToggleZoom(
            clickCount: 2,
            locationY: 748,
            contentHeight: 760
        ))
    }

    @Test
    func titlebarZoomPolicyIgnoresSingleClicksAndPageContent() {
        #expect(!MainWindowTitlebarZoomPolicy.shouldToggleZoom(
            clickCount: 1,
            locationY: 758,
            contentHeight: 760
        ))
        #expect(!MainWindowTitlebarZoomPolicy.shouldToggleZoom(
            clickCount: 2,
            locationY: 747,
            contentHeight: 760
        ))
        #expect(!MainWindowTitlebarZoomPolicy.shouldToggleZoom(
            clickCount: 2,
            locationY: 0,
            contentHeight: 0
        ))
    }

    @Test
    func mainTabLayoutContractKeepsEveryPageResidentWithoutGeometryReader() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("MainTabPageLayout(selectedIndex: router.selectedTab.index)"))
        #expect(contents.contains("ForEach(AppTab.allCases)"))
        #expect(contents.contains("subviews[selectedIndex].place("))
        #expect(!contents.contains("for (index, subview) in subviews.enumerated()"))
        #expect(!contents.contains("GeometryReader { geo in"))
        #expect(!contents.contains(".frame(width: geo.size.width, height: geo.size.height)"))
        #expect(AppTab.allCases.contains(.automations))
        #expect(contents.contains("case .automations:"))
        #expect(contents.contains("AutomationsView()"))
    }

    @Test
    func automationsTabExposesCategoriesRiskRoutingHistoryAndManagementControls() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/AutomationsView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        for required in [
            "case all", "case running", "case failed", "case history",
            "Trigger", "Next Run", "Last Result", "Risk", "Run History",
            "bindingId", "routingVersion", "Run Now", "Pause", "Resume", "Cancel"
        ] {
            #expect(contents.contains(required))
        }
    }

    @Test
    func splitViewColumnLimitsDoNotChangeForEveryAnimatedWindowWidth() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")

        for fileName in ["WarRoomView.swift", "SessionsView.swift"] {
            let contents = try String(
                contentsOf: sourceRoot.appendingPathComponent(fileName),
                encoding: .utf8
            )
            #expect(contents.contains("max: TwoPaneLayoutMetrics.sidebarMaximumWidth"))
            #expect(!contents.contains("w * 0.34"))
        }
    }
}

@MainActor
final class MainWindowTitlebarDispatchTests: XCTestCase {
    // AppKit fixtures are retained through bundle teardown for the same reason
    // as ApplicationTerminationUITests: Objective-C invalid-object checking can
    // otherwise over-release a window after Swift Testing's autorelease pool.
    private static var retainedWindows: [NSWindow] = []

    func testTopEdgeDoubleClickDispatchesAppKitZoomAndRestore() throws {
        _ = NSApplication.shared
        let window = MainWindow(
            contentRect: NSRect(x: 200, y: 200, width: 900, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.animationBehavior = .none
        Self.retainedWindows.append(window)
        window.makeKeyAndOrderFront(nil)

        func doubleClick(eventNumber: Int) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: NSPoint(
                    x: window.contentView?.bounds.midX ?? 450,
                    y: (window.contentView?.bounds.maxY ?? 600) - 4
                ),
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: eventNumber,
                clickCount: 2,
                pressure: 1
            ))
        }

        XCTAssertFalse(window.isZoomed)
        window.sendEvent(try doubleClick(eventNumber: 1))
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        XCTAssertTrue(window.isZoomed)

        window.sendEvent(try doubleClick(eventNumber: 2))
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        XCTAssertFalse(window.isZoomed)
        window.orderOut(nil)
    }
}
