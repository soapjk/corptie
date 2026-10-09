import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore
import ImageIO
import Quartz
import UniformTypeIdentifiers

@MainActor
final class ChatTimelineImageLoader {
    static let shared = ChatTimelineImageLoader()
    private let cache = NSCache<NSURL, NSImage>()
    private var waiting: [URL: [(NSImage?) -> Void]] = [:]
    private var pending: [URL] = []
    private var active = 0

    private init() {
        cache.totalCostLimit = 64 * 1_024 * 1_024
        cache.countLimit = 160
    }

    func load(_ url: URL, completion: @escaping (NSImage?) -> Void) {
        if let image = cache.object(forKey: url as NSURL) {
            completion(image)
            return
        }
        if waiting[url] != nil { waiting[url]?.append(completion); return }
        waiting[url] = [completion]
        pending.append(url)
        drain()
    }

    private func drain() {
        while active < 3, !pending.isEmpty {
            let url = pending.removeFirst()
            active += 1
            Task { [weak self] in
                let bitmap = await Task.detached(priority: .utility) { await Self.decode(url) }.value
                guard let self else { return }
                let image = bitmap.map { NSImage(cgImage: $0, size: .zero) }
                self.store(image, for: url)
                self.active -= 1
                let callbacks = self.waiting.removeValue(forKey: url) ?? []
                callbacks.forEach { $0(image) }
                self.drain()
            }
        }
    }

    nonisolated private static func decode(_ url: URL) async -> CGImage? {
        let maximum = 20 * 1024 * 1024
        let data: Data
        do {
            if url.isFileURL {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0, size <= maximum else { return nil }
                data = try Data(contentsOf: url, options: .mappedIfSafe)
            } else {
                data = try await ClientRemoteImageDownload.read(url)
            }
            guard !data.isEmpty, data.count <= maximum,
                  let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1024,
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary)
        } catch { return nil }
    }

    private func store(_ image: NSImage?, for url: URL) {
        guard let image else { return }
        let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        cache.setObject(image, forKey: url as NSURL, cost: bitmap.map { $0.bytesPerRow * $0.height } ?? 0)
    }
}

/// Quick Look reads originals only after an explicit click. The timeline keeps
/// bounded thumbnails; this window provides native zoom and full-screen mode.
@MainActor final class ChatImageGalleryViewer: NSObject, NSWindowDelegate {
    static let shared = ChatImageGalleryViewer()
    private var window: NSWindow?
    private var preview: QLPreviewView?
    private var urls: [URL] = []
    private var index = 0
    private var counter: NSTextField?
    private var loadTask: Task<Void, Never>?
    private var temporaryDirectory: URL?

    func show(_ images: [ChatTimelineImage], selected: Int) {
        guard images.indices.contains(selected), let selectedURL = images[selected].displayURL else { return }
        urls = images.compactMap(\.displayURL)
        index = urls.firstIndex(of: selectedURL) ?? 0
        if window == nil {
            let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 900, height: 650),
                styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.collectionBehavior.insert(.fullScreenPrimary)
            window.delegate = self
            let preview = QLPreviewView(frame: .zero, style: .normal)!
            preview.translatesAutoresizingMaskIntoConstraints = false
            let previous = NSButton(title: L10n("Previous"), target: self, action: #selector(previousImage))
            let next = NSButton(title: L10n("Next"), target: self, action: #selector(nextImage))
            let count = NSTextField(labelWithString: "")
            let controls = NSStackView(views: [previous, count, next])
            controls.orientation = .horizontal
            let content = NSStackView(views: [preview, controls])
            content.orientation = .vertical
            content.alignment = .centerX
            content.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
            window.contentView = content
            preview.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -16).isActive = true
            preview.heightAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true
            self.window = window; self.preview = preview; self.counter = count
            window.center()
        }
        display()
        window?.makeKeyAndOrderFront(nil)
    }
    private func display() {
        guard urls.indices.contains(index) else { return }
        loadTask?.cancel()
        preview?.previewItem = nil
        if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
        temporaryDirectory = nil
        let url = urls[index]
        window?.title = url.lastPathComponent
        counter?.stringValue = "\(index + 1) / \(urls.count)"
        if url.isFileURL { preview?.previewItem = url as NSURL; return }
        counter?.stringValue += " · \(L10n("Loading…"))"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("image-gallery-\(UUID())")
        loadTask = Task { [weak self] in
            do {
                let data = try await ClientRemoteImageDownload.read(url)
                try Task.checkCancellation()
                let file = try await Task.detached(priority: .userInitiated) {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                          let type = CGImageSourceGetType(source) as String? else { throw URLError(.cannotDecodeContentData) }
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let ext = UTType(type)?.preferredFilenameExtension ?? "png"
                    let file = directory.appendingPathComponent("image.\(ext)")
                    try data.write(to: file, options: .atomic)
                    return file
                }.value
                try Task.checkCancellation()
                self?.temporaryDirectory = directory
                self?.preview?.previewItem = file as NSURL
                if let self { self.counter?.stringValue = "\(self.index + 1) / \(self.urls.count)" }
            } catch {
                try? FileManager.default.removeItem(at: directory)
                if !Task.isCancelled { self?.counter?.stringValue = L10n("Image unavailable. Try again.") }
            }
        }
    }
    @objc private func previousImage() { index = max(0, index - 1); display() }
    @objc private func nextImage() { index = min(urls.count - 1, index + 1); display() }
    func windowWillClose(_ notification: Notification) {
        loadTask?.cancel()
        preview?.previewItem = nil
        if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
        temporaryDirectory = nil
        urls = []
    }
}
