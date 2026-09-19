import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct ConsoleWindowSplitViewTests {
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
        let layoutBeforeAccessory = window.contentLayoutRect
        window.addTitlebarAccessoryViewController(MainWindowTitlebarAccessoryController())
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
            #expect(contentFrame.maxY <= window.contentLayoutRect.maxY + 1)
        }
        let sidebar = try #require(split.arrangedSubviews.first)
        #expect(abs(sidebar.convert(sidebar.bounds, to: surface).maxY - surface.bounds.maxY) < 1)
        #expect(abs(rect.maxY - surface.bounds.maxY) < 1)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbar == nil)
        #expect(window.contentLayoutRect == layoutBeforeAccessory)
        // Geometry alone missed a SwiftUI ancestor clip: the sidebar frame
        // reached the top while its pixels were cut off at the safe area.
        let bitmap = try #require(surface.bitmapImageRepForCachingDisplay(in: surface.bounds))
        surface.cacheDisplay(in: surface.bounds, to: bitmap)
        let sampleX = bitmap.pixelsWide / 10
        let top = try #require(bitmap.colorAt(x: sampleX, y: 4)?.usingColorSpace(.deviceRGB))
        let body = try #require(bitmap.colorAt(x: sampleX, y: bitmap.pixelsHigh / 4)?.usingColorSpace(.deviceRGB))
        #expect(abs(top.redComponent - body.redComponent) < 0.02)
        #expect(abs(top.greenComponent - body.greenComponent) < 0.02)
        #expect(abs(top.blueComponent - body.blueComponent) < 0.02)
        if let path = ProcessInfo.processInfo.environment["CORPTIE_WINDOW_TEST_CAPTURE"] {
            if let data = bitmap.representation(using: .png, properties: [:]) {
                try data.write(to: URL(fileURLWithPath: path))
            }
        }
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
        window.addTitlebarAccessoryViewController(MainWindowTitlebarAccessoryController())
        window.contentViewController = controller
        controller.view.layoutSubtreeIfNeeded()
        controller.update(mode: .workOutline, isActive: true, sidebar: Text("Work"), detail: Text("Messages"))
        controller.view.layoutSubtreeIfNeeded()

        let sidebar = try #require(controller.splitViewItems.first)
        #expect(sidebar.behavior == .sidebar)
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
        controller.update(mode: .workRail, isActive: true, sidebar: Text("Rail"), detail: Text("Draft"))
        #expect(controller.splitViewItems.count == 2)
        #expect(controller.splitViewItems[0].viewController === original[0])
        #expect(controller.splitViewItems[1].viewController === original[1])
    }
}
