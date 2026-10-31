import CoreGraphics
import Foundation
import QuartzCore

/// Shared vector artwork for the native macOS and mobile brand views.
/// Paths are built once; playback changes only two group transforms.
public final class CorptieLogoArtworkLayer: CALayer {
    public static let designSize: CGFloat = 640
    private let outer = CALayer()
    private let inner = CALayer()
    private var neutralShapes: [CAShapeLayer] = []
    private var neutralColor: CGColor?

    public override init() {
        super.init()
        bounds = CGRect(x: -320, y: -320, width: Self.designSize, height: Self.designSize)
        for (group, name) in [(outer, "outer"), (inner, "inner")] {
            group.name = name
            group.bounds = bounds
            group.position = .zero
            addSublayer(group)
        }
        buildPaths()
    }

    public override init(layer: Any) { super.init(layer: layer) }
    public required init?(coder: NSCoder) { nil }

    public func setNeutralColor(_ color: CGColor) {
        guard neutralColor != color else { return }
        neutralColor = color
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for shape in neutralShapes {
            shape.fillColor = shape.lineWidth == 0 ? color : nil
            shape.strokeColor = shape.lineWidth > 0 ? color : nil
        }
        CATransaction.commit()
    }

    public func setAnimating(_ animated: Bool) {
        for (group, rpm, direction) in [(outer, 31.5, 1.0), (inner, 25.5, -1.0)] {
            guard animated else {
                group.removeAnimation(forKey: "rotation")
                continue
            }
            guard group.animation(forKey: "rotation") == nil else { continue }
            let rotation = CABasicAnimation(keyPath: "transform.rotation.z")
            rotation.fromValue = 0.0
            rotation.toValue = direction * 2 * Double.pi
            rotation.duration = 60 / rpm
            rotation.repeatCount = .infinity
            rotation.timingFunction = CAMediaTimingFunction(name: .linear)
            group.add(rotation, forKey: "rotation")
        }
    }

    private func buildPaths() {
        let arcs = CGMutablePath()
        let nodes = CGMutablePath()
        for index in 0..<3 {
            let angle = -Double.pi / 2 + Double(index) * 2 * Double.pi / 3
            let start = angle + 11 * .pi / 180
            arcs.move(to: CGPoint(x: 282 * cos(start), y: 282 * sin(start)))
            arcs.addArc(center: .zero, radius: 282, startAngle: start,
                        endAngle: angle + 109 * .pi / 180, clockwise: false)
            let point = CGPoint(x: 282 * cos(angle), y: 282 * sin(angle))
            nodes.addEllipse(in: CGRect(x: point.x - 37, y: point.y - 37, width: 74, height: 74))
        }
        neutralShapes.append(shape(arcs, in: outer, lineWidth: 34))
        neutralShapes.append(shape(nodes, in: outer))
        let innerX = CGFloat(152) * sqrt(3) / 2
        let innerPoints = [CGPoint(x: 0, y: -152), CGPoint(x: -innerX, y: 76), CGPoint(x: innerX, y: 76)]
        let spokes = CGMutablePath()
        for end in innerPoints {
            let distance = hypot(end.x, end.y)
            spokes.move(to: CGPoint(x: end.x * 63 / distance, y: end.y * 63 / distance))
            spokes.addLine(to: end)
        }
        neutralShapes.append(shape(spokes, in: inner, lineWidth: 15))
        neutralShapes.append(shape(CGPath(ellipseIn: CGRect(x: -63, y: -63, width: 126, height: 126),
                                         transform: nil), in: inner, lineWidth: 32))
        let colors = [CGColor(red: 103/255, green: 205/255, blue: 210/255, alpha: 1),
                      CGColor(red: 1, green: 89/255, blue: 94/255, alpha: 1),
                      CGColor(red: 1, green: 191/255, blue: 0, alpha: 1)]
        for (point, color) in zip(innerPoints, colors) {
            let path = CGPath(ellipseIn: CGRect(x: point.x - 25, y: point.y - 25, width: 50, height: 50),
                              transform: nil)
            shape(path, in: inner).fillColor = color
        }
    }

    @discardableResult
    private func shape(_ path: CGPath, in group: CALayer, lineWidth: CGFloat = 0) -> CAShapeLayer {
        let shape = CAShapeLayer()
        shape.path = path
        shape.lineWidth = lineWidth
        group.addSublayer(shape)
        return shape
    }
}
