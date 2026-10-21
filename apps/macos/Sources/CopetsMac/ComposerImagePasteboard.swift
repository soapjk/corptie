import AppKit
import ImageIO
import UniformTypeIdentifiers

/// Clipboard access stays on the main actor. Validation, transcoding and disk
/// work use an immutable, bounded snapshot, never the changing general board.
enum ComposerImagePasteboard {
    static let maximumBytes = 20 * 1024 * 1024 // Same as ChatResourceService.
    // A clipboard TIFF is often uncompressed. Limit its source separately from
    // the final encoded attachment, otherwise ordinary large screenshots fail.
    static let maximumSourceBytes = 60 * 1024 * 1024
    static let maximumTotalBytes = 60 * 1024 * 1024
    static let maximumPixels = 40_000_000
    static let maximumImages = 8
    static let richTextLimit = 2 * 1024 * 1024
    static let legacyFileType = NSPasteboard.PasteboardType("NSFilenamesPboardType")

    struct Snapshot: Sendable {
        var items: [[Representation]]
        var rejectedItems = 0
    }

    enum Representation: Sendable {
        case file(URL)
        case data(Data)
    }

    struct Image: Sendable {
        let url: URL
        let temporary: Bool
    }

    struct Batch: Sendable {
        var images: [Image] = []
        var failed = 0
        var truncated = false

        func cleanup() {
            for image in images where image.temporary { try? FileManager.default.removeItem(at: image.url) }
        }
    }

    static func isImageType(_ type: NSPasteboard.PasteboardType) -> Bool {
        UTType(type.rawValue)?.conforms(to: .image) == true
            || NSImage.imageTypes.contains(type.rawValue)
    }

    @MainActor
    static func hasCandidate(in board: NSPasteboard) -> Bool {
        (board.types ?? []).contains { isImageType($0) || $0 == .fileURL || $0 == legacyFileType || $0 == .rtfd || $0 == .html }
    }

    @MainActor
    static func capture(_ board: NSPasteboard) -> Snapshot? {
        var result = Snapshot(items: [])
        var remainingBytes = maximumTotalBytes
        for item in (board.pasteboardItems ?? []).prefix(maximumImages + 1) {
            if result.items.count > maximumImages { break }
            var representations: [Representation] = []
            let imageTypes = item.types.filter(isImageType).sorted { rank($0) < rank($1) }
            if let path = item.string(forType: .fileURL), let url = URL(string: path), url.isFileURL,
               !imageTypes.isEmpty || UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                representations.append(.file(url))
            }
            var rejected = false
            for type in imageTypes.prefix(4) {
                guard let data = item.data(forType: type) else { continue }
                let sourceLimit = rank(type) <= 4 ? maximumBytes : maximumSourceBytes
                guard !data.isEmpty, data.count <= sourceLimit, data.count <= remainingBytes else {
                    rejected = true
                    continue
                }
                remainingBytes -= data.count
                representations.append(.data(data))
            }
            // RTFD is an archive of actual attachments, not HTML fetched from
            // a URL. Only inspect this bounded fallback when no bitmap exists.
            if representations.isEmpty, let data = item.data(forType: .rtfd), data.count <= richTextLimit,
               let document = try? NSAttributedString(data: data,
                   options: [.documentType: NSAttributedString.DocumentType.rtfd], documentAttributes: nil) {
                document.enumerateAttribute(.attachment, in: NSRange(location: 0, length: document.length)) { value, _, _ in
                    guard representations.count <= maximumImages,
                          let attachment = value as? NSTextAttachment,
                          let contents = attachment.fileWrapper?.regularFileContents,
                          contents.count <= remainingBytes else { return }
                    remainingBytes -= contents.count
                    representations.append(.data(contents))
                }
                // Attachments are separate images, not alternate representations.
                for representation in representations.prefix(maximumImages + 1 - result.items.count) {
                    result.items.append([representation])
                }
                if !representations.isEmpty { continue }
            }
            if representations.isEmpty, let data = item.data(forType: .html), data.count <= richTextLimit {
                // No WebView / attributed HTML importer: these may fetch remote URLs.
                let embedded = embeddedImages(in: data)
                for contents in embedded.prefix(maximumImages + 1 - result.items.count) where contents.count <= remainingBytes {
                    remainingBytes -= contents.count
                    result.items.append([.data(contents)])
                }
                if !embedded.isEmpty { continue }
            }
            if !representations.isEmpty { result.items.append(representations) }
            else if rejected || !imageTypes.isEmpty { result.rejectedItems += 1 }
        }
        if result.items.isEmpty, result.rejectedItems == 0,
           let paths = board.propertyList(forType: legacyFileType) as? [String] {
            for path in paths.prefix(maximumImages + 1) {
                let url = URL(fileURLWithPath: path)
                if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                    result.items.append([.file(url)])
                }
            }
        }
        return result.items.isEmpty && result.rejectedItems == 0 ? nil : result
    }

    private static func rank(_ type: NSPasteboard.PasteboardType) -> Int {
        switch type.rawValue {
        case UTType.png.identifier: 0
        case UTType.jpeg.identifier: 1
        case UTType.heic.identifier: 2
        case UTType.webP.identifier: 3
        case UTType.gif.identifier: 4
        case UTType.tiff.identifier: 5
        default: 6
        }
    }

    /// Called on the bounded image preparation actor, never during menu validation.
    static func prepare(_ snapshot: Snapshot, capacity: Int) -> Batch {
        var batch = Batch(failed: snapshot.rejectedItems)
        for representations in snapshot.items {
            if Task.isCancelled { batch.cleanup(); return Batch() }
            guard batch.images.count < min(maximumImages, capacity) else { batch.truncated = true; break }
            var prepared: Image?
            for representation in representations {
                if let image = try? prepareImage(representation) { prepared = image; break }
            }
            if let prepared { batch.images.append(prepared) }
            else { batch.failed += 1 }
        }
        return batch
    }

    // Only literal data:image/...;base64 sources. Remote and local URL text is
    // deliberately not dereferenced. Work is bounded by richTextLimit and count.
    private static func embeddedImages(in html: Data) -> [Data] {
        guard let text = String(data: html, encoding: .utf8),
              let expression = try? NSRegularExpression(
                pattern: #"(?i)\bsrc\s*=\s*["']data:image/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)["']"#) else { return [] }
        var images: [Data] = []
        var cursor = text.startIndex
        // Consume each tag once. A regex over the entire HTML with an unbounded
        // [^>]* prefix can repeatedly scan malformed nested tags on the UI thread.
        while images.count <= maximumImages,
              let start = text.range(of: "<img", options: .caseInsensitive, range: cursor..<text.endIndex),
              let end = text.range(of: ">", range: start.upperBound..<text.endIndex) {
            cursor = end.upperBound
            let tag = String(text[start.lowerBound..<end.upperBound])
            guard let match = expression.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
                  let range = Range(match.range(at: 1), in: tag),
                  let contents = Data(base64Encoded: String(tag[range]), options: .ignoreUnknownCharacters)
            else { continue }
            images.append(contents)
        }
        return images
    }

    private static func prepareImage(_ representation: Representation) throws -> Image {
        let source: CGImageSource
        let originalURL: URL?
        let originalData: Data?
        let sourceByteCount: Int
        switch representation {
        case .file(let url):
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true, let count = values.fileSize,
                  count > 0, count <= maximumSourceBytes,
                  let decoded = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
            else { throw PasteError.unreadable }
            source = decoded; originalURL = url; originalData = nil; sourceByteCount = count
        case .data(let data):
            guard !data.isEmpty, data.count <= maximumSourceBytes,
                  let decoded = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
            else { throw PasteError.unreadable }
            source = decoded; originalURL = nil; originalData = data; sourceByteCount = data.count
        }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= maximumPixels / height,
              let identifier = CGImageSourceGetType(source) as String? else { throw PasteError.unreadable }
        let directTypes = [UTType.png.identifier, UTType.jpeg.identifier, UTType.gif.identifier,
                           UTType.webP.identifier, UTType.heic.identifier]
        guard !directTypes.contains(identifier) || sourceByteCount <= maximumBytes else { throw PasteError.unreadable }
        if directTypes.contains(identifier), let originalURL { return Image(url: originalURL, temporary: false) }
        let ext = directTypes.contains(identifier) ? UTType(identifier)?.preferredFilenameExtension ?? "image" : "png"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("corptie-paste-\(UUID().uuidString).\(ext)")
        do {
            if directTypes.contains(identifier), let originalData {
                try originalData.write(to: url, options: .atomic)
            } else {
                guard let bitmap = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw PasteError.unreadable }
                let data = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
                else { throw PasteError.unreadable }
                CGImageDestinationAddImage(destination, bitmap, properties as CFDictionary)
                guard CGImageDestinationFinalize(destination), data.length <= maximumBytes else { throw PasteError.unreadable }
                try (data as Data).write(to: url, options: .atomic)
            }
            return Image(url: url, temporary: true)
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    enum PasteError: Error {
        case unreadable, unsupported, full, partial(Int), truncated

        @MainActor var message: String {
            switch self {
            case .unreadable: L10n("无法读取剪贴板图片，请重新复制图片后重试。")
            case .unsupported: L10n("当前模型不支持图片。")
            case .full: L10n("最多只能添加 8 张图片。")
            case .partial(let count): String(format: L10n("有 %d 张图片未能导入，请检查图片格式或大小。"), count)
            case .truncated: L10n("部分图片未添加：最多只能添加 8 张图片。")
            }
        }
    }

    @MainActor static func diagnoseCommand(_ board: NSPasteboard) {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["CORPTIE_CLIPBOARD_DIAGNOSTICS"] == "1" else { return }
        // Types and counts only. Never log paths, clipboard strings, or bytes.
        let types = (board.types ?? []).prefix(16).map { String($0.rawValue.prefix(80)) }.joined(separator: ",")
        NSLog("[composer-paste] command change=%ld items=%ld types=%@", board.changeCount,
              board.pasteboardItems?.count ?? 0, types)
        #endif
    }
}

/// One worker serializes preparation across all windows, bounding decode memory.
actor ComposerImagePreparation {
    static let shared = ComposerImagePreparation()
    func prepare(_ snapshot: ComposerImagePasteboard.Snapshot, capacity: Int) -> ComposerImagePasteboard.Batch {
        ComposerImagePasteboard.prepare(snapshot, capacity: capacity)
    }
}
