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

/// AppKit keeps small documents centered while allowing larger, magnified
/// documents to pan normally. No image redraw or resize observation is needed.
@MainActor private final class ChatImagePreviewClipView: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var constrained = super.constrainBoundsRect(proposedBounds)
        guard let documentView else { return constrained }
        if documentView.frame.width < constrained.width {
            constrained.origin.x = (documentView.frame.width - constrained.width) / 2
        }
        if documentView.frame.height < constrained.height {
            constrained.origin.y = (documentView.frame.height - constrained.height) / 2
        }
        return constrained
    }
}

/// One stable image document, with NSScrollView as the only zoom engine.
@MainActor private final class ChatImagePreviewScrollView: NSScrollView {
    private let picture = NSImageView()
    private var fitsWindow = true
    private var previousViewportSize = CGSize.zero
    private var applyingFit = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        contentView = ChatImagePreviewClipView()
        allowsMagnification = true
        minMagnification = 0.01
        maxMagnification = 8
        hasHorizontalScroller = true
        hasVerticalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        borderType = .noBorder
        picture.imageScaling = .scaleNone
        picture.animates = true
        picture.autoresizingMask = []
        documentView = picture
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setImage(_ image: NSImage?) {
        picture.image = image
        picture.setFrameOrigin(.zero)
        picture.setFrameSize(image?.size ?? CGSize(width: 1, height: 1))
        fitsWindow = true
        previousViewportSize = .zero
        needsLayout = true
        fitImage()
    }

    override func layout() {
        super.layout()
        let viewport = contentView.frame.size
        guard !applyingFit, viewport != previousViewportSize else { return }
        previousViewportSize = viewport
        if fitsWindow { fitImage() }
    }

    func fitImage() {
        fitsWindow = true
        guard let image = picture.image, image.size.width > 0, image.size.height > 0,
              contentView.frame.width > 0, contentView.frame.height > 0 else { return }
        applyingFit = true
        defer { applyingFit = false }
        let available = contentView.frame.size
        let scale = min(1, max(1, available.width - 16) / image.size.width,
                        max(1, available.height - 16) / image.size.height)
        minMagnification = min(0.05, scale)
        setMagnification(scale, centeredAt: CGPoint(x: image.size.width / 2, y: image.size.height / 2))
        contentView.scroll(to: CGPoint(x: (image.size.width - contentView.bounds.width) / 2,
                                      y: (image.size.height - contentView.bounds.height) / 2))
        reflectScrolledClipView(contentView)
        previousViewportSize = contentView.frame.size
    }

    func zoom(by factor: CGFloat) {
        fitsWindow = false
        zoom(to: magnification * factor)
    }

    func actualSize() {
        fitsWindow = false
        zoom(to: 1)
    }

    private func zoom(to scale: CGFloat) {
        guard picture.image != nil else { return }
        setMagnification(min(maxMagnification, max(minMagnification, scale)),
                         centeredAt: CGPoint(x: contentView.bounds.midX, y: contentView.bounds.midY))
    }

    override func magnify(with event: NSEvent) {
        fitsWindow = false
        super.magnify(with: event)
    }

    override func smartMagnify(with event: NSEvent) {
        fitsWindow = false
        super.smartMagnify(with: event)
    }
}

/// Originals share the authenticated in-memory resource pipeline with thumbnails.
@MainActor final class ChatImageGalleryViewer: NSObject, NSWindowDelegate {
    static let shared = ChatImageGalleryViewer()
    private var window: NSWindow?
    private var preview: ChatImagePreviewScrollView?
    private var images: [ChatTimelineImage] = []
    private var index = 0
    private var counter: NSTextField?
    private var loadTask: Task<Void, Never>?
    private var zoomControls: [NSButton] = []

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
            window.contentMinSize = CGSize(width: 480, height: 280)
            let scroll = ChatImagePreviewScrollView()
            scroll.translatesAutoresizingMaskIntoConstraints = false
            let previous = symbolButton("chevron.left", title: L10n("Previous"), action: #selector(previousImage))
            let next = symbolButton("chevron.right", title: L10n("Next"), action: #selector(nextImage))
            let retry = symbolButton("arrow.clockwise", title: L10n("Retry"), action: #selector(retryImage))
            let zoomOut = symbolButton("minus.magnifyingglass", title: L10n("缩小"), action: #selector(zoomOutImage))
            let zoomIn = symbolButton("plus.magnifyingglass", title: L10n("放大"), action: #selector(zoomInImage))
            let fit = NSButton(title: L10n("适应窗口"), target: self, action: #selector(fitImage))
            let actual = NSButton(title: "100%", target: self, action: #selector(actualSizeImage))
            for (button, key) in [(zoomOut, "-"), (zoomIn, "="), (fit, "0"), (actual, "1")] {
                button.keyEquivalent = key
                button.keyEquivalentModifierMask = .command
            }
            zoomControls = [zoomOut, zoomIn, fit, actual]
            let count = NSTextField(labelWithString: "")
            let controls = NSStackView(views: [previous, count, next, retry, zoomOut, zoomIn, fit, actual])
            controls.orientation = .horizontal
            controls.spacing = 8
            controls.translatesAutoresizingMaskIntoConstraints = false
            let content = NSView()
            content.addSubview(scroll)
            content.addSubview(controls)
            window.contentView = content
            NSLayoutConstraint.activate([
                scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
                scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -8),
                scroll.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
                scroll.bottomAnchor.constraint(equalTo: controls.topAnchor, constant: -8),
                controls.centerXAnchor.constraint(equalTo: content.centerXAnchor),
                controls.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 8),
                controls.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -8),
                controls.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8)
            ])
            self.window = window; self.preview = scroll; self.counter = count
            window.center()
        }
        display()
        window?.makeKeyAndOrderFront(nil)
    }
    private func display() {
        guard images.indices.contains(index) else { return }
        loadTask?.cancel()
        preview?.setImage(nil)
        zoomControls.forEach { $0.isEnabled = false }
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
                self?.preview?.setImage(image)
                self?.zoomControls.forEach { $0.isEnabled = true }
                if let self { self.counter?.stringValue = "\(self.index + 1) / \(self.images.count)" }
            } catch {
                if !Task.isCancelled { self?.counter?.stringValue = L10n("Image unavailable. Try again.") }
            }
        }
    }
    @objc private func previousImage() { index = max(0, index - 1); display() }
    @objc private func nextImage() { index = min(images.count - 1, index + 1); display() }
    @objc private func retryImage() { display() }
    @objc private func zoomOutImage() { preview?.zoom(by: 1 / 1.25) }
    @objc private func zoomInImage() { preview?.zoom(by: 1.25) }
    @objc private func fitImage() { preview?.fitImage() }
    @objc private func actualSizeImage() { preview?.actualSize() }

    private func symbolButton(_ symbol: String, title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title) {
            button.image = image
            button.imagePosition = .imageOnly
        }
        button.toolTip = title
        button.setAccessibilityLabel(title)
        return button
    }
    func windowWillClose(_ notification: Notification) {
        loadTask?.cancel()
        preview?.setImage(nil)
        images = []
    }
}
