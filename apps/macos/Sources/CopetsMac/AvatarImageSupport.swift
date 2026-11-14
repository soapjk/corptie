import AppKit
import CorptieConversation
import ImageIO
import UniformTypeIdentifiers

enum AvatarImageSupport {
    static let allowedContentTypes: [UTType] = [
        .gif,
        .png,
        .jpeg,
        .heic,
        .tiff,
        .svg,
        .image
    ]

    /// Full-fidelity load. Kept for editing / export surfaces that need the original.
    static func loadImage(at path: String) -> NSImage? {
        NSImage(contentsOfFile: path)
    }

    // MARK: - Shared display cache

    /// The same avatar path is rendered in the session list, message cards,
    /// title badges, orbs and the role detail page at the same time. Each
    /// `AnimatedAvatarImage` used to call `NSImage(contentsOfFile:)` on its own,
    /// which decodes a fresh full-resolution bitmap per view (measured: one
    /// 9.24 MB PNG repeated 57 times). Display surfaces therefore share one
    /// downsampled image instead of multiplying decoded bytes by view count.
    @MainActor private static let displayCache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.totalCostLimit = 24 * 1024 * 1024
        cache.countLimit = 48
        return cache
    }()

    /// Cached, display-sized image for `AnimatedAvatarImage`.
    @MainActor static func displayImage(at path: String) -> NSImage? {
        if BuiltinRoleAvatarCatalog.id(from: path) != nil { return BuiltinRoleAvatarImage.image(for: path) }
        let key = cacheKey(for: path)
        if let cached = displayCache.object(forKey: key) { return cached }
        guard let image = decodeDisplayImage(at: path) else { return nil }
        displayCache.setObject(image, forKey: key, cost: imageCost(image))
        return image
    }

    /// Replacing an avatar file must not keep serving the old decoded bitmap.
    @MainActor private static func cacheKey(for path: String) -> NSString {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attributes[.size] as? NSNumber,
              let modified = attributes[.modificationDate] as? Date else {
            return path as NSString
        }
        return "\(path)|\(size.uint64Value)|\(modified.timeIntervalSince1970)" as NSString
    }

    @MainActor private static func decodeDisplayImage(at path: String) -> NSImage? {
        let url = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetCount(source) > 0 else {
            return NSImage(contentsOfFile: path)
        }
        // A multi-frame avatar (GIF / APNG) must keep every frame or the
        // animation silently degrades to a still first frame.
        guard CGImageSourceGetCount(source) == 1 else {
            return NSImage(contentsOfFile: path)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 256,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return NSImage(contentsOfFile: path)
        }
        return NSImage(
            cgImage: bitmap,
            size: NSSize(width: CGFloat(bitmap.width) / 2, height: CGFloat(bitmap.height) / 2)
        )
    }

    @MainActor private static func imageCost(_ image: NSImage) -> Int {
        if let rep = image.representations.first as? NSBitmapImageRep {
            return rep.pixelsWide * rep.pixelsHigh * 4
        }
        return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
            .map { $0.bytesPerRow * $0.height } ?? 0
    }
}
