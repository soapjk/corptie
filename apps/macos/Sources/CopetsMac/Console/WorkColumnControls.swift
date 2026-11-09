import AppKit
import SwiftUI

@MainActor
protocol WorkColumnControlling: AnyObject {
    func setWorkColumnCollapsed(_ collapsed: Bool)
}

/// Resolve the current native split at click time; no Session or page snapshot
/// is captured in a toolbar action.
@MainActor
private func workColumnController(from view: NSView) -> (any WorkColumnControlling)? {
    var responder: NSResponder? = view
    while let current = responder {
        if let controller = current as? any WorkColumnControlling { return controller }
        responder = current.nextResponder
    }
    return nil
}

struct WorkColumnCollapseButton: NSViewRepresentable {
    func makeNSView(context: Context) -> NSButton { WorkColumnCollapseControl() }
    func updateNSView(_ nsView: NSButton, context: Context) {}
}

private final class WorkColumnCollapseControl: NSButton {
    init() {
        super.init(frame: .init(x: 0, y: 0, width: 28, height: 28))
        isBordered = false
        image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: L10n("Hide Sidebar"))
        symbolConfiguration = .init(pointSize: 12, weight: .semibold)
        imagePosition = .imageOnly
        contentTintColor = .secondaryLabelColor
        toolTip = L10n("Hide Sidebar")
        setAccessibilityLabel(L10n("Hide Sidebar"))
        setAccessibilityIdentifier("work-outline-collapse")
        target = self
        action = #selector(collapseColumn)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func collapseColumn() {
        workColumnController(from: self)?.setWorkColumnCollapsed(true)
    }
}

/// A small edge affordance, outside layout flow. Only its narrow leading strip
/// intercepts clicks until hovered; it never reserves title or transcript width.
final class WorkColumnRestoreHandle: NSView {
    var expand: (() -> Void)?
    private let button = NSButton()
    private var tracking: NSTrackingArea?
    private(set) var showsButton = false
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        identifier = .init("work-outline-restore")
        toolTip = L10n("Show Sidebar")
        button.isBordered = false
        button.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: L10n("Show Sidebar"))
        button.symbolConfiguration = .init(pointSize: 12, weight: .semibold)
        button.imagePosition = .imageOnly
        button.contentTintColor = .secondaryLabelColor
        button.frame = .init(x: 0, y: 4, width: 28, height: 28)
        button.target = self
        button.action = #selector(openColumn)
        button.isHidden = true
        button.setAccessibilityElement(false)
        addSubview(button)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(L10n("Show Sidebar"))
        setAccessibilityIdentifier("work-outline-restore")
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let tracking = NSTrackingArea(rect: NSRect(x: 0, y: 0, width: showsButton ? 32 : 10, height: 36),
            options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
        addTrackingArea(tracking)
        self.tracking = tracking
    }
    override func mouseEntered(with event: NSEvent) { showButton(true) }
    override func mouseExited(with event: NSEvent) { showButton(false) }
    private func showButton(_ value: Bool) {
        guard showsButton != value else { return }
        showsButton = value
        button.isHidden = !value
        needsDisplay = true
        updateTrackingAreas()
    }
    func resetHover() { showButton(false) }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard !isHidden, local.x >= 0, local.x < (showsButton ? 32 : 10),
              local.y >= 0, local.y < bounds.height else { return nil }
        return super.hitTest(point)
    }
    override func mouseDown(with event: NSEvent) { openColumn() }
    override func accessibilityPerformPress() -> Bool { openColumn(); return true }
    @objc private func openColumn() { expand?() }
    override func draw(_ dirtyRect: NSRect) {
        if showsButton {
            NSColor.labelColor.withAlphaComponent(0.06).setFill()
            NSBezierPath(roundedRect: .init(x: 0, y: 4, width: 28, height: 28), xRadius: 6, yRadius: 6).fill()
        } else {
            NSColor.secondaryLabelColor.withAlphaComponent(0.45).setFill()
            NSBezierPath(roundedRect: .init(x: 2, y: 11, width: 3, height: 14), xRadius: 1.5, yRadius: 1.5).fill()
        }
    }
}
