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
}
