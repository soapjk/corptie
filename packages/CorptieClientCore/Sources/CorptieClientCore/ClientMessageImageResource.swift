import Foundation
import CryptoKit
import OSLog

/// A reference, not filesystem authority. The backend validates the exact owning message.
public struct ClientMessageImageResource: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case managed(path: String)
        case messageReference(destination: String)
        case publicRemote(url: URL)
    }
    public enum Variant: String, Equatable, Sendable { case preview, original }
    public let variant: Variant
    public func withVariant(_ variant: Variant) -> Self {
        .init(sessionID: sessionID, sourceItemID: sourceItemID, source: source, variant: variant)
    }
    public let sessionID: String
    public let sourceItemID: String
    public let source: Source

    public init(sessionID: String, sourceItemID: String, source: Source, variant: Variant = .original) {
        self.variant = variant
        self.sessionID = sessionID
        self.sourceItemID = sourceItemID
        self.source = source
    }

    public static func reference(sessionID: String, itemID: String, url: URL) -> Self {
        let source: Source = ["https", "http"].contains(url.scheme?.lowercased() ?? "")
            ? .publicRemote(url: url) : .messageReference(destination: url.absoluteString)
        return .init(sessionID: sessionID, sourceItemID: itemID, source: source)
    }

    public var name: String {
        switch source {
        case .managed(let path), .messageReference(let path): URL(string: path)?.lastPathComponent ?? "image"
        case .publicRemote(let url): url.lastPathComponent
        }
    }
}

public struct ClientImageProgress: Sendable {
    public let received: Int64
    public let total: Int64?
    public var fraction: Double? {
        total.flatMap { $0 > 0 ? min(1, Double(received) / Double($0)) : nil }
    }
    public init(received: Int64, total: Int64?) { self.received = received; self.total = total }
}

public extension ClientSessionAPI {
    enum MessageImageRoute: Sendable { case paired, desktop }
    /// Same bounded authenticated read for thumbnails, originals and explicit saves.
    func messageImage(_ resource: ClientMessageImageResource, transfer: ClientImageTransfer? = nil, route: MessageImageRoute = .paired,
                      progress: @escaping @Sendable (ClientImageProgress) -> Void = { _ in }) async throws -> Data {
        var request: URLRequest
        let prefix = route == .paired ? ["client", "v1", "sessions"] : ["sessions"]
        switch resource.source {
        case .managed(let path):
            request = try transport.endpoint.request(path: prefix + [resource.sessionID, "images"],
                query: [.init(name: "path", value: path), .init(name: "variant", value: resource.variant.rawValue)])
        case .messageReference(let destination):
            request = try transport.endpoint.request(path: prefix + [resource.sessionID, "resources"],
                query: [.init(name: "itemId", value: resource.sourceItemID), .init(name: "path", value: destination), .init(name: "variant", value: resource.variant.rawValue)])
        case .publicRemote(let url):
            guard resource.variant == .original else { throw URLError(.resourceUnavailable) }
            return try await ClientRemoteImageDownload.read(url, progress: progress)
        }
        let requestID = UUID().uuidString
        request.setValue(requestID, forHTTPHeaderField: "X-Corptie-Request-Id")
        let log = Logger(subsystem: "com.corptie.client", category: "ImageDownload")
        log.info("Image request started: request=\(requestID, privacy: .public)")
        let data = try await transport.imageData(for: request, transfer: resource.variant == .original ? transfer : nil, preview: resource.variant == .preview, progress: progress)
        if resource.variant == .original, case .messageReference(let destination) = resource.source,
           let url = URLComponents(string: destination), url.scheme == "artifact",
           let expected = url.queryItems?.first(where: { $0.name == "hash" })?.value {
            let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard actual == expected else { throw URLError(.cannotDecodeContentData) }
        }
        log.info("Image verified: request=\(requestID, privacy: .public) bytes=\(data.count)")
        return data
    }
}

enum ClientImageDataCollector {
    static let maximum = 20 * 1024 * 1024

    static func collect<Bytes: AsyncSequence>(_ bytes: Bytes, total: Int64?,
        progress: @escaping @Sendable (ClientImageProgress) -> Void,
        maximum: Int = ClientImageDataCollector.maximum,
        chunk: @Sendable (Data) throws -> Void = { _ in }) async throws -> Data where Bytes.Element == UInt8 {
        guard total == nil || total! <= maximum else { throw URLError(.dataLengthExceedsMaximum) }
        var result = Data()
        if let total { result.reserveCapacity(Int(total)) }
        var last = ContinuousClock.now
        var pending = Data()
        progress(.init(received: 0, total: total))
        for try await byte in bytes {
            guard result.count < maximum else { throw URLError(.dataLengthExceedsMaximum) }
            result.append(byte)
            pending.append(byte)
            if result.count & 16_383 == 0 {
                try chunk(pending); pending.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
                if last.duration(to: .now) >= .milliseconds(100) {
                    last = .now
                    progress(.init(received: Int64(result.count), total: total))
                }
            }
        }
        if !pending.isEmpty { try chunk(pending) }
        try Task.checkCancellation()
        guard !result.isEmpty else { throw URLError(.zeroByteResource) }
        guard total == nil || Int64(result.count) == total else { throw URLError(.networkConnectionLost) }
        progress(.init(received: Int64(result.count), total: total))
        return result
    }
}
