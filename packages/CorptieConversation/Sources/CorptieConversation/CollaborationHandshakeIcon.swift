import SwiftUI

/// A single stroked vector, shared by desktop and mobile collaboration cards.
public struct CollaborationHandshakeIcon: View {
    public init() {}
    public var body: some View {
        CollaborationHandshakeShape()
            .stroke(style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round))
            .aspectRatio(1, contentMode: .fit)
            .accessibilityHidden(true)
    }
}

struct CollaborationHandshakeShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        // Cuffs and the two hands meeting at the central thumb grip.
        path.move(to: CGPoint(x: 2, y: 4))
        path.addLine(to: CGPoint(x: 5, y: 3))
        path.addLine(to: CGPoint(x: 8, y: 8))
        path.addLine(to: CGPoint(x: 5, y: 15))
        path.addLine(to: CGPoint(x: 2, y: 14))
        path.closeSubpath()
        path.move(to: CGPoint(x: 22, y: 4))
        path.addLine(to: CGPoint(x: 19, y: 3))
        path.addLine(to: CGPoint(x: 16, y: 8))
        path.addLine(to: CGPoint(x: 19, y: 15))
        path.addLine(to: CGPoint(x: 22, y: 14))
        path.closeSubpath()
        path.move(to: CGPoint(x: 7, y: 6.5))
        path.addCurve(to: CGPoint(x: 12, y: 7), control1: CGPoint(x: 9, y: 5), control2: CGPoint(x: 10, y: 6))
        path.move(to: CGPoint(x: 17, y: 6.5))
        path.addCurve(to: CGPoint(x: 12, y: 6), control1: CGPoint(x: 15, y: 5), control2: CGPoint(x: 13.5, y: 5))
        path.addLine(to: CGPoint(x: 9, y: 9))
        path.addCurve(to: CGPoint(x: 11, y: 11), control1: CGPoint(x: 7, y: 11), control2: CGPoint(x: 9, y: 13))
        path.addLine(to: CGPoint(x: 13, y: 9))
        path.addLine(to: CGPoint(x: 18, y: 14))
        path.addCurve(to: CGPoint(x: 16, y: 17), control1: CGPoint(x: 20, y: 16), control2: CGPoint(x: 18, y: 19))
        path.addLine(to: CGPoint(x: 13, y: 14))
        path.move(to: CGPoint(x: 16, y: 17))
        path.addCurve(to: CGPoint(x: 13, y: 19), control1: CGPoint(x: 17, y: 19), control2: CGPoint(x: 15, y: 21))
        path.addLine(to: CGPoint(x: 10, y: 16))
        path.move(to: CGPoint(x: 13, y: 19))
        path.addCurve(to: CGPoint(x: 10, y: 20), control1: CGPoint(x: 13, y: 21), control2: CGPoint(x: 11, y: 21))
        path.addLine(to: CGPoint(x: 5, y: 15))
        return path.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}
