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
        let inset = readingInset
        let width = min(readingWidth, max(0, viewport - inset * 2))
        return CGRect(x: (viewport - width) / 2, y: 0, width: width, height: 0)
    }

    private static func adaptive(light: CGFloat, dark: CGFloat) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(white: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light, alpha: 1)
        })
    }
}


/// One horizontal layout for the transcript, checklist and input dock.
struct WorkbenchReadingLane: ViewModifier {
    let compact: Bool
    func body(content: Content) -> some View {
        content.frame(maxWidth: compact ? .infinity : WorkbenchStyle.readingWidth)
            .padding(.horizontal, compact ? 0 : WorkbenchStyle.readingInset)
            .frame(maxWidth: .infinity)
    }
}
