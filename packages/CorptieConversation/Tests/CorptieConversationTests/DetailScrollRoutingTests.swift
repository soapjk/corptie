#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import CorptieConversation

@MainActor struct DetailScrollRoutingTests {
    @Test func inactiveCardsScrollRailAndActivationTransfersExclusively() throws {
        let fixture = Fixture()
        defer { fixture.close() }
        let wheelA = try fixture.event(.scrollWheel, at: CGPoint(x: 70, y: 90))
        #expect(fixture.router.route(wheelA) == nil)
        #expect(fixture.outer.wheels == 1 && fixture.innerA.wheels == 0)
        let clickA = try fixture.event(.leftMouseDown, at: CGPoint(x: 18, y: 55))
        #expect(fixture.router.route(clickA) === clickA)
        #expect(fixture.router.activeID == fixture.cardA.id)
        #expect(fixture.cardA.isActive && !fixture.cardB.isActive)
        #expect(fixture.router.route(wheelA) == nil)
        #expect(fixture.innerA.wheels == 1 && fixture.outer.wheels == 1)
        _ = fixture.router.route(try fixture.event(.leftMouseDown, at: CGPoint(x: 18, y: 275)))
        #expect(fixture.router.activeID == fixture.cardB.id)
        #expect(!fixture.cardA.isActive && fixture.cardB.isActive)
        _ = fixture.router.route(wheelA)
        #expect(fixture.outer.wheels == 2 && fixture.innerA.wheels == 1)
        _ = fixture.router.route(try fixture.event(.leftMouseDown, at: CGPoint(x: 310, y: 490)))
        #expect(fixture.router.activeID == nil)
    }

    @Test func controlsAndSelectableTextActivateWithoutConsumingTheirClicks() throws {
        let fixture = Fixture()
        defer { fixture.close() }
        let button = NSButton(title: "操作", target: nil, action: nil)
        button.frame = CGRect(x: 10, y: 10, width: 80, height: 28)
        fixture.innerA.documentView!.addSubview(button)
        let location = fixture.document.convert(CGPoint(x: button.bounds.midX, y: button.bounds.midY), from: button)
        let event = try fixture.event(.leftMouseDown, at: location)
        #expect(fixture.router.route(event) === event)
        #expect(fixture.router.activeID == fixture.cardA.id)
        fixture.router.activate(nil)
        let text = NSTextView(frame: CGRect(x: 10, y: 50, width: 120, height: 30))
        text.string = "可选择的记忆正文"
        text.isEditable = false
        fixture.innerA.documentView!.addSubview(text)
        let textPoint = fixture.document.convert(CGPoint(x: 10, y: 10), from: text)
        let textEvent = try fixture.event(.leftMouseDown, at: textPoint)
        #expect(fixture.router.route(textEvent) === textEvent)
        #expect(fixture.router.activeID == fixture.cardA.id)
    }

    @Test func nestedIndicatorsAreThinOverlayAndReconfigurationKeepsTheirIdentity() throws {
        let fixture = Fixture()
        defer { fixture.close() }
        let scroller = try #require(fixture.innerA.verticalScroller as? DetailThinScroller)
        #expect(fixture.innerA.scrollerStyle == .overlay)
        #expect(fixture.innerA.autohidesScrollers)
        #expect(DetailThinScroller.scrollerWidth(for: .regular, scrollerStyle: .overlay) == 8)
        for _ in 0..<20 { fixture.router.refreshScrolls() }
        #expect(fixture.innerA.verticalScroller === scroller)
        fixture.router.activate(fixture.cardA.id)
        fixture.router.unregister(fixture.cardA)
        #expect(fixture.router.activeID == nil)
        fixture.router.stop()
    }

    @Test func momentumKeepsOriginalScrollOwnerEvenAfterPointerLeavesCard() throws {
        let fixture = Fixture()
        defer { fixture.close() }
        fixture.router.activate(fixture.cardA.id)
        let wheel = try #require(try fixture.event(.scrollWheel, at: CGPoint(x: 70, y: 90)) as? Wheel)
        wheel.eventPhase = .began
        _ = fixture.router.route(wheel)
        wheel.eventPhase = .ended
        _ = fixture.router.route(wheel)
        wheel.point = fixture.document.convert(CGPoint(x: 70, y: 310), to: nil)
        wheel.eventPhase = []
        wheel.eventMomentum = .began
        _ = fixture.router.route(wheel)
        wheel.eventMomentum = .ended
        _ = fixture.router.route(wheel)
        #expect(fixture.innerA.wheels == 4 && fixture.innerB.wheels == 0 && fixture.outer.wheels == 0)
        wheel.eventMomentum = []
        _ = fixture.router.route(wheel)
        #expect(fixture.outer.wheels == 1)
    }

    @Test func allModuleSurfacesRegisterInDashboardWithoutChangingTheirFramesOnActivation() async throws {
        let host = NSHostingView(rootView: ConversationDetailDashboard {
            ForEach(0..<3) { index in
                ConversationDetailModuleCard(title: "卡片 \(index)", systemImage: "list.bullet") {
                    ConversationDetailBoundedScroll {
                        VStack { ForEach(0..<15) { Text("条目 \($0)") } }
                    }
                    Button("操作") {}
                }
            }
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 320, height: 700),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(60))
        func cards(_ view: NSView) -> [DetailCardProbe.View] {
            if let card = view as? DetailCardProbe.View { return [card] }
            return view.subviews.flatMap(cards)
        }
        let registered = cards(host)
        #expect(registered.count == 3)
        let frames = registered.map(\.frame)
        let first = try #require(registered.first)
        for card in registered {
            #expect(card.router === first.router)
            card.router.activate(card.id)
            #expect(registered.filter(\.isActive).count == 1)
        }
        host.layoutSubtreeIfNeeded()
        #expect(registered.map(\.frame) == frames)
    }

    @Test func swiftUIButtonClickActivatesItsCardAndPassesThrough() async throws {
        let host = NSHostingView(rootView: ConversationDetailDashboard {
            ConversationDetailModuleCard(title: "记忆", systemImage: "list.bullet") {
                Button("立即操作") {}.buttonStyle(.plain)
                    .background(ButtonBoundsProbe())
                Color.clear.frame(height: 80)
            }
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 320, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        func findCard(_ view: NSView) -> DetailCardProbe.View? {
            if let card = view as? DetailCardProbe.View { return card }
            return view.subviews.compactMap(findCard).first
        }
        func findBounds(_ view: NSView) -> NSView? {
            if view.identifier?.rawValue == "button-bounds" { return view }
            for child in view.subviews { if let found = findBounds(child) { return found } }
            return nil
        }
        let card = try #require(findCard(host))
        let bounds = try #require(findBounds(host))
        let location = bounds.convert(CGPoint(x: bounds.bounds.midX, y: bounds.bounds.midY), to: nil)
        let event = try #require(NSEvent.mouseEvent(with: .leftMouseDown,
            location: location,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1))
        #expect(card.router.route(event) === event)
        #expect(card.router.activeID == card.id)
        #expect(card.isActive)
    }

    private final class FlippedView: NSView { override var isFlipped: Bool { true } }
    private struct ButtonBoundsProbe: NSViewRepresentable {
        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            view.identifier = .init("button-bounds")
            return view
        }
        func updateNSView(_ view: NSView, context: Context) {}
    }
    private final class CountingScroll: NSScrollView {
        var wheels = 0
        override func scrollWheel(with event: NSEvent) { wheels += 1 }
    }
    private final class Wheel: NSEvent {
        weak var owner: NSWindow?
        var point = CGPoint.zero
        var eventPhase = NSEvent.Phase()
        var eventMomentum = NSEvent.Phase()
        override var type: NSEvent.EventType { .scrollWheel }
        override var window: NSWindow? { owner }
        override var locationInWindow: NSPoint { point }
        override var phase: NSEvent.Phase { eventPhase }
        override var momentumPhase: NSEvent.Phase { eventMomentum }
    }
    @MainActor private final class Fixture {
        let router = DetailScrollRouter()
        let window: NSWindow
        let outer = CountingScroll(frame: CGRect(x: 0, y: 0, width: 320, height: 500))
        let document = FlippedView(frame: CGRect(x: 0, y: 0, width: 320, height: 1400))
        let innerA = CountingScroll(frame: CGRect(x: 28, y: 70, width: 264, height: 120))
        let innerB = CountingScroll(frame: CGRect(x: 28, y: 290, width: 264, height: 120))
        let cardA: DetailCardProbe.View
        let cardB: DetailCardProbe.View
        let rail: DetailRailProbe.View
        init() {
            cardA = DetailCardProbe.View(router: router, id: UUID())
            cardB = DetailCardProbe.View(router: router, id: UUID())
            rail = DetailRailProbe.View(router: router)
            window = NSWindow(contentRect: outer.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            outer.documentView = document
            window.contentView = outer
            for inner in [innerA, innerB] {
                inner.hasVerticalScroller = true
                inner.documentView = FlippedView(frame: CGRect(x: 0, y: 0, width: 264, height: 800))
                document.addSubview(inner)
            }
            cardA.frame = CGRect(x: 12, y: 40, width: 296, height: 180)
            cardB.frame = CGRect(x: 12, y: 260, width: 296, height: 180)
            document.addSubview(cardA)
            document.addSubview(cardB)
            rail.frame = document.bounds
            document.addSubview(rail)
            window.orderFront(nil)
            outer.layoutSubtreeIfNeeded()
            router.attach(rail)
            router.refreshScrolls()
        }
        func event(_ type: NSEvent.EventType, at point: CGPoint) throws -> NSEvent {
            let location = document.convert(point, to: nil)
            if type == .scrollWheel {
                let event = Wheel()
                event.owner = window
                event.point = location
                return event
            }
            return try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        }
        func close() { router.stop(); window.contentView = nil; window.close() }
    }
}
#endif
