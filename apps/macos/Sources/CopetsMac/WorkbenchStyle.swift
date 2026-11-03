import AppKit
import SwiftUI

/// Desktop workbench geometry shared by the native transcript and SwiftUI composer.
enum WorkbenchStyle {
    static let readingWidth: CGFloat = 760
    static let readingInset: CGFloat = 32
    static let canvas = Color(nsColor: .textBackgroundColor)
    static let sidebarColor = adaptive(light: 0.985, dark: 0.115)
    static let workColumnColor = adaptive(light: 0.995, dark: 0.18)
    static let navigationColor = adaptive(light: 0.965, dark: 0.095)

    static func lane(viewportWidth: CGFloat) -> CGRect {
        let viewport = max(0, viewportWidth.isFinite ? viewportWidth : 0)
        let inset: CGFloat = viewport < 500 ? 12 : readingInset
        let width = min(readingWidth, max(0, viewport - inset * 2))
        return CGRect(x: (viewport - width) / 2, y: 0, width: width, height: 0)
    }

    private static func adaptive(light: CGFloat, dark: CGFloat) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(white: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light, alpha: 1)
        })
    }
}
