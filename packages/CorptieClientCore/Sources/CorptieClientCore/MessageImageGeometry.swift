import Foundation
import ImageIO

/// Presentation-only, orientation-normalized source pixels, independent of the
/// decoded thumbnail size, Provider and screen scale. Never grants resource access.
public struct MessageImageGeometry: Hashable, Sendable {
    public let pixelWidth: Int
    public let pixelHeight: Int
    public init?(pixelWidth: Int?, pixelHeight: Int?, orientation: Int = 1) {
        guard let w = pixelWidth, let h = pixelHeight, w > 0, h > 0,
              w <= 1_000_000, h <= 1_000_000, Double(w) * Double(h) <= 1_000_000_000 else { return nil }
        let rotated = (5...8).contains(orientation)
        self.pixelWidth = rotated ? h : w; self.pixelHeight = rotated ? w : h
    }
    public static func read(_ source: CGImageSource) -> Self? {
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
        return Self(pixelWidth: (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
            pixelHeight: (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
            orientation: (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1)
    }
}
