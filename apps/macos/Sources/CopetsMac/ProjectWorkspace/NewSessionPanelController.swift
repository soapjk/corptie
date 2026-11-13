import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class NewSessionPanelController: NSObject, ObservableObject, NSWindowDelegate {
    @Published var isPresented = false
    private var panel: NSPanel?

    func show(backendClient: BackendClient, workspacePath: String? = nil) {
        if let panel {
            if workspacePath != nil {
                close()
            } else {
                panel.makeKeyAndOrderFront(nil)
                panel.orderFrontRegardless()
                NSApp.activate(ignoringOtherApps: true)
                isPresented = true
                return
            }
        }

        let parentFrame = NSApp.keyWindow?.frame ?? NSRect(x: 960, y: 560, width: 420, height: 360)
        let size = NSSize(width: 420, height: 620)
        let origin = NSPoint(
            x: parentFrame.midX - size.width / 2,
            y: max(80, parentFrame.midY - size.height / 2)
        )
        let nextPanel = SessionCreationPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        nextPanel.isFloatingPanel = true
        nextPanel.level = .floating
        nextPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        nextPanel.isOpaque = false
        nextPanel.backgroundColor = .clear
        nextPanel.hasShadow = true
        nextPanel.hidesOnDeactivate = false
        nextPanel.isMovableByWindowBackground = false
        nextPanel.delegate = self

        let rootView = NewPtyAgentTaskSheet(
            initialWorkspacePath: workspacePath,
            modelCatalog: backendClient.modelCatalog,
            close: { [weak self] in self?.close() }
        )
        .environmentObject(backendClient)
        .padding(18)
        .frame(width: size.width, height: size.height)

        let hostingView = NSHostingView(rootView: rootView)
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor
        hostingView.layer?.cornerRadius = 26
        hostingView.layer?.cornerCurve = .continuous
        hostingView.layer?.masksToBounds = true
        nextPanel.contentView = hostingView

        panel = nextPanel
        isPresented = true
        nextPanel.makeKeyAndOrderFront(nil)
        nextPanel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        panel?.orderOut(nil)
        panel = nil
        isPresented = false
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            self.panel = nil
            self.isPresented = false
        }
    }
}

final class SessionCreationPanel: NSPanel {
    override func mouseDown(with event: NSEvent) {
        NSApp.activate(ignoringOtherApps: true)
        super.mouseDown(with: event)
    }

    override func sendEvent(_ event: NSEvent) {
        // A floating panel remains visible while another app is active. Promote
        // it to key before AppKit dispatches the first mouse-down so that the
        // same click reaches the SwiftUI control instead of only activating the
        // panel. acceptsFirstMouse on the root hosting view is insufficient for
        // controls nested inside SwiftUI ScrollView hosting layers.
        if event.type == .leftMouseDown && !isKeyWindow {
            NSApp.activate(ignoringOtherApps: true)
            makeKey()
        }
        super.sendEvent(event)
    }

    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

