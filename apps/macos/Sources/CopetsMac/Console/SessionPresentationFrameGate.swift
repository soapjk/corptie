import AppKit
import QuartzCore

/// Gives an already mounted native view a display opportunity before UI activation.
/// Neither display-link ticks nor run-loop callbacks certify physical presentation.
@MainActor
final class SessionPresentationFrameGate: NSObject {
    enum Outcome: Equatable { case displayOpportunity, timedOut }

    /// CADisplayLink retains its target; the relay must not retain this gate.
    @MainActor private final class Relay: NSObject {
        weak var owner: SessionPresentationFrameGate?
        @objc func tick(_ link: CADisplayLink) { owner?.receive(link) }
    }

    private let relay = Relay()
    private let timeout: TimeInterval
    private let automaticallySchedules: Bool
    private let isVisible: @MainActor (NSView) -> Bool
    private weak var target: NSView?
    private var link: CADisplayLink?
    private var observer: CFRunLoopObserver?
    private var deadline: DispatchWorkItem?
    private var completion: (@MainActor (Outcome) -> Void)?
    private var epoch: UInt64 = 0
    private var didCommit = false
    private var firstTick: CFTimeInterval?
    private var deliveryQueued = false
    private var requiresNativeDraw = false
    private var nativeDrawTimestamp: CFTimeInterval?
    private var remainingRefreshIntervals = 1
    private(set) var isArmed = false

    init(timeout: TimeInterval = 0.25, automaticallySchedules: Bool = true,
         isVisible: @escaping @MainActor (NSView) -> Bool = {
             !$0.isHiddenOrHasHiddenAncestor && $0.window?.isVisible == true
                 && $0.window?.occlusionState.contains(.visible) == true
         }) {
        self.timeout = timeout
        self.automaticallySchedules = automaticallySchedules
        self.isVisible = isVisible
        super.init()
        relay.owner = self
    }

    isolated deinit {
        link?.invalidate()
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        deadline?.cancel()
    }

    @discardableResult
    func arm(view: NSView, afterNativeDraw: Bool = false, minimumRefreshIntervals: Int? = nil, completion: @escaping @MainActor (Outcome) -> Void) -> Bool {
        cancel()
        guard isVisible(view) else { return false }
        target = view
        self.completion = completion
        requiresNativeDraw = afterNativeDraw
        // A native draw submission still travels through the compositor. For
        // the opening-page proof leave two complete refresh intervals after
        // its first post-draw tick, rather than starting work on that tick.
        remainingRefreshIntervals = max(afterNativeDraw ? 2 : 1, minimumRefreshIntervals ?? 0)
        isArmed = true
        guard automaticallySchedules else { return true }
        let requestedEpoch = epoch
        if !afterNativeDraw { observeNextCommit(epoch: requestedEpoch) }
        let displayLink = view.displayLink(target: relay, selector: #selector(Relay.tick(_:)))
        link = displayLink
        displayLink.add(to: .main, forMode: .common)
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.epoch == requestedEpoch else { return }
            self.timeoutExpired()
        }
        deadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
        return true
    }

    func cancel() {
        epoch &+= 1
        isArmed = false
        completion = nil
        target = nil
        didCommit = false
        firstTick = nil
        deliveryQueued = false
        requiresNativeDraw = false
        nativeDrawTimestamp = nil
        link?.invalidate(); link = nil
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observer = nil
        deadline?.cancel(); deadline = nil
    }

    // Internal signal methods also allow deterministic protocol tests. They
    // are not evidence that an operating-system frame reached the display.
    func runLoopDidCommit() { if isArmed { didCommit = true } }

    private func observeNextCommit(epoch requestedEpoch: UInt64) {
        // Use the end of this phase, not an early observer that can run before
        // AppKit prepares the new native surface. This remains a scheduling
        // boundary, not an acknowledgement from the window compositor.
        observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, CFIndex.max) { [weak self] _, _ in
            Task { @MainActor [weak self] in
                guard let self, self.epoch == requestedEpoch else { return }
                self.runLoopDidCommit()
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }

    /// AppKit has started drawing this request's native opening surface. The
    /// display-link timestamp denotes the previous refresh, so ignore ticks
    /// older than this draw submission before counting display opportunities.
    func nativeDrawPrepared(at timestamp: CFTimeInterval = CACurrentMediaTime()) {
        guard isArmed, nativeDrawTimestamp == nil else { return }
        nativeDrawTimestamp = timestamp
        firstTick = nil
        if requiresNativeDraw {
            didCommit = false
            if automaticallySchedules { observeNextCommit(epoch: epoch) }
        }
    }

    private func receive(_ source: CADisplayLink) {
        guard source === link else { return }
        displayTick(timestamp: source.timestamp)
    }

    func displayTick(timestamp: CFTimeInterval) {
        guard isArmed, didCommit, !deliveryQueued, timestamp.isFinite, timestamp > 0,
              let target, isVisible(target) else { return }
        if requiresNativeDraw {
            guard let nativeDrawTimestamp, timestamp > nativeDrawTimestamp else { return }
        }
        guard let firstTick else { self.firstTick = timestamp; return }
        guard timestamp > firstTick else { return }
        if remainingRefreshIntervals > 1 {
            remainingRefreshIntervals -= 1
            self.firstTick = timestamp
            return
        }
        deliveryQueued = true
        let requestedEpoch = epoch
        DispatchQueue.main.async { [weak self] in
            guard let self, self.epoch == requestedEpoch else { return }
            self.finish(.displayOpportunity)
        }
    }

    func timeoutExpired() { finish(.timedOut) }

    private func finish(_ outcome: Outcome) {
        guard isArmed else { return }
        guard let target, isVisible(target) else { cancel(); return }
        let callback = completion
        cancel()
        callback?(outcome)
    }
}
