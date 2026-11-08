import AppKit

/// AppKit owns knob drawing, tracking and fading. Work does not need the
/// transcript's mouseDown/reader-intent hooks, or a painted track behind it.
final class WorkOutlineThinScroller: ConsoleThinScroller {
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}
}
