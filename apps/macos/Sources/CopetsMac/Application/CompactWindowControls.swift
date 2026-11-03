import AppKit
import SwiftUI

struct CompactWindowControls: NSViewRepresentable {
    func makeNSView(context: Context) -> CompactWindowControlsView { CompactWindowControlsView() }
    func updateNSView(_ view: CompactWindowControlsView, context: Context) {}
    static func dismantleNSView(_ view: CompactWindowControlsView, coordinator: ()) { view.detach() }
}

/// Pure geometry shared by the layout panel and its regression checks.
enum CompactWindowPlacement: CaseIterable {
    case left, right, top, bottom, fill, topLeft, topRight, bottomLeft, bottomRight
    func frame(in area: NSRect) -> NSRect {
        let halfWidth = area.width / 2, halfHeight = area.height / 2
        switch self {
        case .fill: return area
        case .left: return NSRect(x: area.minX, y: area.minY, width: halfWidth, height: area.height)
        case .right: return NSRect(x: area.midX, y: area.minY, width: halfWidth, height: area.height)
        case .top: return NSRect(x: area.minX, y: area.midY, width: area.width, height: halfHeight)
        case .bottom: return NSRect(x: area.minX, y: area.minY, width: area.width, height: halfHeight)
        case .topLeft: return NSRect(x: area.minX, y: area.midY, width: halfWidth, height: halfHeight)
        case .topRight: return NSRect(x: area.midX, y: area.midY, width: halfWidth, height: halfHeight)
        case .bottomLeft: return NSRect(x: area.minX, y: area.minY, width: halfWidth, height: halfHeight)
        case .bottomRight: return NSRect(x: area.midX, y: area.minY, width: halfWidth, height: halfHeight)
        }
    }
}

@MainActor
final class CompactWindowControlsView: NSView {
    let buttons: [CompactWindowButton] = (0..<3).map { CompactWindowButton(kind: $0) }
    private weak var boundWindow: MainWindow?
    private var originals: [(NSButton, Bool)] = []
    private var observations: [NSObjectProtocol] = []
    private var tracking: NSTrackingArea?
    private var menuTimer: Timer?
    private var popover: NSPopover?
    private var restoreFrame: NSRect?

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: MainNavigationRailLayout.width, height: 32))
        for button in buttons {
            button.target = self
            button.action = #selector(activate(_:))
            button.owner = self
            addSubview(button)
        }
        needsLayout = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(x: (bounds.width - 52) / 2 + CGFloat(index) * 18,
                                  y: (bounds.height - 24) / 2, width: 16, height: 24)
        }
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func mouseEntered(with event: NSEvent) { buttons.forEach { $0.hovered = true; $0.needsDisplay = true } }
    override func mouseExited(with event: NSEvent) { buttons.forEach { $0.hovered = false; $0.needsDisplay = true } }
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow !== window { detach() }
        super.viewWillMove(toWindow: newWindow)
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window = window as? MainWindow, boundWindow !== window else { return }
        boundWindow = window
        originals = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap {
            window.standardWindowButton($0).map { ($0, $0.isHidden) }
        }
        window.compactWindowControls = self
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                     NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
            observations.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
        }
        refresh()
    }
    private func refresh() {
        guard let window = boundWindow else { return }
        originals.forEach { $0.0.isHidden = true }
        buttons[0].isEnabled = window.styleMask.contains(.closable)
        buttons[1].isEnabled = window.styleMask.contains(.miniaturizable) && !window.styleMask.contains(.fullScreen)
        buttons[2].isEnabled = window.styleMask.contains(.resizable)
        buttons.forEach { $0.needsDisplay = true }
        if !window.isKeyWindow { cancelMenuRequest() }
    }
    fileprivate func detach() {
        cancelMenuRequest(); popover?.close(); popover = nil
        observations.forEach(NotificationCenter.default.removeObserver)
        observations.removeAll()
        originals.forEach { $0.0.isHidden = $0.1 }; originals.removeAll()
        if boundWindow?.compactWindowControls === self { boundWindow?.compactWindowControls = nil }
        boundWindow = nil
    }
    func button(at point: NSPoint) -> NSButton? {
        guard !isHiddenOrHasHiddenAncestor else { return nil }
        let local = convert(point, from: nil)
        return buttons.first { $0.isEnabled && $0.frame.contains(local) }
    }
    func requestMenu(after delay: TimeInterval = 0.8) {
        cancelMenuRequest()
        guard boundWindow?.isKeyWindow == true, buttons[2].isEnabled else { return }
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.showLayoutMenu() }
        }
        menuTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
    func cancelMenuRequest() { menuTimer?.invalidate(); menuTimer = nil }
    func showLayoutMenu() {
        cancelMenuRequest()
        guard let window = boundWindow, window.attachedSheet == nil, window.isKeyWindow,
              !window.styleMask.contains(.fullScreen), buttons[2].isEnabled else { return }
        if popover?.isShown == true { return }
        let panel = NSPopover()
        panel.behavior = .transient
        panel.animates = false
        panel.contentViewController = NSHostingController(rootView: CompactWindowLayoutPanel(
            screens: NSScreen.screens.map(\.localizedName),
            place: { [weak self] in self?.place($0) },
            restore: { [weak self] in self?.restore() },
            fullscreen: { [weak self] in self?.toggleFullscreen() },
            moveScreen: { [weak self] in self?.moveToScreen($0) }))
        popover = panel
        panel.show(relativeTo: buttons[2].bounds, of: buttons[2], preferredEdge: .maxY)
    }
    @objc private func activate(_ sender: CompactWindowButton) {
        cancelMenuRequest()
        guard let window = boundWindow, window.attachedSheet == nil else { return }
        switch sender.kind {
        case 0: window.performClose(sender)
        case 1: window.performMiniaturize(sender)
        default:
            if popover?.isShown != true { toggleFullscreen() }
        }
    }
    private func toggleFullscreen() { popover?.close(); boundWindow?.toggleFullScreen(nil) }
    func place(_ placement: CompactWindowPlacement) {
        guard let window = boundWindow, !window.styleMask.contains(.fullScreen), let screen = window.screen else { return }
        if restoreFrame == nil { restoreFrame = window.frame }
        popover?.close()
        window.setFrame(placement.frame(in: screen.visibleFrame), display: true)
    }
    func restore() {
        popover?.close()
        guard let frame = restoreFrame else { return }
        boundWindow?.setFrame(frame, display: true); restoreFrame = nil
    }
    private func moveToScreen(_ index: Int) {
        guard let window = boundWindow, NSScreen.screens.indices.contains(index) else { return }
        popover?.close()
        let area = NSScreen.screens[index].visibleFrame
        let size = NSSize(width: min(window.frame.width, area.width), height: min(window.frame.height, area.height))
        window.setFrame(NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2,
                               width: size.width, height: size.height), display: true)
    }
}

@MainActor
final class CompactWindowButton: NSButton {
    let kind: Int
    weak var owner: CompactWindowControlsView?
    var hovered = false
    private var tracking: NSTrackingArea?
    override var acceptsFirstResponder: Bool { false }
    init(kind: Int) {
        self.kind = kind
        super.init(frame: .zero)
        isBordered = false; title = ""; setButtonType(.momentaryPushIn); focusRingType = .none
        setAccessibilityLabel(L10n(["关闭窗口", "最小化窗口", "全屏与窗口布局"][kind]))
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard kind == 2 else { return }
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func mouseEntered(with event: NSEvent) { owner?.requestMenu() }
    override func mouseExited(with event: NSEvent) { owner?.cancelMenuRequest() }
    override func mouseDown(with event: NSEvent) {
        if kind == 2 { owner?.requestMenu(after: 0.4) }
        super.mouseDown(with: event)
        owner?.cancelMenuRequest()
    }
    override func rightMouseDown(with event: NSEvent) { if kind == 2 { owner?.showLayoutMenu() } }
    var dotRect: NSRect { NSRect(x: bounds.midX - 6, y: bounds.midY - 6, width: 12, height: 12) }
    override func draw(_ dirtyRect: NSRect) {
        let active = isEnabled && (window?.isKeyWindow == true || hovered)
        let colors: [NSColor] = [.systemRed, .systemYellow, .systemGreen]
        (active ? colors[kind] : .tertiaryLabelColor).setFill()
        let circle = NSBezierPath(ovalIn: dotRect); circle.fill()
        NSColor.black.withAlphaComponent(active ? 0.18 : 0.08).setStroke()
        let rim = NSBezierPath(ovalIn: dotRect.insetBy(dx: 0.25, dy: 0.25))
        rim.lineWidth = 0.5
        rim.stroke()
        if isHighlighted { NSColor.black.withAlphaComponent(0.2).setFill(); circle.fill() }
        guard hovered && isEnabled else { return }
        NSColor.black.withAlphaComponent(0.65).setStroke()
        let path = NSBezierPath(); path.lineWidth = 1; path.lineCapStyle = .round
        let x = bounds.midX, y = bounds.midY
        if kind == 0 {
            path.move(to: .init(x: x-2, y: y-2)); path.line(to: .init(x: x+2, y: y+2))
            path.move(to: .init(x: x-2, y: y+2)); path.line(to: .init(x: x+2, y: y-2))
        } else if kind == 1 {
            path.move(to: .init(x: x-2.5, y: y)); path.line(to: .init(x: x+2.5, y: y))
        } else {
            path.move(to: .init(x: x-2, y: y-2)); path.line(to: .init(x: x+2, y: y+2))
            path.move(to: .init(x: x-2, y: y)); path.line(to: .init(x: x-2, y: y-2)); path.line(to: .init(x: x, y: y-2))
            path.move(to: .init(x: x+2, y: y)); path.line(to: .init(x: x+2, y: y+2)); path.line(to: .init(x: x, y: y+2))
        }
        path.stroke()
    }
}

private struct CompactWindowLayoutPanel: View {
    let screens: [String]
    let place: (CompactWindowPlacement) -> Void
    let restore: () -> Void
    let fullscreen: () -> Void
    let moveScreen: (Int) -> Void
    private let cells: [(CompactWindowPlacement, String, String)] = [
        (.left, "rectangle.lefthalf.filled", "左半屏"), (.right, "rectangle.righthalf.filled", "右半屏"),
        (.top, "rectangle.tophalf.filled", "上半屏"), (.bottom, "rectangle.bottomhalf.filled", "下半屏"),
        (.topLeft, "rectangle.topleft.filled", "左上角"), (.topRight, "rectangle.topright.filled", "右上角"),
        (.bottomLeft, "rectangle.bottomleft.filled", "左下角"), (.bottomRight, "rectangle.bottomright.filled", "右下角")]
    private func placementIcon(_ placement: CompactWindowPlacement) -> some View {
        let region = placement.frame(in: NSRect(x: 0, y: 0, width: 24, height: 16))
        return ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 3).strokeBorder(.primary, lineWidth: 1.5).frame(width: 30, height: 22)
            Rectangle().fill(.primary.opacity(0.8))
                .frame(width: region.width, height: region.height)
                .offset(x: 3 + region.minX, y: 3 + 16 - region.maxY)
        }.frame(width: 30, height: 22)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("移动与调整大小")).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                ForEach(cells.indices, id: \.self) { index in
                    Button { place(cells[index].0) } label: {
                        placementIcon(cells[index].0).frame(width: 46, height: 34)
                    }.buttonStyle(.borderless).help(L10n(cells[index].2)).accessibilityLabel(L10n(cells[index].2))
                }
            }
            Divider()
            HStack {
                Button(L10n("填满窗口"), systemImage: "rectangle.fill") { place(.fill) }
                Spacer()
                Button(L10n("还原大小"), action: restore)
            }.buttonStyle(.borderless)
            Divider()
            Button(L10n("全屏幕"), systemImage: "arrow.up.left.and.arrow.down.right", action: fullscreen).buttonStyle(.borderless)
            if screens.count > 1 {
                Divider()
                Menu(L10n("移到其他屏幕")) {
                    ForEach(screens.indices, id: \.self) { index in Button(screens[index]) { moveScreen(index) } }
                }.menuStyle(.borderlessButton)
            }
        }.padding(16).frame(width: 280)
    }
}
