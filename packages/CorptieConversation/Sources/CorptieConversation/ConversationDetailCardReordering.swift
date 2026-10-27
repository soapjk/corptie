#if os(macOS)
import AppKit
import SwiftUI
import Observation

/// A presentation-only permutation. The existing arrangement owns persistence;
/// it receives one move on release and nothing on hover or cancellation.
struct DetailCardReorderDraft: Equatable {
    let source: String
    private(set) var order: [String]

    init?(source: String, order: [String]) {
        guard order.contains(source) else { return nil }
        self.source = source; self.order = order
    }

    mutating func reconcile(_ ids: [String]) -> Bool {
        guard ids.contains(source) else { return false }
        order = order.filter { ids.contains($0) } + ids.filter { !order.contains($0) }
        return true
    }

    mutating func insert(at target: String?) {
        guard target != source else { return }
        if let target, !order.contains(target) { return }
        order.removeAll { $0 == source }
        order.insert(source, at: target.flatMap { order.firstIndex(of: $0) } ?? order.endIndex)
    }

    var successor: String? { order.dropFirst((order.firstIndex(of: source) ?? order.count) + 1).first }
}

@MainActor @Observable final class DetailCardReorderPreview {
    var image: NSImage?
    var frame = CGRect.zero
    func clear() { image = nil; frame = .zero }
}

/// Cursor movement publishes only to Preview. Card content is invalidated only
/// when the insertion slot changes. Native probes and timers are drag-scoped.
@MainActor @Observable final class DetailCardReorderController {
    struct Item: Equatable { let id: String; let size: DetailWidgetSize }
    struct Input: Equatable { let scope: [String]; let enabled: Bool; let items: [Item] }
    private(set) var draft: DetailCardReorderDraft?
    let preview = DetailCardReorderPreview()
    @ObservationIgnored private var input = Input(scope: [], enabled: false, items: [])
    @ObservationIgnored private var commit: ((String, String?) -> Void)?
    @ObservationIgnored private weak var container: NSView?
    @ObservationIgnored private var cards = NSMapTable<NSString, NSView>.strongToWeakObjects()
    @ObservationIgnored private var frames: [String: CGRect] = [:]
    @ObservationIgnored private var pointerOffset = CGPoint.zero
    @ObservationIgnored private var lastRetarget = -Double.infinity
    @ObservationIgnored private var settling = false
    @ObservationIgnored private var epoch: UInt64 = 0
    @ObservationIgnored private var escapeMonitor: Any?
    @ObservationIgnored private var deactivationObserver: NSObjectProtocol?
    @ObservationIgnored private var scrollTimer: Timer?

    func synchronize(_ value: Input, commit: @escaping (String, String?) -> Void) {
        if value.scope != input.scope || !value.enabled { cancel() }
        input = value; self.commit = commit
        for case let id as NSString in cards.keyEnumerator().allObjects where !value.items.contains(where: { $0.id == id as String }) {
            cards.removeObject(forKey: id)
        }
        if var draft {
            if draft.reconcile(value.items.map(\.id)) { self.draft = draft }
            else { cancel() }
        }
        updateFrames()
    }

    func attach(_ view: NSView) { container = view; updateFrames() }
    func detach(_ view: NSView) {
        guard container === view else { return }
        cancel(); container = nil
    }
    func register(_ view: NSView, id: String) { cards.setObject(view, forKey: id as NSString) }

    func displayOrder(_ ids: [String]) -> [String] {
        guard let draft else { return ids }
        return draft.order.filter { ids.contains($0) } + ids.filter { !draft.order.contains($0) }
    }

    private func updateFrames() {
        guard let container else { return }
        let ids = displayOrder(input.items.map(\.id))
        let sizes = ids.compactMap { id in input.items.first { $0.id == id }?.size }
        let placement = DetailWidgetPlacement.make(width: container.bounds.width, widgets: sizes)
        frames = Dictionary(uniqueKeysWithValues: zip(ids, placement.frames))
    }

    func begin(_ id: String, at point: CGPoint) {
        guard input.enabled, draft == nil, !settling, let container,
              let card = cards.object(forKey: id as NSString),
              card.window === container.window,
              let root = card.window?.contentView else { return }
        updateFrames()
        guard let frame = frames[id] else { return }
        // Capture once. Hosting another live business card as a floating view
        // would duplicate tasks, observation, scroll owners and editor state.
        let rect = root.convert(card.bounds, from: card)
        guard let bitmap = root.bitmapImageRepForCachingDisplay(in: rect) else { return }
        root.cacheDisplay(in: rect, to: bitmap)
        let image = NSImage(size: frame.size); image.addRepresentation(bitmap)
        preview.image = image; preview.frame = frame
        pointerOffset = CGPoint(x: point.x - frame.minX, y: point.y - frame.minY)
        draft = .init(source: id, order: input.items.map(\.id))
        epoch &+= 1
        lastRetarget = -Double.infinity
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKeyDown(event) == true ? nil : event
        }
        deactivationObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification,
            object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.cancel() } }
        let timer = Timer(timeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoScroll() }
        }
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.add(timer, forMode: .eventTracking)
        scrollTimer = timer
    }

    func move(to point: CGPoint) {
        guard draft != nil, !settling else { return }
        preview.frame.origin = CGPoint(x: point.x - pointerOffset.x, y: point.y - pointerOffset.y)
        guard var next = draft, let own = frames[next.source], !own.contains(point),
              ProcessInfo.processInfo.systemUptime - lastRetarget > 0.15 else { return }
        let candidate = next.order.first { id in id != next.source && frames[id]?.contains(point) == true }
        if let candidate, let from = next.order.firstIndex(of: next.source), let to = next.order.firstIndex(of: candidate) {
            if let target = frames[candidate], abs(target.minX - own.minX) < 1 {
                let depth = min(24, target.height * 0.2)
                guard from < to ? point.y >= target.minY + depth : point.y <= target.maxY - depth else { return }
            }
            next.insert(at: from < to ? next.order.dropFirst(to + 1).first : candidate)
        } else if point.y > (frames.values.map(\.maxY).max() ?? 0) { next.insert(at: nil) }
        guard next != draft else { return }
        withAnimation(.easeInOut(duration: 0.16)) { draft = next }
        lastRetarget = ProcessInfo.processInfo.systemUptime
        updateFrames()
    }

    func end(at point: CGPoint) {
        guard let draft, !settling else { return }
        guard input.enabled, viewport.contains(point), input.items.contains(where: { $0.id == draft.source }) else { cancel(); return }
        stopTracking(); settling = true
        let endingEpoch = epoch
        if draft.order != input.items.map(\.id) { commit?(draft.source, draft.successor) }
        let target = frames[draft.source] ?? preview.frame
        withAnimation(.easeOut(duration: 0.16)) { preview.frame = target } completion: { [weak self] in
            guard let self, self.epoch == endingEpoch else { return }
            self.cancel()
        }
    }

    func cancel() {
        stopTracking()
        epoch &+= 1
        settling = false
        draft = nil; preview.clear()
        updateFrames()
    }

    func cancelGesture(for id: String) {
        if draft?.source == id && !settling { cancel() }
    }

    func handleKeyDown(_ event: NSEvent) -> Bool {
        guard draft != nil, let window = container?.window, event.keyCode == 53,
              event.window === window || NSApp.keyWindow === window else { return false }
        cancel(); return true
    }

    private func stopTracking() {
        scrollTimer?.invalidate(); scrollTimer = nil
        if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
        escapeMonitor = nil
        if let deactivationObserver { NotificationCenter.default.removeObserver(deactivationObserver) }
        deactivationObserver = nil
    }

    private var viewport: CGRect {
        guard let container else { return .zero }
        let rect = container.visibleRect
        return CGRect(x: rect.minX, y: container.isFlipped ? rect.minY : container.bounds.maxY - rect.maxY,
                      width: rect.width, height: rect.height)
    }

    private func autoScroll() {
        guard draft != nil, !settling, let container, let window = container.window,
              let scroll = container.enclosingScrollView, let document = scroll.documentView else { return }
        let local = container.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        let point = CGPoint(x: local.x, y: container.isFlipped ? local.y : container.bounds.maxY - local.y)
        let visible = viewport
        guard visible.insetBy(dx: 0, dy: -28).contains(point) else { return }
        let delta = point.y < visible.minY + 28 ? -8.0 : point.y > visible.maxY - 28 ? 8.0 : 0
        guard delta != 0 else { return }
        let clip = scroll.contentView
        let current = clip.bounds.origin
        let next = max(0, min(document.bounds.height - clip.bounds.height, current.y + (document.isFlipped ? delta : -delta)))
        guard next != current.y else { return }
        clip.scroll(to: CGPoint(x: current.x, y: next)); scroll.reflectScrolledClipView(clip)
        let updated = container.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        move(to: CGPoint(x: updated.x, y: container.isFlipped ? updated.y : container.bounds.maxY - updated.y))
    }
}

private struct DetailCardReorderControllerKey: EnvironmentKey {
    static let defaultValue: DetailCardReorderController? = nil
}
extension EnvironmentValues {
    var detailCardReorderController: DetailCardReorderController? {
        get { self[DetailCardReorderControllerKey.self] }
        set { self[DetailCardReorderControllerKey.self] = newValue }
    }
}

struct DetailCardReorderHandle: ViewModifier {
    let controller: DetailCardReorderController
    let id: String
    @GestureState private var engaged = false
    @State private var attempted = false
    func body(content: Content) -> some View {
        content.contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 6, coordinateSpace: .named(ObjectIdentifier(controller)))
                .updating($engaged) { _, state, _ in state = true }
                .onChanged { value in
                    if !attempted { attempted = true; controller.begin(id, at: value.startLocation) }
                    guard controller.draft?.source == id else { return }
                    controller.move(to: value.location)
                }
                .onEnded { value in controller.end(at: value.location); attempted = false })
            .onChange(of: engaged) { _, value in
                if !value { attempted = false; controller.cancelGesture(for: id) }
            }
            .accessibilityHint("拖动标题调整卡片顺序，按 Escape 取消")
    }
}

struct DetailCardReorderOverlay: View {
    let preview: DetailCardReorderPreview
    var body: some View {
        if let image = preview.image {
            Image(nsImage: image).resizable()
                .frame(width: preview.frame.width, height: preview.frame.height)
                .shadow(color: .black.opacity(0.18), radius: 5, y: 3)
                .offset(x: preview.frame.minX, y: preview.frame.minY)
                .allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

struct DetailCardReorderContainerProbe: NSViewRepresentable {
    let controller: DetailCardReorderController
    func makeNSView(context: Context) -> View { View(controller: controller) }
    func updateNSView(_ view: View, context: Context) { controller.attach(view) }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.controller.detach(view) }
    final class View: NSView {
        let controller: DetailCardReorderController
        init(controller: DetailCardReorderController) { self.controller = controller; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func layout() { super.layout(); controller.attach(self) }
    }
}
#endif
