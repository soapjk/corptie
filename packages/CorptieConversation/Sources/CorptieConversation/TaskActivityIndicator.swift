import CorptieClientCore
import SwiftUI
#if os(macOS)
import AppKit
#endif

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
                Circle().trim(from: 0, to: 0.75)
                    .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .padding(1)
                    .rotationEffect(.degrees(animates ? 360 : 0))
                    .animation(animates ? .linear(duration: 0.8).repeatForever(autoreverses: false) : nil,
                               value: animates)
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
        rotation.duration = 0.8
        rotation.repeatCount = .infinity
        ring.add(rotation, forKey: "runningRotation")
    }
}
#endif
