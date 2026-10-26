import Observation
import CorptieClientCore

/// Window-local display copies. The original handle remains the sole owner of
/// feeds and commands. Hidden views never observe its mutable card objects.
@MainActor @Observable
public final class ConversationDetailRenderState {
    public let store = ClientDetailBusinessStore()
    public let turn = ClientDetailTurnState()
    public let worktree = ClientDetailWorktreeState()
    public private(set) var legacy = false
    public private(set) var retired = false
    @ObservationIgnored private weak var source: ClientDetailBusinessHandle?
    @ObservationIgnored private var active = false
    @ObservationIgnored private var trackingArmed = false
    @ObservationIgnored private var dirty = true
    @ObservationIgnored private(set) var captureCount = 0
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private var previous: Snapshot?

    private struct Snapshot: Equatable {
        let business: ClientDetailBusinessStore.PresentationSnapshot
        let turn: ClientDetailTurnState.PresentationSnapshot
        let worktree: ClientDetailWorktreeState.PresentationSnapshot
        let legacy: Bool
        let retired: Bool
    }
    public init() {}
    public func resume(from handle: ClientDetailBusinessHandle) {
        guard !retired else { return }
        if let source, source !== handle { retire(); return }
        if source !== handle {
            source = handle; dirty = true
            // Revocation must clear even a frozen page. This is independent
            // of ordinary content tracking, which stops while hidden.
            withObservationTracking { _ = handle.retired } onChange: { [weak self, weak handle] in
                Task { @MainActor in
                    guard let self, let handle, self.source === handle, handle.retired else { return }
                    self.retire()
                }
            }
        }
        guard !handle.retired else { retire(); return }
        guard !active else { return }
        active = true
        // Keep the outstanding one-shot registration across an unchanged
        // freeze/resume. Re-registering on every click accumulates callbacks
        // until the source next mutates, even though the display is unchanged.
        if dirty || !trackingArmed { captureAndTrack() }
    }
    func resumeIfBound() { if let source { resume(from: source) } }
    public func freeze() { active = false }
    public func retire() {
        freeze(); source = nil; previous = nil
        retired = true
        store.fail("访问或绑定已失效", disposition: .accessRevoked)
        turn.retire(); worktree.retire()
    }
    private func captureAndTrack() {
        guard active, !trackingArmed, let source else { return }
        captureCount += 1
        trackingArmed = true
        let value = withObservationTracking {
            Snapshot(business: source.store.makePresentationSnapshot(),
                turn: source.turn.makePresentationSnapshot(),
                worktree: source.worktree.makePresentationSnapshot(),
                legacy: source.legacy, retired: source.retired)
        } onChange: { [weak self, weak source] in
            // Observation calls before mutation. Hop once to capture the
            // completed transaction and coalesce simultaneous field writes.
            Task { @MainActor in
                guard let self, let source, self.source === source else { return }
                self.trackingArmed = false
                self.dirty = true
                guard self.active else { return }
                self.captureAndTrack()
            }
        }
        if value.retired { retire(); return }
        if previous != value {
            store.applyPresentationSnapshot(value.business)
            turn.applyPresentationSnapshot(value.turn)
            worktree.applyPresentationSnapshot(value.worktree)
            if legacy != value.legacy { legacy = value.legacy }
            previous = value; applyCount += 1
        }
        dirty = false
    }
}
