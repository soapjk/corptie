import AppKit

/// Reuses the transcript's complete capsule and cancellable idle fade, with
/// the Work column's narrower 3-point drawing and the system's original lane.
final class WorkOutlineThinScroller: TimelineIntentScroller {
    override var paintedKnobWidth: CGFloat { 3 }
    override var knobTrailingInset: CGFloat? { nil }
    override var knobColor: NSColor { .secondaryLabelColor.withAlphaComponent(0.55) }
    override class func scrollerWidth(for size: NSControl.ControlSize, scrollerStyle: NSScroller.Style) -> CGFloat {
        NSScroller.scrollerWidth(for: size, scrollerStyle: scrollerStyle)
    }
    private weak var observedClip: NSClipView?
    private weak var scrollOwner: NSScrollView?
    private var boundsObservation: NSObjectProtocol?
    private var pendingActivity: DispatchWorkItem?
    private var lastOrigin: NSPoint?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil && scrollOwner?.window == nil { unbindScrollActivity() }
        else { bindScrollActivity() }
    }
    func bindScrollActivity(to scroll: NSScrollView? = nil) {
        if let scroll { scrollOwner = scroll }
        guard let clip = (scrollOwner ?? enclosingScrollView)?.contentView, clip !== observedClip else { return }
        unbindScrollActivity()
        observedClip = clip
        lastOrigin = clip.bounds.origin
        clip.postsBoundsChangedNotifications = true
        boundsObservation = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification,
            object: clip, queue: .main) { [weak self, weak clip] _ in
                MainActor.assumeIsolated {
                    guard let self, let clip, clip.bounds.origin != self.lastOrigin else { return }
                    self.lastOrigin = clip.bounds.origin
                    self.scheduleActivity()
                }
            }
    }
    private func scheduleActivity() {
        guard pendingActivity == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingActivity = nil
            guard (self.scrollOwner?.window ?? self.window) != nil else { return }
            self.scrollOwner?.flashScrollers()
            self.beginScrollInteraction()
            self.endScrollInteraction()
            self.needsDisplay = true
        }
        pendingActivity = work
        DispatchQueue.main.async(execute: work)
    }
    private func unbindScrollActivity() {
        if let boundsObservation { NotificationCenter.default.removeObserver(boundsObservation) }
        boundsObservation = nil; observedClip = nil
        pendingActivity?.cancel(); pendingActivity = nil
        lastOrigin = nil
    }
    isolated deinit {
        if let boundsObservation { NotificationCenter.default.removeObserver(boundsObservation) }
    }
}
