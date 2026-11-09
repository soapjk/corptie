import AppKit
import CorptieConversation
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct ConsoleWindowSplitViewTests {
    @Test
    func hiddenHostsKeepStateAndReceiveLatestContentOnReactivation() {
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: Text("One"), detail: Text("One"))
        controller.loadViewIfNeeded()
        controller.update(mode: .workOutline, isActive: false, sidebar: Text("Inactive"), detail: Text("Inactive"))
        let before = controller.contentUpdateCount
        for _ in 0..<100 {
            controller.update(mode: .workOutline, isActive: false, sidebar: Text("Hidden"), detail: Text("Hidden"))
        }
        #expect(controller.contentUpdateCount == before)
        controller.update(mode: .workOutline, isActive: true, sidebar: Text("Latest"), detail: Text("Latest"))
        #expect(controller.contentUpdateCount == before + 1)
    }

    @Test
    func embeddedWindowShellPreservesFullHeightSidebar() throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        let state = MainWindowResizeState()
        let surface = MainWindowSurfaceContainer(rootView: MainWindowContentView().environmentObject(state), resizeState: state)
        surface.frame = try #require(window.contentView).bounds
        window.contentView = surface
        let unobscuredRect = window.contentLayoutRect
        window.makeKeyAndOrderFront(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let split = try #require(descendants(surface).compactMap { $0 as? ConsoleNativeSplitView }.first)
        let rect = split.convert(split.bounds, to: surface)
        for identifier in ["console.sidebar.content", "console.detail.content"] {
            let content = try #require(descendants(split).first { $0.identifier?.rawValue == identifier })
            let contentFrame = content.convert(content.bounds, to: surface)
            #expect(contentFrame.height >= window.contentLayoutRect.height - 1)
            #expect(contentFrame.maxY > unobscuredRect.maxY)
        }
        let sidebar = try #require(split.arrangedSubviews.first)
        #expect(abs(sidebar.convert(sidebar.bounds, to: surface).maxY - surface.bounds.maxY) < 1)
        #expect(abs(rect.maxY - surface.bounds.maxY) < 1)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbar == nil)
        #expect(window.titlebarAccessoryViewControllers.isEmpty)
        window.close()
    }
    @Test
    func sidebarOccupiesFullWindowAndCollapsedDividerRemainsReachable() throws {
        _ = NSApplication.shared
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: Text("Work"), detail: Text("Messages"))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.contentViewController = controller
        controller.view.layoutSubtreeIfNeeded()
        controller.update(mode: .workOutline, isActive: true, sidebar: Text("Work"), detail: Text("Messages"))
        controller.view.layoutSubtreeIfNeeded()

        let sidebar = try #require(controller.splitViewItems.first)
        #expect(sidebar.behavior == .default)
        #expect(sidebar.allowsFullHeightLayout)
        let frame = sidebar.viewController.view.convert(sidebar.viewController.view.bounds, to: window.contentView)
        #expect(abs(frame.height - controller.splitView.bounds.height) < 1)
        #expect(frame.maxY > window.contentLayoutRect.maxY)
        #expect(window.toolbar == nil)
        #expect(sidebar.canCollapse)
        sidebar.isCollapsed = true
        controller.view.layoutSubtreeIfNeeded()
        #expect(!controller.splitView(controller.splitView, shouldHideDividerAt: 0))
        #expect(controller.splitView(controller.splitView, additionalEffectiveRectOfDividerAt: 0).width >= 6)
        sidebar.isCollapsed = false
        controller.view.layoutSubtreeIfNeeded()
        #expect(!sidebar.isCollapsed)
        window.close()
    }

    @Test
    func switchingModesRetainsBothContentControllers() {
        _ = NSApplication.shared
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: Text("Work"), detail: Text("Draft"))
        _ = controller.view
        let original = controller.splitViewItems.map(\.viewController)
        controller.update(mode: .taskCards, isActive: true, sidebar: Text("Cards"), detail: Text("Draft"))
        controller.update(mode: .workOutline, isActive: true, sidebar: Text("Groups"), detail: Text("Draft"))
        #expect(controller.splitViewItems.count == 2)
        #expect(controller.splitViewItems[0].viewController === original[0])
        #expect(controller.splitViewItems[1].viewController === original[1])
    }

    @Test
    func workOutlineDefaultsToCompactColumnWidth() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/ConsoleWindowSplitView.swift"),
            encoding: .utf8)
        #expect(source.contains("mode == .taskCards ? 540 : 284"))
        #expect(source.contains("console.nativeSidebar.listWidth.v2"))
    }

    @Test
    func workToolbarCollapseAndEdgeRestoreRetainWidthAndHostedContent() throws {
        _ = NSApplication.shared
        let suite = "ConsoleWindowSplitViewTests.collapse.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: WorkColumnCollapseButton(),
            detail: Text("Current conversation"), defaults: defaults)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 1400, height: 800),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        defer { window.contentViewController = nil; window.close() }
        controller.view.layoutSubtreeIfNeeded()
        let children = controller.splitViewItems.map(\.viewController)
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let collapse = try #require(descendants(controller.view).compactMap { $0 as? NSButton }
            .first { $0.accessibilityIdentifier() == "work-outline-collapse" })
        let handle = try #require(descendants(controller.view).compactMap { $0 as? WorkColumnRestoreHandle }.first)
        #expect(handle.isHidden)
        NotificationCenter.default.post(name: ConsoleNativeSplitView.willBeginDividerTracking, object: controller.splitView)
        controller.splitView.setPosition(400, ofDividerAt: 0)
        controller.view.layoutSubtreeIfNeeded()
        NotificationCenter.default.post(name: ConsoleNativeSplitView.didEndDividerTracking, object: window)
        let before = children[1].view.frame.width
        let commits = controller.contentUpdateCount
        collapse.performClick(nil)
        controller.view.layoutSubtreeIfNeeded()
        #expect(controller.splitViewItems[0].isCollapsed)
        #expect(!handle.isHidden)
        #expect(children[1].view.frame.width >= before + 399)
        #expect(!handle.showsButton)
        #expect(handle.frame.width == 32)
        // The wider overlay stays click-through until the narrow strip is hovered.
        #expect(handle.hitTest(NSPoint(x: handle.frame.minX + 20, y: handle.frame.midY)) == nil)
        let event = try #require(NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
        handle.mouseEntered(with: event)
        #expect(handle.showsButton)
        #expect(handle.hitTest(NSPoint(x: handle.frame.minX + 20, y: handle.frame.midY)) != nil)
        handle.mouseExited(with: event)
        #expect(!handle.showsButton)
        for width in [1800.0, 1100.0, 1400.0] {
            window.setContentSize(.init(width: width, height: 800))
            controller.view.layoutSubtreeIfNeeded()
            #expect(controller.splitViewItems[0].isCollapsed)
            #expect(!handle.isHidden)
        }
        #expect(handle.accessibilityPerformPress())
        controller.view.layoutSubtreeIfNeeded()
        #expect(!controller.splitViewItems[0].isCollapsed)
        #expect(handle.isHidden)
        #expect(abs(children[0].view.frame.width - 400) < 1)
        #expect(abs(defaults.double(forKey: "console.nativeSidebar.listWidth.v2") - 400) < 1)
        #expect(controller.contentUpdateCount == commits)
        #expect(controller.splitViewItems[0].viewController === children[0])
        #expect(controller.splitViewItems[1].viewController === children[1])
        // Divider-driven collapse also exposes the same restore affordance.
        controller.splitViewItems[0].isCollapsed = true
        #expect(!handle.isHidden)
    }

    @Test
    func windowResizeKeepsDefaultAndUserSidebarWidths() throws {
        _ = NSApplication.shared
        let suite = "ConsoleWindowSplitViewTests.fixedWidth.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: Text("Work"),
            detail: Text("Messages"), defaults: defaults)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        defer { window.contentViewController = nil; window.close() }
        controller.view.layoutSubtreeIfNeeded()
        let sidebar = try #require(controller.splitView.arrangedSubviews.first)
        let messages = try #require(controller.splitView.arrangedSubviews.last)
        #expect(abs(sidebar.frame.width - 284) < 1)
        let updates = controller.contentUpdateCount
        func resize(_ widths: [CGFloat], expected: CGFloat) {
            for width in widths {
                let previousCanvas = controller.splitView.bounds.width
                let previousMessages = messages.frame.width
                window.setContentSize(.init(width: width, height: 800))
                controller.view.layoutSubtreeIfNeeded()
                #expect(abs(sidebar.frame.width - expected) < 1)
                #expect(abs((messages.frame.width - previousMessages)
                    - (controller.splitView.bounds.width - previousCanvas)) < 1)
            }
        }
        resize([1600, 1080, 1800, 1200], expected: 284)
        NotificationCenter.default.post(name: ConsoleNativeSplitView.willBeginDividerTracking, object: controller.splitView)
        controller.splitView.setPosition(400, ofDividerAt: 0)
        controller.view.layoutSubtreeIfNeeded()
        let adjusted = sidebar.frame.width
        #expect(abs(adjusted - 400) < 1)
        NotificationCenter.default.post(name: ConsoleNativeSplitView.didEndDividerTracking, object: window)
        resize([1800, 1080, 1400, 1200], expected: adjusted)
        #expect(controller.contentUpdateCount == updates, "Window resizing must not replace the hosted roots")
        #expect(abs(defaults.double(forKey: "console.nativeSidebar.listWidth.v2") - adjusted) < 1)

        let restored = ConsoleSplitController(mode: .workOutline, sidebar: Text("Work"),
            detail: Text("Messages"), defaults: defaults)
        window.contentViewController = restored
        restored.view.layoutSubtreeIfNeeded()
        #expect(abs(try #require(restored.splitView.arrangedSubviews.first).frame.width - adjusted) < 1)
    }

    @Test
    func sidebarPaneAnchorsAtTheTopAndCollapsesFromTheBottom() {
        let pane = ConsolePaneController(root: Text("Work"), isSidebar: true)
        pane.view.frame = NSRect(x: 0, y: 0, width: 284, height: 700)
        pane.view.layoutSubtreeIfNeeded()
        let heldSize = pane.host.view.frame.size
        #expect(heldSize.width > 1)
        #expect(heldSize.height > 1)

        pane.freezeForLiveResize()
        #expect(pane.isFrozenForLiveResize)
        // The sidebar stays visible and interactive. No snapshot, no overlay,
        // no hidden host: AppKit composites the existing layer itself.
        #expect(!pane.host.view.isHidden)
        #expect(pane.view.subviews.count == 1)
        #expect(pane.view.subviews.first === pane.host.view)

        // The top edge stays pinned, so the size proposal never changes and
        // SwiftUI does no work. In AppKit's bottom-left origin it is minY
        // (the bottom) that absorbs the window's height change — never maxY.
        for paneHeight in [CGFloat(820), 760, 640] {
            pane.view.frame = NSRect(x: 0, y: 0, width: 284, height: paneHeight)
            pane.view.layoutSubtreeIfNeeded()
            #expect(abs(pane.host.view.frame.width - heldSize.width) < 1)
            #expect(abs(pane.host.view.frame.height - heldSize.height) < 1)
            #expect(abs(pane.host.view.frame.maxY - pane.view.bounds.maxY) < 1,
                    "The sidebar must stay pinned to the top")
            if paneHeight > heldSize.height {
                #expect(pane.host.view.frame.minY > 0, "Taller window opens the gap at the bottom")
            } else {
                #expect(pane.host.view.frame.minY < 0, "Shorter window crops from the bottom up")
            }
            #expect(!pane.host.view.isHidden)
        }
        // A repeated start notification must not stack held constraints.
        pane.freezeForLiveResize()
        #expect(pane.view.subviews.count == 1)

        pane.unfreezeAfterLiveResize()
        #expect(!pane.isFrozenForLiveResize)
        #expect(!pane.host.view.isHidden)
        #expect(pane.host.view.frame == pane.view.bounds)
        pane.unfreezeAfterLiveResize()
        #expect(pane.host.view.frame == pane.view.bounds)
    }

    @Test
    func transcriptDetailPaneNeverHoldsGeometry() {
        let pane = ConsolePaneController(root: Text("Messages"), isSidebar: false)
        pane.view.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        pane.view.layoutSubtreeIfNeeded()
        pane.freezeForLiveResize()
        #expect(!pane.isFrozenForLiveResize)
        #expect(!pane.host.view.isHidden)
        pane.view.frame = NSRect(x: 0, y: 0, width: 1200, height: 700)
        pane.view.layoutSubtreeIfNeeded()
        #expect(pane.host.view.frame.width == 1200)
    }

    @Test
    func zeroSizedSidebarPaneSkipsFreezeWithoutHidingContent() {
        let pane = ConsolePaneController(root: Text("Work"), isSidebar: true)
        pane.view.frame = .zero
        pane.view.layoutSubtreeIfNeeded()
        pane.freezeForLiveResize()
        #expect(!pane.isFrozenForLiveResize)
        #expect(!pane.host.view.isHidden)
        #expect(pane.view.subviews.count == 1)
        // Constraints remain live, so a later real layout still reaches it.
        pane.view.frame = NSRect(x: 0, y: 0, width: 284, height: 700)
        pane.view.layoutSubtreeIfNeeded()
        #expect(pane.host.view.frame == pane.view.bounds)
    }

    @Test
    func liveResizeHoldsOnlySidebarGeometryWhileTranscriptKeepsEveryWidth() throws {
        _ = NSApplication.shared
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: Text("Work"), detail: Text("Messages"))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        defer { window.contentViewController = nil; window.close() }
        window.makeKeyAndOrderFront(nil)
        controller.view.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        controller.view.layoutSubtreeIfNeeded()

        let sidebarPane = try #require(controller.splitViewItems[0].viewController as? ConsolePaneController<Text>)
        let detailPane = try #require(controller.splitViewItems[1].viewController as? ConsolePaneController<Text>)
        let sidebar = try #require(controller.splitView.arrangedSubviews.first)
        let messages = try #require(controller.splitView.arrangedSubviews.last)

        #expect(sidebarPane.view.window === window)
        #expect(sidebarPane.view.bounds.width > 1)
        // An offscreen unit-test window never gives the split pane a real
        // height, and NSSplitView resets any frame injected into its arranged
        // subview on layout. Set the hosting view's frame directly so the hold
        // path is exercised instead of taking its "no usable geometry" fallback.
        let heldSidebarFrame = NSRect(x: 0, y: 0, width: sidebarPane.view.bounds.width, height: 700)
        sidebarPane.host.view.frame = heldSidebarFrame

        NotificationCenter.default.post(name: NSWindow.willStartLiveResizeNotification, object: window)
        #expect(sidebarPane.isFrozenForLiveResize)
        #expect(!sidebarPane.host.view.isHidden)
        #expect(sidebarPane.view.subviews.count == 1)
        #expect(!detailPane.isFrozenForLiveResize)
        #expect(!detailPane.host.view.isHidden)

        for width in [CGFloat(1500), 1080, 1800] {
            let beforeSplit = controller.splitView.bounds.width
            let beforeMessages = messages.frame.width
            let beforeDetailHost = detailPane.host.view.frame.width
            window.setContentSize(NSSize(width: width, height: 800))
            controller.view.layoutSubtreeIfNeeded()
            let canvasDelta = controller.splitView.bounds.width - beforeSplit
            #expect(abs((messages.frame.width - beforeMessages) - canvasDelta) < 1)
            #expect(abs((detailPane.host.view.frame.width - beforeDetailHost) - canvasDelta) < 1)
            #expect(abs(sidebar.frame.width - 284) < 1)
            #expect(!detailPane.host.view.isHidden, "The transcript must stay live on every resize frame")
            #expect(abs(sidebarPane.host.view.frame.width - heldSidebarFrame.width) < 1)
            #expect(abs(sidebarPane.host.view.frame.height - heldSidebarFrame.height) < 1,
                    "The sidebar receives no new size proposal")
            #expect(abs(sidebarPane.host.view.frame.maxY - sidebarPane.view.bounds.maxY) < 1,
                    "The sidebar stays pinned to the top; the bottom absorbs the height change")
            #expect(!sidebarPane.host.view.isHidden)
        }

        NotificationCenter.default.post(name: NSWindow.didEndLiveResizeNotification, object: window)
        #expect(!sidebarPane.isFrozenForLiveResize)
        #expect(!sidebarPane.host.view.isHidden)
        #expect(sidebarPane.view.subviews.count == 1)
        #expect(sidebarPane.host.view.frame == sidebarPane.view.bounds)
    }

    @Test
    func liveResizeHoldsDetailRootAndCommitsLatestOnce() throws {
        _ = NSApplication.shared
        let controller = ConsoleSplitController(mode: .workOutline, sidebar: Text("Work"), detail: Text("v0"))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        defer { window.contentViewController = nil; window.close() }
        controller.view.layoutSubtreeIfNeeded()
        controller.update(mode: .workOutline, isActive: true, sidebar: Text("Work"), detail: Text("v0"))
        #expect(controller.detailRootCommitCount == 1)

        controller.liveResizeOverride = true
        for frame in 1...12 {
            controller.update(mode: .workOutline, isActive: true,
                sidebar: Text("Work \(frame)"), detail: Text("v\(frame)"))
        }
        #expect(controller.detailRootCommitCount == 1,
            "The transcript tree must not be rebuilt on live-resize frames")
        #expect(controller.contentUpdateCount == 13)

        // The hosted view still receives every width proposal, so message text
        // and the composer keep re-wrapping during the drag.
        let detailPane = try #require(controller.splitViewItems[1].viewController as? ConsolePaneController<Text>)
        let before = detailPane.host.view.frame.width
        window.setContentSize(NSSize(width: 1500, height: 800))
        controller.view.layoutSubtreeIfNeeded()
        #expect(detailPane.host.view.frame.width > before)

        NotificationCenter.default.post(name: NSWindow.didEndLiveResizeNotification, object: window)
        #expect(controller.detailRootCommitCount == 2, "Exactly one commit at gesture end")
    }

    @Test
    func noUnconditionalRootReplacementRemainsInConversationRegionStack() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Conversation/ConversationRegionStack.swift"),
            encoding: .utf8)
        #expect(source.contains("func updateNSView(_ view: ConversationRegionContainer<AnyView, AnyView>, context: Context)"))
        #expect(source.contains("view.applyRoots(content:"))
        #expect(!source.contains("view.content.rootView = AnyView("),
            "updateNSView must never assign a type-erased root directly")
        #expect(!source.contains("view.accessory.rootView = accessoryRoot()"))
        #expect(source.contains("static func dismantleNSView"))
    }
}
