import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Local presentation state. Wallpaper bytes never enter the backend or sync models.
@MainActor
public final class LocalWallpaperStore: ObservableObject {
    public static let shared = LocalWallpaperStore()

    @Published public private(set) var image: CGImage?
    @Published public private(set) var errorMessage: String?

    public var hasWallpaper: Bool { image != nil }

    private let fileURL: URL

    public init(directory: URL? = nil) {
        let support = directory ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "Corptie", isDirectory: true)
        fileURL = support.appendingPathComponent("appearance/wallpaper.jpg")
        if let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) {
            image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        }
    }

    public func importFile(_ url: URL) async {
        do {
            let destination = fileURL
            let data = try await Task.detached(priority: .userInitiated) {
                try LocalWallpaperImageProcessor.jpegData(from: url)
            }.value
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: destination, options: .atomic)
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                throw LocalWallpaperError.invalidImage
            }
            image = decoded
            errorMessage = nil
        } catch {
            errorMessage = "无法使用所选图片：\(error.localizedDescription)"
        }
    }

    public func importImageData(_ data: Data) async {
        do {
            let destination = fileURL
            let processed = try await Task.detached(priority: .userInitiated) {
                try LocalWallpaperImageProcessor.jpegData(from: data)
            }.value
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try processed.write(to: destination, options: .atomic)
            guard let source = CGImageSourceCreateWithData(processed as CFData, nil),
                  let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                throw LocalWallpaperError.invalidImage
            }
            image = decoded
            errorMessage = nil
        } catch {
            errorMessage = "无法使用所选图片：\(error.localizedDescription)"
        }
    }

    public func restoreDefault() {
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
            image = nil
            errorMessage = nil
        } catch {
            errorMessage = "无法恢复默认背景：\(error.localizedDescription)"
        }
    }
}

public struct LocalWallpaperCanvas: View {
    @ObservedObject private var wallpaper = LocalWallpaperStore.shared
    private let fallbackColor: Color

    public init(fallbackColor: Color = WorkbenchCanvasSurface.defaultColor) {
        self.fallbackColor = fallbackColor
    }

    public var body: some View {
        GeometryReader { geometry in
            if let image = wallpaper.image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .clipped()
                    .overlay(Color.black.opacity(0.08))
            } else {
                fallbackColor
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private enum LocalWallpaperError: LocalizedError {
    case invalidImage
    case encodeFailed
    case imageTooLarge

    var errorDescription: String? {
        switch self {
        case .invalidImage: "图片格式不受支持或文件已损坏"
        case .encodeFailed: "图片处理失败"
        case .imageTooLarge: "照片超过 32 MB，请选用尺寸较小的图片"
        }
    }
}

private enum LocalWallpaperImageProcessor {
    private static let maximumPixelSize = 3072

    static func jpegData(from url: URL) throws -> Data {
        let allowed = url.startAccessingSecurityScopedResource()
        defer { if allowed { url.stopAccessingSecurityScopedResource() } }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw LocalWallpaperError.invalidImage
        }
        return try jpegData(from: source)
    }

    static func jpegData(from data: Data) throws -> Data {
        guard data.count <= 32 * 1024 * 1024 else {
            throw LocalWallpaperError.imageTooLarge
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            throw LocalWallpaperError.invalidImage
        }
        return try jpegData(from: source)
    }

    private static func jpegData(from source: CGImageSource) throws -> Data {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: false
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw LocalWallpaperError.invalidImage
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw LocalWallpaperError.encodeFailed
        }
        CGImageDestinationAddImage(destination, thumbnail, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw LocalWallpaperError.encodeFailed
        }
        return output as Data
    }
}
