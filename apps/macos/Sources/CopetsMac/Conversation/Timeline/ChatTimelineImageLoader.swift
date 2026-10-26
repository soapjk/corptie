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
    private var geometries: [URL: MessageImageGeometry] = [:]
    private var geometryOrder: [URL] = []
    private let repository = ConversationImageRepository()
    func geometry(for url: URL) -> MessageImageGeometry? { geometries[url] }

    private init() {
        cache.totalCostLimit = 64 * 1_024 * 1_024
        cache.countLimit = 160
    }

    func data(for url: URL, progress: @escaping @MainActor (ClientImageProgress) -> Void = { _ in }) async throws -> Data {
        let resource: ClientMessageImageResource
        if url.scheme == CorptieAppEnvironment.backendBaseURL.scheme,
           url.host == CorptieAppEnvironment.backendBaseURL.host,
           url.port == CorptieAppEnvironment.backendBaseURL.port {
            let parts = url.pathComponents
            guard parts.count == 4, parts[1] == "sessions",
                  let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let path = query.first(where: { $0.name == "path" })?.value else { throw URLError(.badURL) }
            let source: ClientMessageImageResource.Source
            if parts[3] == "images" { source = .managed(path: path) }
            else if parts[3] == "resources" { source = .messageReference(destination: path) }
            else { throw URLError(.unsupportedURL) }
            resource = .init(sessionID: parts[2], sourceItemID: query.first(where: { $0.name == "itemId" })?.value ?? "", source: source)
        } else {
            guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { throw URLError(.unsupportedURL) }
            resource = .init(sessionID: "public", sourceItemID: "", source: .publicRemote(url: url))
        }
        let transport = CorptieAppEnvironment.backendTransport
        return try await repository.data(resource, fetch: { callback in
            try await ClientSessionAPI(transport: transport).messageImage(resource, route: .desktop, progress: callback)
        }, progress: progress)
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
                let data = try? await self?.data(for: url)
                let decoded = await Task.detached(priority: .utility) { data.flatMap(Self.decode) }.value
                guard let self else { return }
                if let geometry = decoded?.1, self.geometries[url] != geometry {
                    if self.geometries[url] == nil { self.geometryOrder.append(url) }
                    self.geometries[url] = geometry
                    if self.geometryOrder.count > 2048 { self.geometries.removeValue(forKey: self.geometryOrder.removeFirst()) }
                }
                let image = decoded.map { NSImage(cgImage: $0.0, size: .zero) }
                self.store(image, for: url)
                self.active -= 1
                let callbacks = self.waiting.removeValue(forKey: url) ?? []
                callbacks.forEach { $0(image) }
                self.drain()
            }
        }
    }

    nonisolated private static func decode(_ data: Data) -> (CGImage, MessageImageGeometry?)? {
        let maximum = 20 * 1024 * 1024
            guard !data.isEmpty, data.count <= maximum,
                  let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            let geometry = MessageImageGeometry.read(source)
            guard let bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1024,
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary) else { return nil }
            return (bitmap, geometry)
    }

    private func store(_ image: NSImage?, for url: URL) {
        guard let image else { return }
        let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        cache.setObject(image, forKey: url as NSURL, cost: bitmap.map { $0.bytesPerRow * $0.height } ?? 0)
    }
}

/// Originals share the authenticated in-memory resource pipeline with thumbnails.
@MainActor final class ChatImageGalleryViewer: NSObject, NSWindowDelegate {
    static let shared = ChatImageGalleryViewer()
    private var window: NSWindow?
    private var preview: NSImageView?
    private var images: [ChatTimelineImage] = []
    private var index = 0
    private var counter: NSTextField?
    private var loadTask: Task<Void, Never>?

    func show(_ images: [ChatTimelineImage], selected: Int) {
        guard images.indices.contains(selected) else { return }
        self.images = images
        index = selected
        if window == nil {
            let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 900, height: 650),
                styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.collectionBehavior.insert(.fullScreenPrimary)
            window.delegate = self
            let preview = NSImageView(frame: .zero)
            preview.imageScaling = .scaleProportionallyUpOrDown
            preview.animates = true
            let scroll = NSScrollView()
            scroll.allowsMagnification = true; scroll.minMagnification = 1; scroll.maxMagnification = 8
            scroll.documentView = preview
            scroll.translatesAutoresizingMaskIntoConstraints = false
            preview.frame = CGRect(x: 0, y: 0, width: 860, height: 560)
            preview.autoresizingMask = [.width, .height]
            let previous = NSButton(title: L10n("Previous"), target: self, action: #selector(previousImage))
            let next = NSButton(title: L10n("Next"), target: self, action: #selector(nextImage))
            let retry = NSButton(title: L10n("Retry"), target: self, action: #selector(retryImage))
            let count = NSTextField(labelWithString: "")
            let controls = NSStackView(views: [previous, count, next, retry])
            controls.orientation = .horizontal
            let content = NSStackView(views: [scroll, controls])
            content.orientation = .vertical
            content.alignment = .centerX
            content.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
            window.contentView = content
            scroll.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -16).isActive = true
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true
            self.window = window; self.preview = preview; self.counter = count
            window.center()
        }
        display()
        window?.makeKeyAndOrderFront(nil)
    }
    private func display() {
        guard images.indices.contains(index) else { return }
        loadTask?.cancel()
        preview?.image = nil
        counter?.stringValue = "\(index + 1) / \(images.count)"
        guard let url = images[index].displayURL else {
            counter?.stringValue += " · \(L10n("Image unavailable. Try again."))"
            return
        }
        window?.title = url.lastPathComponent
        counter?.stringValue += " · \(L10n("Loading…"))"
        loadTask = Task { [weak self] in
            do {
                let data = try await ChatTimelineImageLoader.shared.data(for: url) { [weak self] progress in
                    if let fraction = progress.fraction { self?.counter?.stringValue = "\(Int(fraction * 100))%" }
                }
                try Task.checkCancellation()
                let image = try await Task.detached(priority: .userInitiated) {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw URLError(.cannotDecodeContentData) }
                    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
                    let width = properties?[kCGImagePropertyPixelWidth] as? Int ?? 0
                    let height = properties?[kCGImagePropertyPixelHeight] as? Int ?? 0
                    let frames = CGImageSourceGetCount(source)
                    if frames == 1 {
                        guard let bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceThumbnailMaxPixelSize: 3456,
                            kCGImageSourceShouldCacheImmediately: true
                        ] as CFDictionary) else { throw URLError(.cannotDecodeContentData) }
                        return NSImage(cgImage: bitmap, size: .zero)
                    }
                    guard width > 0, height > 0, Double(width) * Double(height) * 4 * Double(frames) <= 64 * 1024 * 1024
                    else { throw URLError(.dataLengthExceedsMaximum) }
                    guard let image = NSImage(data: data) else { throw URLError(.cannotDecodeContentData) }
                    return image
                }.value
                try Task.checkCancellation()
                self?.preview?.image = image
                if let self { self.counter?.stringValue = "\(self.index + 1) / \(self.images.count)" }
            } catch {
                if !Task.isCancelled { self?.counter?.stringValue = L10n("Image unavailable. Try again.") }
            }
        }
    }
    @objc private func previousImage() { index = max(0, index - 1); display() }
    @objc private func nextImage() { index = min(images.count - 1, index + 1); display() }
    @objc private func retryImage() { display() }
    func windowWillClose(_ notification: Notification) {
        loadTask?.cancel()
        preview?.image = nil
        images = []
    }
}
