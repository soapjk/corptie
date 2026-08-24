import SwiftUI
import Testing
import XCTest
@testable import CorptieMac

struct MainWindowResizeLayoutTests {
    @MainActor
    @Test
    func rapidLiveResizeCoalescesLayoutAndFinishesAtExactSize() {
        let resizeState = MainWindowResizeState()
        let view = LiveResizeHostingView(
            rootView: Text("Undistorted"),
            resizeState: resizeState
        )
        view.frame = NSRect(x: 0, y: 0, width: 980, height: 620)
        view.layoutSubtreeIfNeeded()
        let eventsBeforeResize = view.layoutStatistics.sizeChangeEvents
        let exactLayoutsBeforeResize = view.layoutStatistics.exactLayouts

        view.viewWillStartLiveResize()
        #expect(resizeState.isLiveResize)
        for index in 0..<180 {
            let direction: CGFloat = index.isMultiple(of: 2) ? 1 : -1
            view.frame.size = NSSize(
                width: 1_100 + direction * CGFloat(index % 90),
                height: 700 + direction * CGFloat(index % 50)
            )
            view.layoutSubtreeIfNeeded()
        }
        view.viewDidEndLiveResize()

        #expect(view.layoutStatistics.sizeChangeEvents - eventsBeforeResize == 180)
        #expect(view.layoutStatistics.layoutCommits < 180)
        #expect(view.layoutStatistics.coalescedEvents > 0)
        #expect(view.layoutStatistics.exactLayouts == exactLayoutsBeforeResize + 1)
        #expect(view.renderedContentSize == view.bounds.size)
        #expect(view.contentUsesIdentityTransform)
        #expect(!resizeState.isLiveResize)
    }

    @MainActor
    @Test
    func resizeStabilityDebouncePerformsExactLayoutBeforeDragEnds() async throws {
        let resizeState = MainWindowResizeState()
        let view = LiveResizeHostingView(
            rootView: Image(systemName: "rectangle"),
            resizeState: resizeState
        )
        view.frame = NSRect(x: 0, y: 0, width: 980, height: 620)
        view.layoutSubtreeIfNeeded()
        view.viewWillStartLiveResize()
        view.frame.size = NSSize(width: 1_240, height: 760)
        view.layoutSubtreeIfNeeded()
        let exactLayoutsBeforeStability = view.layoutStatistics.exactLayouts

        try await Task.sleep(for: .milliseconds(180))

        #expect(view.layoutStatistics.exactLayouts == exactLayoutsBeforeStability + 1)
        #expect(view.renderedContentSize == view.bounds.size)
        #expect(view.contentUsesIdentityTransform)
        view.viewDidEndLiveResize()
    }

    @MainActor
    @Test
    func inactiveTabHostsStayHiddenAndRetainStateWithoutReceivingResizeFrames() throws {
        var created: [AppTab: NSView] = [:]
        let container = MainTabPageContainer(animationDuration: 0) { tab in
            let page = NSView(frame: .zero)
            created[tab] = page
            return page
        }
        container.frame = NSRect(x: 0, y: 0, width: 1_200, height: 700)
        container.select(.console)
        container.layoutSubtreeIfNeeded()
        container.select(.sessions)
        container.layoutSubtreeIfNeeded()
        let detachedConsoleFrame = try #require(created[.console]?.frame)

        container.frame.size = NSSize(width: 1_450, height: 860)
        container.layoutSubtreeIfNeeded()

        #expect(container.cachedPageCount == 2)
        #expect(container.attachedPageCount == 2)
        #expect(container.visibleTabs == [.sessions])
        #expect(created[.console]?.frame == detachedConsoleFrame)
        #expect(created[.sessions]?.frame == container.bounds)
        #expect(created[.console]?.superview === container)
        #expect(created[.console]?.isHidden == true)
        #expect(created[.sessions]?.superview === container)
    }

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
    func mainTabLayoutContractRetainsButHidesInactivePages() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("private var pages: [AppTab: NSView] = [:]"))
        #expect(contents.contains("private var participatingTabs: Set<AppTab>"))
        #expect(contents.contains("pages[tab] = created"))
        #expect(contents.contains("page.frame = bounds"))
        #expect(contents.contains("addSubview(page)"))
        #expect(contents.contains("page.isHidden = !participates"))
        #expect(contents.contains("transform.translation.x"))
        #expect(contents.contains("page.setAccessibilityHidden(tab != selectedTab)"))
        #expect(!contents.contains("MainTabPageLayout"))
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
            "Trigger", "创建时间", "上次执行时间", "预计下次执行时间", "过期时间", "Times use system time zone: %@",
            "生效中", "已取消", "已完成", "已过期", "异常", "Last Result", "Risk", "Run History",
            "bindingId", "routingVersion", "Run Now", "Retry", "Cancel"
        ] {
            #expect(contents.contains(required))
        }
        #expect(contents.contains("if automation.scheduleType != .condition"))
        #expect(contents.contains("ScheduledSessionManagementTimeFormatting.string"))
        let emptyStateStart = try #require(contents.range(of: "ContentUnavailableView("))
        let emptyStateEnd = try #require(contents.range(of: "} else {", range: emptyStateStart.upperBound..<contents.endIndex))
        let emptyState = contents[emptyStateStart.lowerBound..<emptyStateEnd.lowerBound]
        #expect(emptyState.contains(".frame(maxWidth: .infinity, maxHeight: .infinity)"))
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
        let resizeState = MainWindowResizeState()
        let hostingView = LiveResizeHostingView(
            rootView: Text("Zoom contract"),
            resizeState: resizeState
        )
        window.contentView = hostingView
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
        XCTAssertEqual(hostingView.renderedContentSize, hostingView.bounds.size)
        XCTAssertTrue(hostingView.contentUsesIdentityTransform)

        window.sendEvent(try doubleClick(eventNumber: 2))
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        XCTAssertFalse(window.isZoomed)
        XCTAssertEqual(hostingView.renderedContentSize, hostingView.bounds.size)
        XCTAssertTrue(hostingView.contentUsesIdentityTransform)
        window.orderOut(nil)
    }
}
