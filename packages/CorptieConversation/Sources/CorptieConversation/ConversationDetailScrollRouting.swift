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
    private let scrolls = NSHashTable<NSScrollView>.weakObjects()
    private var monitor: Any?
    private(set) var activeID: UUID?
    private weak var gestureTarget: NSScrollView?


    func attach(_ rail: DetailRailProbe.View) {
        guard self.rail !== rail || monitor == nil else { return }
        stop()
        self.rail = rail
        guard rail.window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .scrollWheel]) { [weak self] event in
            guard let self else { return event }
            return self.route(event)
        }
        if let outer = rail.enclosingScrollView { configure(outer) }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        gestureTarget = nil
        activate(nil)
    }

    func register(_ card: DetailCardProbe.View) {
        cards.add(card)
        card.isActive = card.id == activeID
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

    func register(_ scroll: NSScrollView) {
        scrolls.add(scroll)
        configure(scroll)
    }
    func unregister(_ scroll: NSScrollView) { scrolls.remove(scroll) }

    private func configure(_ scroll: NSScrollView) {
        if scroll.scrollerStyle != .overlay { scroll.scrollerStyle = .overlay }
        if !scroll.autohidesScrollers { scroll.autohidesScrollers = true }
        if scroll.verticalScroller?.controlSize != .small { scroll.verticalScroller?.controlSize = .small }
        if scroll.horizontalScroller?.controlSize != .small { scroll.horizontalScroller?.controlSize = .small }
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
                let inner = scrolls.allObjects.filter {
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

struct DetailRailProbe: NSViewRepresentable {
    let router: DetailScrollRouter
    func makeNSView(context: Context) -> View { View(router: router) }
    func updateNSView(_ view: View, context: Context) { if view.window != nil { router.attach(view) } }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.router.stop() }
    final class View: NSView {
        let router: DetailScrollRouter
        init(router: DetailScrollRouter) { self.router = router; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); router.attach(self) }
    }
}

struct DetailScrollOwnerRegistration: ViewModifier {
    @Environment(\.detailScrollRouter) private var router
    func body(content: Content) -> some View {
        content.background {
            if let router { DetailScrollOwnerProbe(router: router) }
        }
    }
}

private struct DetailScrollOwnerProbe: NSViewRepresentable {
    let router: DetailScrollRouter
    func makeNSView(context: Context) -> View { View(router: router) }
    func updateNSView(_ view: View, context: Context) { view.attach() }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.detach() }
    final class View: NSView {
        let router: DetailScrollRouter
        private weak var owner: NSScrollView?
        init(router: DetailScrollRouter) { self.router = router; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { detach() } else { attach() }
        }
        func attach() {
            let next = enclosingScrollView
            if owner !== next { detach(); owner = next }
            if let owner { router.register(owner) }
        }
        func detach() { if let owner { router.unregister(owner) }; owner = nil }
    }
}

struct DetailCardProbe: NSViewRepresentable {
    let router: DetailScrollRouter
    let id: UUID
    var reordering: DetailCardReorderController? = nil
    var cardID: String? = nil
    func makeNSView(context: Context) -> View { View(router: router, id: id) }
    func updateNSView(_ view: View, context: Context) {
        if let cardID { reordering?.register(view, id: cardID) }
    }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.router.unregister(view) }
    final class View: NSView {
        let router: DetailScrollRouter
        let id: UUID
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
