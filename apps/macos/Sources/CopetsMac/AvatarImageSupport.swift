import AppKit
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

    static func loadImage(at path: String) -> NSImage? {
        NSImage(contentsOfFile: path)
    }
}
