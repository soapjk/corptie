import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
final class ChatTimelineImageLoader {
    static let shared = ChatTimelineImageLoader()
    private let cache = NSCache<NSURL, NSImage>()

    private init() {
        cache.totalCostLimit = 64 * 1_024 * 1_024
        cache.countLimit = 160
    }

    func load(_ url: URL, completion: @escaping (NSImage?) -> Void) {
        if let image = cache.object(forKey: url as NSURL) {
            completion(image)
            return
        }
        if url.isFileURL {
            Task { [weak self] in
                let data = await Task.detached(priority: .userInitiated) {
                    try? Data(contentsOf: url, options: .mappedIfSafe)
                }.value
                let image = data.flatMap(NSImage.init(data:))
                self?.store(image, for: url)
                completion(image)
            }
            return
        }
        Task { [weak self] in
            let data = try? await URLSession.shared.data(from: url).0
            let image = data.flatMap(NSImage.init(data:))
            self?.store(image, for: url)
            completion(image)
        }
    }

    private func store(_ image: NSImage?, for url: URL) {
        guard let image else { return }
        let pixels = Int(image.size.width * image.size.height)
        cache.setObject(image, forKey: url as NSURL, cost: min(pixels * 4, 20 * 1_024 * 1_024))
    }
}
