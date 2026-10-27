import SwiftUI

#if os(macOS)
import AppKit

private struct DetailScrollRoutingKey: EnvironmentKey {
    static let defaultValue: DetailScrollRouter? = nil
}

extension EnvironmentValues {
    var detailScrollRouter: DetailScrollRouter? {
        get { self[DetailScrollRoutingKey.self] }
        set { self[DetailScrollRoutingKey.self] = newValue }
    }
}

/// One event monitor per attached rail. Activation only redraws the two affected
/// borders; wheel events do not publish SwiftUI state or remeasure card content.
@MainActor final class DetailScrollRouter {
    weak var rail: DetailRailProbe.View?
    private let cards = NSHashTable<DetailCardProbe.View>.weakObjects()
    private var scrolls: [WeakScroll] = []
    private var monitor: Any?
    private var refreshScheduled = false
    private(set) var activeID: UUID?
    private weak var gestureTarget: NSScrollView?

    private struct WeakScroll { weak var view: NSScrollView? }

    func attach(_ rail: DetailRailProbe.View) {
        stop()
        self.rail = rail
        guard rail.window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .scrollWheel]) { [weak self] event in
            guard let self else { return event }
            return self.route(event)
        }
        scheduleRefresh()
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        gestureTarget = nil
        activate(nil)
        scrolls.removeAll()
    }

    func register(_ card: DetailCardProbe.View) {
        cards.add(card)
        card.isActive = card.id == activeID
        scheduleRefresh()
    }

    func unregister(_ card: DetailCardProbe.View) {
        if activeID == card.id { activate(nil) }
        cards.remove(card)
    }

    func activate(_ id: UUID?) {
        guard activeID != id else { return }
        let previous = activeID
        activeID = id
        for card in cards.allObjects where card.id == previous || card.id == id {
            card.isActive = card.id == id
        }
    }

    func scheduleRefresh() {
        guard !refreshScheduled else { return }
        refreshScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.refreshScheduled = false
            self.refreshScrolls()
        }
    }

    func refreshScrolls() {
        guard let outer = rail?.enclosingScrollView, let document = outer.documentView else { return }
        var found: [WeakScroll] = []
        func configure(_ scroll: NSScrollView) {
            if scroll.scrollerStyle != .overlay { scroll.scrollerStyle = .overlay }
            if !scroll.autohidesScrollers { scroll.autohidesScrollers = true }
            if scroll.hasVerticalScroller, !(scroll.verticalScroller is DetailThinScroller) {
                scroll.verticalScroller = DetailThinScroller()
            }
            if scroll.hasHorizontalScroller, !(scroll.horizontalScroller is DetailThinScroller) {
                scroll.horizontalScroller = DetailThinScroller()
            }
        }
        configure(outer)
        func visit(_ view: NSView) {
            if let scroll = view as? NSScrollView {
                found.append(WeakScroll(view: scroll))
                configure(scroll)
            }
            for child in view.subviews { visit(child) }
        }
        visit(document)
        scrolls = found
    }

    private func contains(_ view: NSView, event: NSEvent) -> Bool {
        let point = view.convert(event.locationInWindow, from: nil)
        return view.window === event.window && !view.isHiddenOrHasHiddenAncestor
            && view.bounds.contains(point) && view.visibleRect.contains(point)
    }

    private func card(at event: NSEvent) -> DetailCardProbe.View? {
        cards.allObjects.filter { contains($0, event: event) }.min {
            $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height
        }
    }

    func route(_ event: NSEvent) -> NSEvent? {
        guard let rail, rail.window === event.window, let outer = rail.enclosingScrollView,
              !rail.isHiddenOrHasHiddenAncestor else { return event }
        if event.type == .leftMouseDown {
            gestureTarget = nil
            // Activate on mouse-down, then deliver the same event unchanged so
            // buttons, links and text selection keep their ordinary first click.
            activate(card(at: event)?.id)
            return event
        }
        guard event.type == .scrollWheel else { return event }
        if event.phase.contains(.began) || event.phase.contains(.mayBegin)
            || (event.phase.isEmpty && event.momentumPhase.isEmpty) { gestureTarget = nil }
        let target: NSScrollView
        if let latched = gestureTarget {
            target = latched
        } else {
            guard let card = card(at: event) else { return event }
            if activeID == card.id {
                let inner = scrolls.compactMap(\.view).filter {
                    card.bounds.insetBy(dx: -0.5, dy: -0.5).contains(card.convert($0.bounds, from: $0))
                }
                target = inner.last(where: { contains($0, event: event) }) ?? inner.first ?? outer
            } else { target = outer }
            if !event.phase.isEmpty || !event.momentumPhase.isEmpty { gestureTarget = target }
        }
        target.scrollWheel(with: event)
        if event.phase.contains(.cancelled) || event.momentumPhase.contains(.ended) {
            gestureTarget = nil
        }
        return nil
    }
}

final class DetailThinScroller: NSScroller {
    override var isOpaque: Bool { false }
    override class var isCompatibleWithOverlayScrollers: Bool { true }
    override class func scrollerWidth(for controlSize: NSControl.ControlSize, scrollerStyle: NSScroller.Style) -> CGFloat {
        scrollerStyle == .overlay ? 8 : super.scrollerWidth(for: controlSize, scrollerStyle: scrollerStyle)
    }
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}
    override func draw(_ dirtyRect: NSRect) { drawKnob() }
    override func drawKnob() {
        guard isEnabled, knobProportion < 1 else { return }
        let native = rect(for: .knob)
        guard !native.isEmpty else { return }
        let vertical = bounds.height >= bounds.width
        let knob = vertical
            ? CGRect(x: native.midX - 1.5, y: native.minY, width: 3, height: native.height)
            : CGRect(x: native.minX, y: native.midY - 1.5, width: native.width, height: 3)
        NSColor.secondaryLabelColor.withAlphaComponent(0.55).setFill()
        NSBezierPath(roundedRect: knob, xRadius: 1.5, yRadius: 1.5).fill()
    }
}

struct DetailRailProbe: NSViewRepresentable {
    let router: DetailScrollRouter
    func makeNSView(context: Context) -> View { View(router: router) }
    func updateNSView(_ view: View, context: Context) { router.scheduleRefresh() }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.router.stop() }
    final class View: NSView {
        let router: DetailScrollRouter
        private var lastSize = CGSize.zero
        init(router: DetailScrollRouter) { self.router = router; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); router.attach(self) }
        override func layout() {
            super.layout()
            if bounds.size != lastSize { lastSize = bounds.size; router.scheduleRefresh() }
        }
    }
}

struct DetailCardProbe: NSViewRepresentable {
    let router: DetailScrollRouter
    let id: UUID
    var reordering: DetailCardReorderController? = nil
    var cardID: String? = nil
    func makeNSView(context: Context) -> View { View(router: router, id: id) }
    func updateNSView(_ view: View, context: Context) {
        router.scheduleRefresh()
        if let cardID { reordering?.register(view, id: cardID) }
    }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.router.unregister(view) }
    final class View: NSView {
        let router: DetailScrollRouter
        let id: UUID
        private var lastSize = CGSize.zero
        var isActive = false { didSet { if oldValue != isActive { needsDisplay = true } } }
        init(router: DetailScrollRouter, id: UUID) {
            self.router = router; self.id = id; super.init(frame: .zero)
            setAccessibilityElement(false)
        }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { router.unregister(self) } else { router.register(self) }
        }
        override func layout() {
            super.layout()
            if bounds.size != lastSize { lastSize = bounds.size; router.scheduleRefresh() }
        }
        override func draw(_ dirtyRect: NSRect) {
            guard isActive else { return }
            NSColor.controlAccentColor.withAlphaComponent(0.65).setStroke()
            let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 18, yRadius: 18)
            border.lineWidth = 1
            border.stroke()
        }
    }
}

struct DetailCardScrollActivation: ViewModifier {
    @Environment(\.detailScrollRouter) private var router
    @Environment(\.detailCardReorderController) private var reordering
    @Environment(\.detailCardDrag) private var cardDrag
    @State private var id = UUID()
    func body(content: Content) -> some View {
        if let router {
            content
                .overlay { DetailCardProbe(router: router, id: id, reordering: reordering, cardID: cardDrag?.cardID).accessibilityHidden(true) }
                .accessibilityAction(named: Text("激活卡片滚动")) { router.activate(id) }
        } else { content }
    }
}
#endif
