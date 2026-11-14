import SwiftUI
import UIKit
import Photos
import ImageIO
import Observation
import OSLog
import CorptieClientCore
import CorptieClientSecurity
import CorptieConversation

extension PadConnection {
    func messageImageData(_ resource: ClientMessageImageResource,
                          progress: @escaping @MainActor (ClientImageProgress) -> Void = { _ in },
                          recovering: @escaping @MainActor (Int) -> Void = { _ in }) async throws -> Data {
        let owner = messageImageOwnerID
        let transfer = ClientImageTransfer(resource: resource)
        for attempt in 0..<3 {
            do {
                try Task.checkCancellation()
                let transport = try await transport()
                try Task.checkCancellation()
                guard owner == messageImageOwnerID else { throw CancellationError() }
                let result = try await messageImageRepository.data(resource, fetch: { callback in
                    try await ClientSessionAPI(transport: transport).messageImage(resource, transfer: transfer, progress: callback)
                }, progress: progress)
                guard owner == messageImageOwnerID else { throw CancellationError() }
                return result
            } catch {
                ClientFailureDiagnostics.log(error, operation: "image.download.attempt.\(attempt + 1)")
                let code = (error as NSError)
                guard !Task.isCancelled, owner == messageImageOwnerID, attempt < 2,
                      ((code.domain == NSURLErrorDomain &&
                      [NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet].contains(code.code))
                       || (error as? CloudRelayTransportError) == .disconnected)
                else { throw error }
                recovering(attempt + 1)
                try await Task.sleep(for: .seconds(attempt + 1))
            }
        }
        throw URLError(.networkConnectionLost)
    }
}

@MainActor @Observable final class PadImageGallerySession {
    typealias Download = @MainActor (ClientMessageImageResource, @escaping @MainActor (ClientImageProgress) -> Void) async throws -> Data
    @ObservationIgnored private let download: Download?
    let resources: [ClientMessageImageResource]
    var selection: Int {
        didSet {
            guard oldValue != selection else { return }
            cancel()
            image = previewImage(); bytes = nil; failure = nil; progress = nil
        }
    }
    private let previews: [UIImage?]
    private var request: Task<Void, Never>?
    private var requestID = UUID()
    private(set) var loading = false
    var canSave: Bool { bytes != nil && !loading }
    private func previewImage() -> UIImage? { previews.indices.contains(selection) ? previews[selection] : nil }
    func cancel() {
        request?.cancel(); request = nil; requestID = UUID()
        loading = false; decoding = false
    }
    func requestOriginal(connection: PadConnection) {
        guard !loading, !canSave else { return }
        loading = true
        let token = UUID(); requestID = token
        request = Task {
            await load(connection: connection, token: token)
            if requestID == token { loading = false; request = nil }
        }
    }
    private(set) var image: UIImage?
    private(set) var progress: ClientImageProgress?
    private(set) var failure: String?
    private(set) var saving = false
    private(set) var decoding = false
    private(set) var retryAttempt = 0
    private static let log = Logger(subsystem: "com.corptie.client", category: "ImageGallery")
    var saveMessage: String?
    private var bytes: Data?
    init(resources: [ClientMessageImageResource], selected: Int, previews: [UIImage?] = [], download: Download? = nil) {
        self.download = download
        self.previews = previews
        self.resources = resources; selection = selected
        image = previews.indices.contains(selected) ? previews[selected] : nil
    }
    private func load(connection: PadConnection, token: UUID) async {
        guard !Task.isCancelled, requestID == token, resources.indices.contains(selection) else { return }
        let owner = connection.messageImageOwnerID
        let current = selection
        bytes = nil; progress = nil; failure = nil; decoding = false; retryAttempt = 0
        let traceID = UUID().uuidString
        Self.log.info("Image load started: request=\(traceID, privacy: .public)")
        do {
            let receive: @MainActor (ClientImageProgress) -> Void = { [weak self] value in
                guard self?.requestID == token, self?.selection == current, connection.messageImageOwnerID == owner else { return }
                self?.retryAttempt = 0
                self?.progress = value
            }
            let data: Data
            if let download {
                data = try await download(resources[current], receive)
            } else {
                data = try await connection.messageImageData(resources[current].withVariant(.original),
                    progress: receive, recovering: { [weak self] attempt in
                        guard self?.requestID == token, self?.selection == current,
                              connection.messageImageOwnerID == owner else { return }
                        self?.retryAttempt = attempt
                        self?.progress = nil
                    })
            }
            try Task.checkCancellation()
            guard requestID == token else { return }
            decoding = true
            Self.log.info("Image download completed: request=\(traceID, privacy: .public) bytes=\(data.count)")
            let decodeTask = Task.detached(priority: .userInitiated) { try Self.decode(data) }
            let decoded = try await withTaskCancellationHandler { try await decodeTask.value } onCancel: { decodeTask.cancel() }
            try Task.checkCancellation()
            guard requestID == token, current == selection, owner == connection.messageImageOwnerID else { return }
            decoding = false
            Self.log.info("Image decode completed: request=\(traceID, privacy: .public)")
            bytes = data; image = decoded
        } catch {
            guard requestID == token else { return }
            decoding = false
            ClientFailureDiagnostics.log(error, operation: "image.gallery.\(traceID)")
            if !Task.isCancelled, current == selection {
                if let error = error as? URLError {
                    switch error.code {
                    case .timedOut: failure = "图片传输长时间没有进展，请重试。"
                    case .networkConnectionLost, .notConnectedToInternet: failure = "连接中断，自动重试未完成，请重试。"
                    case .cannotDecodeContentData: failure = "图片校验或解码失败，请重试。"
                    case .dataLengthExceedsMaximum: failure = "图片超出大小或解码内存限制。"
                    default: failure = "图片暂时无法打开，请重试。"
                    }
                } else if let error = error as? ClientServiceFailure, [403, 404].contains(error.statusCode) {
                    failure = "图片已移除或当前会话无权访问。"
                } else { failure = "图片暂时无法打开，请重试。" }
            }
        }
    }
    nonisolated private static func decode(_ data: Data) throws -> UIImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw URLError(.cannotDecodeContentData) }
        let count = CGImageSourceGetCount(source)
        // Retain animation rather than silently turning it into its first frame.
        guard count <= 60 else { throw URLError(.dataLengthExceedsMaximum) }
        var frames: [UIImage] = [], cost = 0, duration: Double = 0
        for index in 0..<count {
            try Task.checkCancellation()
            let edge = count > 1 ? 1024 : 3456
            guard cost <= 48 * 1024 * 1024 - edge * edge * 4 else { throw URLError(.dataLengthExceedsMaximum) }
            guard let bitmap = CGImageSourceCreateThumbnailAtIndex(source, index, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: edge,
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary) else { throw URLError(.cannotDecodeContentData) }
            cost += bitmap.bytesPerRow * bitmap.height
            guard cost <= 48 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            frames.append(UIImage(cgImage: bitmap))
            let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            duration += max(0.02, (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
                ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1)
        }
        guard let first = frames.first else { throw URLError(.cannotDecodeContentData) }
        return count > 1 ? (UIImage.animatedImage(with: frames, duration: duration) ?? first) : first
    }
    func save() async {
        guard canSave, !saving, let bytes else { return }
        saving = true
        defer { saving = false }
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            saveMessage = "未获相册添加权限。可在系统设置中允许 Corptie 添加照片。"; return
        }
        do {
            // Photos invokes this block on its own queue. Do not inherit MainActor:
            // Swift 6 otherwise inserts an executor assertion and terminates the app.
            try await PHPhotoLibrary.shared().performChanges { @Sendable in
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: bytes, options: nil)
            }
            saveMessage = "已保存原图到相册。"
        } catch {
            ClientFailureDiagnostics.log(error, operation: "image.save")
            saveMessage = "保存失败，请检查相册权限及设备可用空间后重试。"
        }
    }
}

struct PadZoomableImage: UIViewRepresentable {
    let image: UIImage
    func makeUIView(context: Context) -> ImageScrollView { ImageScrollView() }
    func updateUIView(_ view: ImageScrollView, context: Context) { view.setImage(image) }

    final class ImageScrollView: UIScrollView, UIScrollViewDelegate {
        private let picture = UIImageView()
        private var previousBounds: CGSize = .zero
        override init(frame: CGRect) {
            super.init(frame: frame)
            delegate = self; maximumZoomScale = 8; minimumZoomScale = 1
            addSubview(picture)
            let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom))
            doubleTap.numberOfTapsRequired = 2; addGestureRecognizer(doubleTap)
            accessibilityLabel = "图片预览，可双指缩放"
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        func setImage(_ image: UIImage) {
            guard picture.image !== image else { return }
            zoomScale = 1; picture.image = image
            picture.frame = CGRect(origin: .zero, size: image.size)
            contentSize = image.size
            previousBounds = .zero; setNeedsLayout()
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            guard let image = picture.image, bounds.width > 0, bounds.height > 0 else { return }
            if previousBounds != bounds.size {
                let relative = previousBounds == .zero ? 1 : zoomScale / minimumZoomScale
                previousBounds = bounds.size
                minimumZoomScale = min(bounds.width / image.size.width, bounds.height / image.size.height)
                maximumZoomScale = max(8 * minimumZoomScale, 1)
                zoomScale = min(maximumZoomScale, minimumZoomScale * relative)
            }
            picture.center = CGPoint(x: max(contentSize.width, bounds.width) / 2,
                                     y: max(contentSize.height, bounds.height) / 2)
        }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { setNeedsLayout() }
        @objc private func toggleZoom() {
            setZoomScale(zoomScale > minimumZoomScale * 1.1 ? minimumZoomScale : min(maximumZoomScale, minimumZoomScale * 2.5), animated: true)
        }
    }
}
