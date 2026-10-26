import SwiftUI
import UIKit
import Photos
import ImageIO
import Observation
import CorptieClientCore
import CorptieConversation

extension PadConnection {
    func messageImageData(_ resource: ClientMessageImageResource,
                          progress: @escaping @MainActor (ClientImageProgress) -> Void = { _ in }) async throws -> Data {
        let owner = messageImageOwnerID
        let transport = try await transport()
        guard owner == messageImageOwnerID else { throw CancellationError() }
        let result = try await messageImageRepository.data(resource, fetch: { callback in
            try await ClientSessionAPI(transport: transport).messageImage(resource, progress: callback)
        }, progress: progress)
        guard owner == messageImageOwnerID else { throw CancellationError() }
        return result
    }
}

@MainActor @Observable final class PadImageGallerySession {
    let resources: [ClientMessageImageResource]
    var selection: Int
    private(set) var image: UIImage?
    private(set) var progress: ClientImageProgress?
    private(set) var failure: String?
    private(set) var saving = false
    var saveMessage: String?
    private var bytes: Data?
    private var loadedSelection: Int?
    private var loadedOwner: String?
    init(resources: [ClientMessageImageResource], selected: Int) {
        self.resources = resources; selection = selected
    }
    func load(connection: PadConnection) async {
        guard resources.indices.contains(selection) else { return }
        let owner = connection.messageImageOwnerID
        if loadedSelection == selection, loadedOwner == owner, image != nil { return }
        let current = selection
        image = nil; bytes = nil; progress = nil; failure = nil
        do {
            let data = try await connection.messageImageData(resources[current]) { [weak self] value in
                guard self?.selection == current, connection.messageImageOwnerID == owner else { return }
                self?.progress = value
            }
            let decoded = try await Task.detached(priority: .userInitiated) { try Self.decode(data) }.value
            try Task.checkCancellation()
            guard current == selection, owner == connection.messageImageOwnerID else { return }
            bytes = data; image = decoded; loadedSelection = current; loadedOwner = owner
        } catch {
            if !Task.isCancelled, current == selection {
                failure = "图片暂时无法打开。请检查连接；图片也可能已移除、超出内存限制或不在此会话权限内。"
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
        guard !saving, let bytes else { return }
        saving = true
        defer { saving = false }
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            saveMessage = "未获相册添加权限。可在系统设置中允许 Corptie 添加照片。"; return
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: bytes, options: nil)
            }
            saveMessage = "已保存原图到相册。"
        } catch { saveMessage = "保存失败，请检查相册权限及设备可用空间后重试。" }
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
