import SwiftUI
#if os(macOS)
import AppKit
#endif

/// The Work outline and conversation share one adaptive canvas on each platform.
public enum WorkbenchCanvasSurface {
#if os(iOS)
    public static var color: Color { Color(uiColor: .systemBackground) }
#elseif os(macOS)
    public static var color: Color { Color(nsColor: nativeColor) }
    public static var nativeColor: NSColor { .textBackgroundColor }
#endif
}
