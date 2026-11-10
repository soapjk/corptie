import SwiftUI
#if os(macOS)
import AppKit
import QuartzCore
#endif

/// macOS draws the running title through a Core Animation layer, so the native
/// font weight must be passed explicitly (SwiftUI `Font` has no public NSFont
/// conversion). SwiftUI still owns the layout, wrapping and truncation.
public enum ConsoleWorkTitleWeight: Sendable {
    case regular, medium, semibold

    #if os(macOS)
    var native: NSFont.Weight {
        switch self {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        }
    }
    #endif
}

public enum ConsoleWorkOutlineMetrics {
    public static let childIndent: CGFloat = 24
    public static let groupCornerRadius: CGFloat = 8
    public static let groupHorizontalInset: CGFloat = 6
    public static let disclosureAnimation = Animation.easeInOut(duration: 0.22)
    public static let workingGradientDuration: Double = 2.6
    public static let workingGradientFrameInterval: Double = 1.0 / 24.0
}

public enum WorkActivityAnimation {
    public static let duration = 2.6
    public static let frameInterval = 1.0 / 24.0
}
public enum ConsoleWorkFlowingGradientPolicy {
    public static func progress(at date: Date) -> CGFloat {
        let elapsed = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: WorkActivityAnimation.duration)
        return CGFloat(elapsed / WorkActivityAnimation.duration)
    }
}
/// Shared running-title treatment for Work groups and experimental Task cards.
public struct ConsoleWorkTitle: View {
    public init(title: String, isWorking: Bool, isActive: Bool = true,
                fontSize: CGFloat = 13, weight: ConsoleWorkTitleWeight = .regular) {
        self.title = title
        self.isWorking = isWorking
        self.isActive = isActive
        self.fontSize = fontSize
        self.weight = weight
    }
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    let title: String
    let isWorking: Bool
    var isActive = true
    var fontSize: CGFloat = 13
    var weight: ConsoleWorkTitleWeight = .regular

    public var body: some View {
        if isWorking {
            ConsoleFlowingGradientWorkTitle(
                title: title,
                animates: !accessibilityReduceMotion && isActive,
                fontSize: fontSize,
                weight: weight
            )
        } else {
            Text(title)
        }
    }
}

private struct ConsoleFlowingGradientWorkTitle: View {
    let title: String
    let animates: Bool
    var fontSize: CGFloat = 13
    var weight: ConsoleWorkTitleWeight = .regular
    #if os(iOS)
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false
    #endif

    @ViewBuilder
    var body: some View {
        #if os(iOS)
        // Color the glyphs directly: an overlay/mask must never be the only
        // visible copy of a title in a recycled lazy-list row.
        Text(title)
            .keyframeAnimator(initialValue: CGFloat.zero,
                              repeating: animates && isVisible && scenePhase == .active) { content, phase in
                content.foregroundStyle(LinearGradient(
                    colors: [.cyan, .blue, .purple, .pink, .orange, .cyan,
                             .blue, .purple, .pink, .orange, .cyan],
                    startPoint: UnitPoint(x: phase - 1, y: 0.5),
                    endPoint: UnitPoint(x: phase + 1, y: 0.5)))
            } keyframes: { _ in
                LinearKeyframe(CGFloat(1), duration: WorkActivityAnimation.duration)
            }
            .onAppear { isVisible = true }
            .onDisappear { isVisible = false }
        #else
        // macOS must not own a SwiftUI repeating animation: once started it
        // never stops, and every frame re-evaluates the whole window's
        // attribute graph and layout tree. The flow therefore lives entirely
        // in a Core Animation layer; SwiftUI still owns the text's frame.
        if animates {
            Text(title)
                .foregroundStyle(Color.clear)
                .overlay {
                    WorkTitleFlowLayer(title: title, fontSize: fontSize, weight: weight)
                        .allowsHitTesting(false)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(title)
        } else {
            // Reduce Motion / inactive pages keep the calm, colour-only state.
            Text(title)
                .foregroundStyle(staticGradient)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(title)
        }
        #endif
    }

    private var staticGradient: LinearGradient {
        LinearGradient(
            colors: [.cyan, .blue, .purple, .pink, .orange],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

#if os(macOS)
/// A paint-only Core Animation flow for a running Work title. SwiftUI keeps
/// the Text (font, wrapping, truncation, layout); this overlay fills exactly
/// that frame and paints a moving rainbow through a text-shaped mask.
/// No SwiftUI animation, no Timer, no per-frame attribute-graph work.
struct WorkTitleFlowLayer: NSViewRepresentable {
    let title: String
    let fontSize: CGFloat
    let weight: ConsoleWorkTitleWeight

    func makeNSView(context: Context) -> WorkTitleFlowLayerView {
        let view = WorkTitleFlowLayerView()
        view.configure(title: title, fontSize: fontSize, weight: weight)
        return view
    }

    func updateNSView(_ nsView: WorkTitleFlowLayerView, context: Context) {
        nsView.configure(title: title, fontSize: fontSize, weight: weight)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: WorkTitleFlowLayerView,
        context: Context
    ) -> CGSize? {
        // Never grow the row: the overlay is exactly the base Text's frame.
        guard let width = proposal.width, let height = proposal.height else { return nil }
        return CGSize(width: max(0, width), height: max(0, height))
    }
}

final class WorkTitleFlowLayerView: NSView {
    private enum Key {
        static let flow = "corptie.work-title.flow"
    }

    private let masked = CALayer()
    private let gradient = CAGradientLayer()
    private let textMask = CATextLayer()
    private var title = ""
    private var font = NSFont.systemFont(ofSize: 13, weight: .regular)
    private var renderedWidth: CGFloat = 0
    private weak var observedWindow: NSWindow?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setUp()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUp()
    }

    override var isFlipped: Bool { true }

    /// Diagnostics only: the CA animation must exist for a running title and
    /// its layer clock must be stopped when the view has no visible window.
    var hasFlowAnimation: Bool { gradient.animation(forKey: Key.flow) != nil }
    var isPlaybackPaused: Bool { masked.speed == 0 }

    private func setUp() {
        wantsLayer = true
        layer = CALayer()
        layer?.masksToBounds = true
        masked.masksToBounds = true
        masked.mask = textMask
        masked.addSublayer(gradient)
        layer?.addSublayer(masked)

        textMask.alignmentMode = .left
        textMask.truncationMode = .end
        textMask.isWrapped = true
        textMask.contentsGravity = .center
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        applyPalette()
    }

    /// Two identical colour cycles plus a closing stop: translating the
    /// gradient by exactly one cycle width reproduces the same image, so the
    /// repeating animation has no visible seam.
    private func applyPalette() {
        let cycle: [NSColor] = [.systemTeal, .systemBlue, .systemPurple, .systemPink, .systemOrange]
        let colors = (cycle + cycle + [cycle[0]]).map(\.cgColor)
        gradient.colors = colors
        gradient.locations = (0...10).map { NSNumber(value: Double($0) / 10.0) }
    }

    func configure(title: String, fontSize: CGFloat, weight: ConsoleWorkTitleWeight) {
        let nextFont = NSFont.systemFont(ofSize: fontSize, weight: weight.native)
        let contentChanged = title != self.title
            || nextFont.pointSize != font.pointSize
            || nextFont.fontName != font.fontName
        self.title = title
        self.font = nextFont
        if contentChanged { updateTextMask() }
        layoutLayers()
    }

    private func updateTextMask() {
        let attributed = NSAttributedString(string: title, attributes: [
            .font: font,
            .foregroundColor: NSColor.white
        ])
        textMask.string = attributed
        textMask.contentsScale = window?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor ?? 2
    }

    override func layout() {
        super.layout()
        layoutLayers()
    }

    private func layoutLayers() {
        let width = bounds.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        masked.frame = bounds
        textMask.frame = bounds
        gradient.frame = CGRect(x: -width, y: 0, width: width * 2, height: bounds.height)
        CATransaction.commit()
        guard abs(renderedWidth - width) > 0.5 else { return }
        renderedWidth = width
        refreshAnimation()
    }

    private func refreshAnimation() {
        gradient.removeAnimation(forKey: Key.flow)
        gradient.transform = CATransform3DIdentity
        guard bounds.width > 0 else { return }
        let flow = CABasicAnimation(keyPath: "transform.translation.x")
        flow.fromValue = 0
        flow.toValue = bounds.width
        flow.duration = WorkActivityAnimation.duration
        flow.repeatCount = .infinity
        flow.timingFunction = CAMediaTimingFunction(name: .linear)
        flow.isRemovedOnCompletion = false
        gradient.add(flow, forKey: Key.flow)
        updatePlaybackState()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTextMask()
        observeCurrentWindow()
        updatePlaybackState()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyPalette()
    }

    private func observeCurrentWindow() {
        if let observedWindow {
            NotificationCenter.default.removeObserver(self, name: nil, object: observedWindow)
        }
        observedWindow = window
        guard let window else { return }
        for name in [NSWindow.didChangeOcclusionStateNotification,
                     NSWindow.didMiniaturizeNotification,
                     NSWindow.didDeminiaturizeNotification] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(windowVisibilityChanged(_:)), name: name, object: window
            )
        }
    }

    @objc private func windowVisibilityChanged(_ notification: Notification) {
        updatePlaybackState()
    }

    private func updatePlaybackState() {
        let shouldRun = window?.isVisible == true
            && window?.isMiniaturized == false
            && window?.occlusionState.contains(.visible) == true
        setPlaybackState(shouldRun: shouldRun)
    }

    /// Pause/resume on the layer clock instead of removing the animation, so
    /// a hidden or miniaturised window pays nothing and resumes in place.
    private func setPlaybackState(shouldRun: Bool) {
        if shouldRun, masked.speed == 0 {
            let pausedTime = masked.timeOffset
            masked.speed = 1
            masked.timeOffset = 0
            masked.beginTime = 0
            masked.beginTime = masked.convertTime(CACurrentMediaTime(), from: nil) - pausedTime
        } else if !shouldRun, masked.speed != 0 {
            let pausedTime = masked.convertTime(CACurrentMediaTime(), from: nil)
            masked.speed = 0
            masked.timeOffset = pausedTime
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
#endif


/// An isolated, paint-only overlay: never changes button geometry or hit testing.
public struct ConsoleDiscussionActivityBorder: View {
    public init(isRunning: Bool, isActive: Bool = true) {
        self.isRunning = isRunning
        self.isActive = isActive
    }
    let isRunning: Bool
    var isActive = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    public var body: some View {
        Group {
            if isRunning {
                TimelineView(.animation(
                    minimumInterval: WorkActivityAnimation.frameInterval,
                    paused: !isVisible || !isActive || reduceMotion
                )) { context in
                    let progress = reduceMotion ? 0 : ConsoleWorkFlowingGradientPolicy.progress(at: context.date)
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(AngularGradient(
                            colors: [.cyan, .blue, .purple, .pink, .orange, .cyan],
                            center: .center,
                            angle: .degrees(Double(progress) * 360)
                        ), lineWidth: 1.5)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
    }
}
