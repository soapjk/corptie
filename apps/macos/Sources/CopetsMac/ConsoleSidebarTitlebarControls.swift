import AppKit
import SwiftUI

/// Hosts sidebar actions beside the traffic lights, without a toolbar row.
struct ConsoleSidebarTitlebarControls<Content: View>: NSViewRepresentable {
    let isActive: Bool
    let content: Content

    func makeCoordinator() -> Coordinator { Coordinator(content: content) }

    func makeNSView(context: Context) -> WindowProbe {
        let probe = WindowProbe()
        probe.windowChanged = { [weak coordinator = context.coordinator] window in
            coordinator?.attach(to: window)
        }
        return probe
    }

    func updateNSView(_ probe: WindowProbe, context: Context) {
        context.coordinator.host.rootView = content
        context.coordinator.active = isActive
        context.coordinator.attach(to: probe.window)
    }

    static func dismantleNSView(_ probe: WindowProbe, coordinator: Coordinator) {
        probe.windowChanged = nil
        coordinator.accessory.removeFromParent()
    }

    final class WindowProbe: NSView {
        var windowChanged: ((NSWindow?) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            windowChanged?(window)
        }
    }

    @MainActor
    final class Coordinator {
        let host: NSHostingView<Content>
        let accessory = NSTitlebarAccessoryViewController()
        weak var attachedWindow: NSWindow?
        var active = false

        init(content: Content) {
            host = NSHostingView(rootView: content)
            host.sizingOptions = []
            host.frame = NSRect(x: 0, y: 0, width: 184, height: 26)
            host.identifier = NSUserInterfaceItemIdentifier("console.sidebar.titlebarActions")
            accessory.layoutAttribute = .left
            accessory.view = host
        }

        func attach(to window: NSWindow?) {
            guard active, let window else {
                accessory.removeFromParent()
                attachedWindow = nil
                return
            }
            guard attachedWindow !== window else { return }
            accessory.removeFromParent()
            window.addTitlebarAccessoryViewController(accessory)
            attachedWindow = window
        }
    }
}
