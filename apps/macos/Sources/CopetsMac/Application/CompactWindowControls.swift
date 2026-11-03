import AppKit
import SwiftUI

/// Positions the window's actual controls without replacing their drawing,
/// tracking areas, target/action or system window-layout menu.
struct CompactWindowControls: NSViewRepresentable {
    func makeNSView(context: Context) -> CompactWindowControlsView { CompactWindowControlsView() }
    func updateNSView(_ view: CompactWindowControlsView, context: Context) { view.positionButtons() }
    static func dismantleNSView(_ view: CompactWindowControlsView, coordinator: ()) { view.detach() }
}

@MainActor
final class CompactWindowControlsView: NSView {
    private(set) var buttons: [NSButton] = []
    private var originalFrames: [NSRect] = []
    private var originalFrameNotifications: [Bool] = []
    private var observations: [NSObjectProtocol] = []
    private weak var boundWindow: MainWindow?
    private var positioning = false

    init() { super.init(frame: NSRect(x: 0, y: 0, width: 56, height: 32)) }
    required init?(coder: NSCoder) { fatalError() }

    // The native title-bar buttons remain in their original hierarchy.
    // This layout anchor must never intercept their hover or mouse tracking.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func layout() { super.layout(); positionButtons() }
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow !== window { detach() }
        super.viewWillMove(toWindow: newWindow)
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window = window as? MainWindow, boundWindow !== window else { return }
        boundWindow = window
        buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap {
            window.standardWindowButton($0)
        }
        originalFrames = buttons.map(\.frame)
        originalFrameNotifications = buttons.map(\.postsFrameChangedNotifications)
        for button in buttons {
            button.postsFrameChangedNotifications = true
            observations.append(NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification,
                object: button, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.positionButtons() }
            })
        }
        for name in [NSWindow.didResizeNotification, NSWindow.didExitFullScreenNotification] {
            observations.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.positionButtons() }
            })
        }
        positionButtons()
    }

    func positionButtons() {
        guard !positioning, let window = boundWindow,
              !window.styleMask.contains(.fullScreen), !buttons.isEmpty else { return }
        positioning = true
        defer { positioning = false }
        let gap: CGFloat = 3
        let width = buttons.reduce(CGFloat.zero) { $0 + $1.frame.width } + CGFloat(buttons.count - 1) * gap
        var x = bounds.midX - width / 2
        for button in buttons {
            guard let parent = button.superview else { continue }
            // Preserve the system's vertical position and unscaled control size.
            let targetX = parent.convert(convert(NSPoint(x: x, y: bounds.midY), to: nil), from: nil).x
            if abs(button.frame.minX - targetX) > 0.01 { button.setFrameOrigin(NSPoint(x: targetX, y: button.frame.minY)) }
            x += button.frame.width + gap
        }
    }

    fileprivate func detach() {
        for observation in observations { NotificationCenter.default.removeObserver(observation) }
        observations.removeAll()
        for (button, original) in zip(buttons, originalFrames) {
            button.setFrameOrigin(NSPoint(x: original.minX, y: button.frame.minY))
        }
        for (button, enabled) in zip(buttons, originalFrameNotifications) {
            button.postsFrameChangedNotifications = enabled
        }
        buttons.removeAll()
        originalFrames.removeAll()
        originalFrameNotifications.removeAll()
        boundWindow = nil
    }
}
