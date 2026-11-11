import Foundation
import SwiftUI
import Testing
import XCTest
@testable import CorptieMac

@Suite(.serialized)
struct MainWindowResizeLayoutTests {
    @Test
    func liveResizeKeepsMessageReflowNativeAndOnlyHoldsTheSidebarPane() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let runtime = try String(contentsOf: root.appendingPathComponent("Application/MainWindowRuntime.swift"), encoding: .utf8)
        let split = try String(contentsOf: root.appendingPathComponent("ConsoleWindowSplitView.swift"), encoding: .utf8)

        // WINDOW level: the whole hosting view must keep following every native
        // size. Freezing it would stop the transcript from receiving new widths,
        // so message text and the composer could no longer re-wrap on a drag.
        #expect(!runtime.contains("bitmapImageRepForCachingDisplay"))
        #expect(!runtime.contains("scaleAxesIndependently"))
        #expect(runtime.contains("hostingView.autoresizingMask = [.width, .height]"))
        // PANE level: only the width-stable sidebar/worker/cards column is
        // held. Its UI does not change during a window resize, so the correct
        // fix is to keep AppKit from handing SwiftUI a new size proposal —
        // never to rasterise it. A bitmap can go blank for layer-backed hosts
        // and hiding the host drops hit testing for the whole gesture.
        #expect(!split.contains("cacheDisplay"))
        #expect(!split.contains("bitmapImageRepForCachingDisplay"))
        #expect(!split.contains("NSImageView"))
        #expect(!split.contains("host.view.isHidden = true"))
        #expect(!split.contains("layerContentsRedrawPolicy"))
        // Never detach all four edges: a frame pinned at (0,0,w,h) is anchored
        // at the BOTTOM in AppKit's bottom-left origin, so a shorter window
        // crops the sidebar's top. The top must stay pinned and only the
        // bottom edge may be released, so height changes collapse upward from
        // the bottom instead of pulling content off the top.
        #expect(!split.contains("host.view.frame = frame"))
        #expect(!split.contains("host.view.autoresizingMask = []"))
        #expect(split.contains("host.view.topAnchor.constraint(equalTo: view.topAnchor)"))
        #expect(split.contains("host.view.heightAnchor.constraint(equalToConstant: height)"))
        #expect(split.contains("NSLayoutConstraint.deactivate([bottomConstraint])"))
        #expect(split.contains("NSLayoutConstraint.activate([bottomConstraint])"))
        #expect(split.contains("sidebarController.freezeForLiveResize()"))
        #expect(!split.contains("detailController.freezeForLiveResize()"))
        #expect(!split.contains("detailController.unfreezeAfterLiveResize()"))
        #expect(split.contains("private var pendingSidebar"))
        #expect(split.contains("NSWindow.willStartLiveResizeNotification"))
        #expect(split.contains("NSWindow.didEndLiveResizeNotification"))
        #expect(split.contains("detailController.host.rootView = detail"))
    }

    /// A 25s main-thread sample of a slow drag showed 80% of frames inside
    /// `NSView._layoutSubtreeWithOldSize` → `_recursiveSetDefaultKeyViewLoop`
    /// → `FocusBridge.updateDefaultKeyViewLoop`. AppKit rebuilds the whole
    /// window's Tab chain on every resize frame; its cost grows with the
    /// hosting views a Session accumulates and never drops back when the turn
    /// stops. The window must opt out of automatic rebuilds, skip any explicit
    /// rebuild during a live resize, and pay for exactly one after it ends.
    @Test
    func mainWindowDefersKeyViewLoopRebuildUntilResizeEnds() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let runtime = try String(contentsOf: root.appendingPathComponent("Application/MainWindowRuntime.swift"), encoding: .utf8)
        #expect(runtime.contains("autorecalculatesKeyViewLoop = false"))
        #expect(runtime.contains("override func recalculateKeyViewLoop()"))
        #expect(runtime.contains("guard !inLiveResize else { return }"))
        #expect(runtime.contains("NSWindow.didEndLiveResizeNotification"))
        #expect(runtime.contains("self?.recalculateKeyViewLoop()"))
    }

    /// AppKit's implicit animations on layout inputs rewrite the model frame or
    /// constraint constant on every frame. Each write re-solves Auto Layout and
    /// hands the hosted SwiftUI tree a new size proposal, so a 0.2s animation
    /// triggers >100 full layout passes. Animate layer opacity or transform
    /// instead: those are compositor-only and never touch layout.
    @Test
    func noClientSourceAnimatesLayoutInputsFrameByFrame() throws {
        let here = URL(fileURLWithPath: #filePath)
        let macos = here.deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let repo = macos.deletingLastPathComponent()
            .deletingLastPathComponent()
        let directories = [
            macos.appendingPathComponent("Sources/CopetsMac"),
            repo.appendingPathComponent("apps/ipad/Sources"),
            repo.appendingPathComponent("packages/CorptieConversation/Sources"),
            repo.appendingPathComponent("packages/CorptieClientCore/Sources")
        ]
        // NSOutlineView's own row animation (`outline.animator()`), alphaValue
        // and zero-duration groups with allowsImplicitAnimation = false are
        // allowed: none of them rewrites a frame or constraint per frame.
        let forbidden = [
            ".animator().constant",
            ".animator().setFrame(",
            ".animator().frame",
            ".animator().setFrameOrigin(",
            ".animator().setFrameSize(",
            "animate: true"
        ]
        var scanned = 0
        for directory in directories {
            guard let enumerator = FileManager.default.enumerator(
                at: directory, includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]) else { continue }
            for case let file as URL in enumerator where file.pathExtension == "swift" {
                let source = try String(contentsOf: file, encoding: .utf8)
                scanned += 1
                for pattern in forbidden {
                    #expect(!source.contains(pattern),
                        "\(file.lastPathComponent) animates a layout input via \(pattern); use a layer opacity/transform animation")
                }
            }
        }
        #expect(scanned > 200, "the guardrail must actually scan the client sources")
    }

    @Test
    func processClockTimerStaysOutOfEventTrackingModes() throws {
        let here = URL(fileURLWithPath: #filePath)
        let macos = here.deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let file = macos.appendingPathComponent(
            "Sources/CopetsMac/Conversation/Timeline/AppKitChatTimelineCoordinator.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        // .common contains NSEventTrackingRunLoopMode: a repeating timer
        // registered there fires on every window drag / live resize frame and
        // dirties the process cell while AppKit composites that same frame.
        #expect(source.contains("RunLoop.main.add(timer, forMode: .default)"))
        #expect(!source.contains("RunLoop.main.add(timer, forMode: .common)"))
        // The elapsed label is a live wall clock: it keeps its own timer so
        // the turn duration advances even when the provider is silent. But it
        // must be a chain of one-shot ticks, not a retained repeating timer
        // that needs an explicit invalidate and can outlive a stopped turn.
        #expect(source.contains("repeats: false"))
        #expect(!source.contains("repeats: true"))
        #expect(source.contains("processClockGeneration"))
    }

    @Test
    func liveElapsedClockKeepsOneSecondCadence() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let file = root.appendingPathComponent(
            "packages/CorptieClientCore/Sources/CorptieClientCore/ConversationProcessDuration.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        // Display precision must match cadence; a sub-second repeating timer
        // on the main thread regresses window drag / live resize frames.
        #expect(source.contains("elapsedRefreshInterval: TimeInterval = 1.0"))
        #expect(!source.contains("1.0 / 100.0"))
        #expect(!source.contains("1.0 / 10.0"))
    }

    @MainActor
    @Test
    func liveResizeFollowsEveryNativeSizeWithoutWaitingForAFrameScheduler() {
        let state = MainWindowResizeState()
        let view = MainWindowSurfaceContainer(rootView: Text("Native layout"), resizeState: state)
        view.frame.size = NSSize(width: 980, height: 620)
        view.viewWillStartLiveResize()
        #expect(state.isLiveResize)
        for index in 0..<180 {
            view.frame.size = NSSize(width: 1_100 + index, height: 700 + index % 50)
            // No RunLoop wait, display-link tick or forced recursive layout.
            #expect(view.renderedContentSize == view.bounds.size)
            #expect(view.presentedContentFrame == view.bounds)
            #expect(view.contentUsesIdentityTransform)
        }
        let finalSize = view.renderedContentSize
        view.viewDidEndLiveResize()
        #expect(!state.isLiveResize)
        #expect(view.renderedContentSize == finalSize)
    }

    @MainActor
    @Test
    func programmaticResizeUsesTheSameImmediateNativeLayout() {
        let state = MainWindowResizeState()
        let view = MainWindowSurfaceContainer(rootView: Image(systemName: "rectangle"), resizeState: state)
        for size in [NSSize(width: 980, height: 620), NSSize(width: 1240, height: 760),
                     NSSize(width: 1000, height: 700)] {
            view.frame.size = size
            #expect(view.renderedContentSize == size)
            #expect(view.contentUsesIdentityTransform)
            #expect(!state.isLiveResize)
        }
    }

    @MainActor
    @Test
    func overlappingNativeResizeNotificationsOnlyControlAnimationSuppression() {
        _ = NSApplication.shared
        let state = MainWindowResizeState()
        let view = MainWindowSurfaceContainer(rootView: Text("Native transitions"), resizeState: state)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        NotificationCenter.default.post(name: NSWindow.willEnterFullScreenNotification, object: window)
        #expect(state.isLiveResize)
        view.viewWillStartLiveResize()
        NotificationCenter.default.post(name: NSWindow.didEnterFullScreenNotification, object: window)
        #expect(state.isLiveResize)
        view.frame.size = NSSize(width: 1400, height: 800)
        #expect(view.renderedContentSize == view.bounds.size)
        view.viewDidEndLiveResize()
        #expect(!state.isLiveResize)
        window.contentView = nil
    }

    @Test
    func initialWindowSizeUsesLargerScreenAwareBounds() {
        #expect(MainWindowInitialLayout.contentSize(
            for: NSRect(x: 0, y: 0, width: 1_920, height: 1_080)
        ) == NSSize(width: 1_480, height: 900))
        #expect(MainWindowInitialLayout.contentSize(
            for: NSRect(x: 0, y: 0, width: 1_440, height: 860)
        ) == NSSize(width: 1_324, height: 791))
        #expect(MainWindowInitialLayout.contentSize(
            for: NSRect(x: 0, y: 0, width: 1_000, height: 650)
        ) == NSSize(width: 920, height: 598))
        #expect(MainWindowInitialLayout.contentSize(
            for: NSRect(x: 0, y: 0, width: 900, height: 600)
        ) == NSSize(width: 900, height: 560))
    }

    @Test
    func firstRunUsesCompactWindowWithoutChangingWorkbenchDefault() {
        let screen = NSRect(x: 0, y: 0, width: 1440, height: 860)
        #expect(MainWindowInitialLayout.contentSize(for: screen, firstRun: true)
            == NSSize(width: 952, height: 695))
        #expect(MainWindowInitialLayout.contentSize(for: screen) == NSSize(width: 1324, height: 791))
        let smallerScreen = NSRect(x: 0, y: 0, width: 1000, height: 650)
        #expect(MainWindowInitialLayout.contentSize(for: smallerScreen, firstRun: true)
            == NSSize(width: 920, height: 598))
    }

    @Test
    func windowMinimumSizeIsSumOfVisibleColumnMinimums() {
        // Navigation rail 64 + Work column 284 + transcript 360 + 12 padding.
        #expect(MainWindowMinimumSizePolicy.contentMinSize(
            workColumnCollapsed: false, navigationShowsLabels: false
        ) == NSSize(width: 720, height: 480))
        // Collapsing the Work column gives its 284pt back to the user.
        #expect(MainWindowMinimumSizePolicy.contentMinSize(
            workColumnCollapsed: true, navigationShowsLabels: false
        ) == NSSize(width: 436, height: 480))
        #expect(MainWindowMinimumSizePolicy.contentMinSize(
            workColumnCollapsed: true, navigationShowsLabels: true
        ) == NSSize(width: 540, height: 480))
        #expect(MainWindowMinimumSizePolicy.defaultContentMinSize
                == NSSize(width: 720, height: 480))
        // The startup floor is deliberately larger than the resizable floor.
        #expect(MainWindowInitialLayout.minimumContentSize.width
                > MainWindowMinimumSizePolicy.defaultContentMinSize.width)
    }

    @MainActor
    @Test
    func leadingChromeUsesNativeTitlebarAccessoryHierarchy() {
        let chrome = MainWindowLeadingChromeAccessoryController()

        #expect(chrome.layoutAttribute == .left)
        #expect(chrome.hostingView.frame.width == 24)
        #expect(chrome.hostingView.frame.height >= 22)
        #expect(chrome.view === chrome.hostingView)
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
        container.select(.automations)
        container.layoutSubtreeIfNeeded()
        let hiddenConsoleFrame = try #require(created[.console]?.frame)

        container.frame.size = NSSize(width: 1_450, height: 860)
        container.layoutSubtreeIfNeeded()

        #expect(container.cachedPageCount == 2)
        #expect(container.attachedPageCount == 2)
        #expect(container.visibleTabs == [.automations])
        #expect(created[.console]?.frame == hiddenConsoleFrame)
        #expect(created[.automations]?.frame == container.bounds)
        #expect(created[.console]?.superview === container)
        #expect(created[.console]?.isHidden == true)
        #expect(created[.automations]?.superview === container)
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
    func automationsTabExposesCategoriesRiskRoutingHistoryAndManagementControls() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/AutomationsView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        for required in [
            "case all", "case running", "case failed", "case history",
            "创建时间", "上次执行时间", "预计下次执行时间", "过期时间", "Times use system time zone: %@",
            "生效中", "已取消", "已完成", "已过期", "异常", "Last Result", "Risk", "Run History",
            "bindingId", "routingVersion", "Run Now", "Retry", "Cancel"
        ] {
            #expect(contents.contains(required))
        }
        #expect(contents.contains("if automation.scheduleType.hasPredictableNextRun"))
        #expect(contents.contains("ScheduledSessionManagementTimeFormatting.string"))
        #expect(contents.contains("GridItem(.flexible(), alignment: .top)"))
        #expect(contents.contains("if isShowingDetails { details }"))
        #expect(contents.contains("compactActionButton"))
        let emptyStateStart = try #require(contents.range(of: "ContentUnavailableView {"))
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

        let legacyBoard = try String(
            contentsOf: sourceRoot.appendingPathComponent("WarRoomView.swift"),
            encoding: .utf8
        )
        let unifiedConsole = try String(
            contentsOf: sourceRoot.appendingPathComponent("UnifiedConsoleView.swift"),
            encoding: .utf8
        )
        #expect(legacyBoard.contains("max: TwoPaneLayoutMetrics.sidebarMaximumWidth"))
        let nativeSplit = try String(contentsOf: sourceRoot.appendingPathComponent("ConsoleWindowSplitView.swift"), encoding: .utf8)
        #expect(unifiedConsole.contains("ConsoleWindowSplitView(mode: navigationMode"))
        #expect(nativeSplit.contains("sidebar.minimumThickness = MainWindowMinimumSizePolicy.workColumnMinimumWidth"))
        #expect(nativeSplit.contains("sidebar.maximumThickness = 900"))
        #expect(!unifiedConsole.contains("navigationResizeHandle"))
        #expect(!legacyBoard.contains("w * 0.34"))
        #expect(!unifiedConsole.contains("w * 0.34"))
    }

    /// Guard the idle-churn cut at both ends: a durable revision bump or a
    /// metadata-only snapshot must not advance the presentation version, and
    /// hidden pages must not keep an offscreen hosting tree per cached cell.
    @Test
    func idleBackgroundEventsNeverRebuildTheDisplayProjection() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let repository = try String(contentsOf: root.appendingPathComponent("SessionTimelineRepository.swift"), encoding: .utf8)
        let coordinator = try String(contentsOf: root.appendingPathComponent("Conversation/Timeline/AppKitChatTimelineCoordinator.swift"), encoding: .utf8)
        let sharedCell = try String(contentsOf: root.appendingPathComponent("MacSharedMessageTextCard.swift"), encoding: .utf8)

        #expect(repository.contains("let contentChanged = (self.detail?.items ?? []) != detail.items"))
        #expect(repository.contains("guard contentChanged else { return }"))

        #expect(coordinator.contains("releaseDetachedCells()"))
        #expect(coordinator.contains("cellCacheCapacity"))
        #expect(!coordinator.contains("cellRecency.count > 96"))
        #expect(coordinator.contains("evicted.releaseRenderingResources()"))

        #expect(sharedCell.contains("func releaseRenderingResources()"))
        #expect(sharedCell.contains("NSLayoutConstraint.deactivate(hostConstraints)"))
        #expect(sharedCell.contains("guard window == nil, superview == nil else { return }"))
    }
}

@MainActor
final class MainWindowTitlebarDispatchTests: XCTestCase {
    // AppKit fixtures are retained through bundle teardown for the same reason
    // as ApplicationTerminationUITests: Work-C invalid-object checking can
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

    /// A 60s idle main-thread sample showed 94% of frames inside AppKit's
    /// display cycle: `NSWindow layoutIfNeeded` -> `_layoutSubtreeWithOldSize`
    /// -> `NSHostingView.layout()` -> `ViewGraph.updateOutputs` ->
    /// `RepeatAnimation.animate`. The trigger was a decorative
    /// `.animation(...repeatForever...)` on an always-mounted status light.
    /// Once started, that animation never stops on its own, so stopping an
    /// execution does not restore smoothness and the growing view tree makes
    /// every layout pass more expensive. Decorative pulses must live on the
    /// compositor instead.
    func testDecorativeIndicatorsNeverRunRepeatForeverSwiftUIAnimations() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let paths = [
            "SessionStatusLight.swift",
            "Conversation/ConversationMetadataViews.swift"
        ]
        for path in paths {
            let source = try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
            XCTAssertFalse(source.contains("repeatForever"),
                           "\(path) must not schedule an infinite SwiftUI animation")
            XCTAssertFalse(source.contains("breathPhase"),
                           "\(path) must not drive a pulse through SwiftUI @State")
        }
        let light = try String(contentsOf: root.appendingPathComponent("SessionStatusLight.swift"), encoding: .utf8)
        XCTAssertTrue(light.contains("CABasicAnimation(keyPath: \"opacity\")"))
        XCTAssertTrue(light.contains("pulse.repeatCount = .infinity"))
        XCTAssertTrue(light.contains("removeAnimation(forKey:"))
        XCTAssertTrue(light.contains("NSViewRepresentable"))
    }

    /// The first guardrail only inspected two files under Sources/CopetsMac and
    /// missed infinite SwiftUI animations shipped by the shared
    /// CorptieConversation package that macOS renders (MessageStatusGlow on
    /// every user message, ConsoleWorkTitle on running work rows). Scan every
    /// Swift file that actually goes into the macOS build.
    func testNoInfiniteSwiftUIAnimationShipsInMacOSBuild() throws {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let roots = [
            repo.appendingPathComponent("apps/macos/Sources/CopetsMac"),
            repo.appendingPathComponent("packages/CorptieConversation/Sources/CorptieConversation")
        ]
        for root in roots {
            guard let enumerator = FileManager.default.enumerator(
                at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
            ) else {
                XCTFail("Cannot enumerate \(root.path)")
                continue
            }
            for case let url as URL in enumerator where url.pathExtension == "swift" {
                let source = try String(contentsOf: url, encoding: .utf8)
                XCTAssertFalse(source.contains("repeatForever"),
                               "\(url.lastPathComponent) schedules an infinite SwiftUI animation")
            }
        }
    }
}
