import CorptieClientCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// A process-wide monotonic origin keeps independently mounted rings in phase.
// Core Animation owns every frame; no timer or observable UI state is needed.
private enum TaskRunningRingClock {
    static let origin = CACurrentMediaTime()
}

public struct TaskActivityIndicator: View {
    let activity: TaskSessionActivity
    let lifecycleState: String
    let label: String
    let isActive: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if !os(macOS)
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false
    #endif

    public init(activity: TaskSessionActivity, lifecycleState: String = "", label: String? = nil, isActive: Bool = true) {
        self.isActive = isActive
        self.activity = activity
        self.lifecycleState = lifecycleState
        self.label = label ?? activity.labelKey
    }

    private var color: Color {
        switch activity.indicatorTone(lifecycleState: lifecycleState) {
        case .connected:
            .blue
        case .green: .green
        case .orange: .orange
        case .red: .red
        case .secondary: .secondary
        }
    }

    public var body: some View {
        Group {
            if activity == .processing {
                #if os(macOS)
                TaskRunningRing(animates: isActive && !reduceMotion, color: color)
                #else
                TaskRunningRing(animates: animates, color: color)
                    .onAppear { isVisible = true }
                    .onDisappear { isVisible = false }
                #endif
            } else {
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(color)
            }
        }
            .frame(width: 12, height: 12)
            .accessibilityLabel(label)
            .help(label)
    }

    #if !os(macOS)
    private var animates: Bool {
        isVisible && isActive && scenePhase == .active && !reduceMotion
    }
    #endif

    private var symbol: String {
        switch activity {
        case .processing: "circle"
        case .waitingForInput, .paused: "pause.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .interrupted: "stop.circle"
        case .idle: "checkmark.circle"
        case .noSession, .unknown: "circle.dashed"
        }
    }
}

#if os(macOS)
/// Core Animation rotates only this small layer; no list body updates per frame.
struct TaskRunningRing: NSViewRepresentable {
    let animates: Bool
    let color: Color

    func makeNSView(context: Context) -> TaskRunningRingView { TaskRunningRingView() }
    func updateNSView(_ view: TaskRunningRingView, context: Context) {
        view.animates = animates
        view.color = NSColor(color)
        view.synchronizeAnimation()
    }
}

final class TaskRunningRingView: NSView {
    let ring = CAShapeLayer()
    var animates = true
    var color: NSColor = .systemBlue {
        didSet { ring.strokeColor = color.cgColor }
    }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 12, height: 12))
        wantsLayer = true
        ring.fillColor = nil
        ring.strokeColor = color.cgColor
        ring.lineWidth = 1.5
        ring.lineCap = .round
        ring.strokeEnd = 0.75
        layer?.addSublayer(ring)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = bounds
        ring.path = CGPath(ellipseIn: bounds.insetBy(dx: 1.75, dy: 1.75), transform: nil)
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        synchronizeAnimation()
    }

    func synchronizeAnimation() {
        guard animates, window != nil else {
            ring.removeAnimation(forKey: "runningRotation")
            return
        }
        guard ring.animation(forKey: "runningRotation") == nil else { return }
        let rotation = CABasicAnimation(keyPath: "transform.rotation.z")
        rotation.fromValue = 0
        rotation.toValue = 2 * Double.pi
        rotation.beginTime = ring.convertTime(TaskRunningRingClock.origin, from: nil)
        rotation.duration = 0.8
        rotation.repeatCount = .infinity
        ring.add(rotation, forKey: "runningRotation")
    }
}
#else
/// Keep rotation on a leaf layer, outside SwiftUI's list layout transactions.
struct TaskRunningRing: UIViewRepresentable {
    let animates: Bool
    let color: Color

    func makeUIView(context: Context) -> TaskRunningRingView { TaskRunningRingView() }
    func updateUIView(_ view: TaskRunningRingView, context: Context) {
        view.animates = animates
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        view.ring.strokeColor = UIColor(color).cgColor
        CATransaction.commit()
        view.synchronizeAnimation()
    }
    static func dismantleUIView(_ view: TaskRunningRingView, coordinator: ()) {
        view.animates = false
        view.synchronizeAnimation()
    }
}

final class TaskRunningRingView: UIView {
    let ring = CAShapeLayer()
    var animates = true

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 12, height: 12))
        isUserInteractionEnabled = false
        backgroundColor = .clear
        ring.fillColor = nil
        ring.strokeColor = UIColor.systemBlue.cgColor
        ring.lineWidth = 1.5
        ring.lineCap = .round
        ring.strokeEnd = 0.75
        layer.addSublayer(ring)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.bounds = CGRect(origin: .zero, size: bounds.size)
        ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
        ring.path = CGPath(ellipseIn: ring.bounds.insetBy(dx: 1.75, dy: 1.75), transform: nil)
        CATransaction.commit()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        synchronizeAnimation()
    }

    func synchronizeAnimation() {
        guard animates, window != nil else {
            ring.removeAnimation(forKey: "runningRotation")
            return
        }
        guard ring.animation(forKey: "runningRotation") == nil else { return }
        let rotation = CABasicAnimation(keyPath: "transform.rotation.z")
        rotation.fromValue = 0
        rotation.toValue = 2 * Double.pi
        rotation.beginTime = ring.convertTime(TaskRunningRingClock.origin, from: nil)
        rotation.duration = 0.8
        rotation.repeatCount = .infinity
        ring.add(rotation, forKey: "runningRotation")
    }
}
#endif
