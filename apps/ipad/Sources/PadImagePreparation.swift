import Foundation
import ImageIO
import UniformTypeIdentifiers
import CorptieClientCore

enum PadImagePreparation {
    enum Failure: Error, Equatable { case invalid, tooLarge }
    /// Decode a bounded thumbnail off the main actor, applying EXIF orientation.
    /// Small PNG/JPEG files remain byte-identical; transparency is never JPEG'd.
    static func prepare(_ data: Data, fileName: String) throws -> ClientDraftImage {
        guard !data.isEmpty, data.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, Double(width) * Double(height) <= 100_000_000 else { throw Failure.invalid }
        let type = CGImageSourceGetType(source) as String?
        // Do not silently flatten animated images; upload their original bytes.
        if CGImageSourceGetCount(source) > 1 {
            return ClientDraftImage(fileName: fileName, data: data)
        }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        if [UTType.png.identifier, UTType.jpeg.identifier].contains(type ?? ""),
           max(width, height) <= 3072, orientation == 1 {
            return ClientDraftImage(fileName: fileName, data: data)
        }
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 3072,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary) else { throw Failure.invalid }
        let transparent = [CGImageAlphaInfo.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo)
        let output = NSMutableData()
        let outputType = transparent ? UTType.png : UTType.jpeg
        guard let destination = CGImageDestinationCreateWithData(output, outputType.identifier as CFString, 1, nil) else { throw Failure.invalid }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length <= 20 * 1024 * 1024 else { throw Failure.tooLarge }
        let name = (fileName as NSString).deletingPathExtension + (transparent ? ".png" : ".jpg")
        return ClientDraftImage(fileName: name, data: output as Data)
    }
}
