import Foundation
import Nuke
import CorptieClientCore

/// Connection-owned. Encoded originals never leave memory; Nuke owns coalescing,
/// cancellation and bounded decoding, not authentication or filesystem access.
@MainActor public final class ConversationImageRepository {
    public typealias Fetch = @Sendable (@escaping @Sendable (ClientImageProgress) -> Void) async throws -> Data
    private final class Original: NSObject {
        let data: Data
        let expires = Date().addingTimeInterval(300)
        init(_ data: Data) { self.data = data }
    }
    private let originals = NSCache<NSString, Original>()
    private var pipeline: ImagePipeline
    private var generation = UUID()
    private var observers: [String: [UUID: @MainActor (ClientImageProgress) -> Void]] = [:]

    public init() {
        originals.totalCostLimit = 48 * 1024 * 1024
        originals.countLimit = 32
        pipeline = Self.makePipeline()
    }

    private static func makePipeline() -> ImagePipeline {
        // Never construct Nuke's default DataLoader (which installs URLCache).
        var config = ImagePipeline.Configuration(dataLoader: DisabledImageNetworkLoader())
        config.dataCache = nil
        let cache = ImageCache(costLimit: 48 * 1024 * 1024, countLimit: 160)
        cache.ttl = 300
        config.imageCache = cache
        config.isLocalResourcesSupportEnabled = false
        config.isResumableDataEnabled = false
        config.maximumResponseDataSize = 20 * 1024 * 1024
        config.maximumDecodedImageSize = 48 * 1024 * 1024
        config.dataLoadingQueue = TaskQueue(maxConcurrentOperationCount: 3)
        return ImagePipeline(configuration: config)
    }

    public func invalidate() {
        generation = UUID()
        pipeline.invalidate()
        originals.removeAllObjects()
        observers.removeAll()
        pipeline = Self.makePipeline()
    }

    public static func key(_ resource: ClientMessageImageResource) -> String {
        let source: String
        switch resource.source {
        case .managed(let value): source = "managed:" + value
        case .messageReference(let value): source = "reference:" + value
        case .publicRemote(let value): source = "remote:" + value.absoluteString
        }
        // Length-prefix existing identities; no digest or generated file name.
        return [resource.sessionID, resource.sourceItemID, source].map { "\($0.utf8.count):\($0)" }.joined()
    }

    private func request(_ resource: ClientMessageImageResource, fetch: @escaping Fetch) -> ImageRequest {
        let key = Self.key(resource), owner = generation
        return ImageRequest(id: key, data: { [weak self] in
            if let cached = await self?.cached(key, owner: owner) { return cached }
            let bytes = try await fetch { [weak self] value in
                Task { @MainActor in
                    guard let self, self.generation == owner else { return }
                    for callback in self.observers[key]?.values ?? [:].values { callback(value) }
                }
            }
            try Task.checkCancellation()
            guard !bytes.isEmpty, bytes.count <= 20 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            try await self?.remember(bytes, key: key, owner: owner)
            return bytes
        })
    }

    private func cached(_ key: String, owner: UUID) -> Data? {
        guard owner == generation, let value = originals.object(forKey: key as NSString) else { return nil }
        guard value.expires > Date() else { originals.removeObject(forKey: key as NSString); return nil }
        return value.data
    }
    private func remember(_ data: Data, key: String, owner: UUID) throws {
        guard owner == generation else { throw CancellationError() }
        originals.setObject(Original(data), forKey: key as NSString, cost: data.count)
    }

    public func data(_ resource: ClientMessageImageResource, fetch: @escaping Fetch,
                     progress: @escaping @MainActor (ClientImageProgress) -> Void = { _ in }) async throws -> Data {
        let key = Self.key(resource), token = UUID(), owner = generation
        observers[key, default: [:]][token] = progress
        defer { observers[key]?[token] = nil; if observers[key]?.isEmpty == true { observers[key] = nil } }
        let data = try await pipeline.data(for: request(resource, fetch: fetch)).0
        guard generation == owner else { throw CancellationError() }
        progress(.init(received: Int64(data.count), total: Int64(data.count)))
        return data
    }
}

private struct DisabledImageNetworkLoader: DataLoading {
    struct Token: Cancellable { func cancel() {} }
    func loadData(with request: URLRequest, didReceiveData: @escaping @Sendable (Data, URLResponse) -> Void,
                  completion: @escaping @Sendable (Error?) -> Void) -> any Cancellable {
        completion(URLError(.unsupportedURL))
        return Token()
    }
}
