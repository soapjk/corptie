import Foundation

/// A reference, not filesystem authority. The backend validates the exact owning message.
public struct ClientMessageImageResource: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case managed(path: String)
        case messageReference(destination: String)
        case publicRemote(url: URL)
    }
    public let sessionID: String
    public let sourceItemID: String
    public let source: Source

    public init(sessionID: String, sourceItemID: String, source: Source) {
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
    func messageImage(_ resource: ClientMessageImageResource, route: MessageImageRoute = .paired,
                      progress: @escaping @Sendable (ClientImageProgress) -> Void = { _ in }) async throws -> Data {
        let request: URLRequest
        let prefix = route == .paired ? ["client", "v1", "sessions"] : ["sessions"]
        switch resource.source {
        case .managed(let path):
            request = try transport.endpoint.request(path: prefix + [resource.sessionID, "images"],
                query: [.init(name: "path", value: path)])
        case .messageReference(let destination):
            request = try transport.endpoint.request(path: prefix + [resource.sessionID, "resources"],
                query: [.init(name: "itemId", value: resource.sourceItemID), .init(name: "path", value: destination)])
        case .publicRemote(let url):
            return try await ClientRemoteImageDownload.read(url, progress: progress)
        }
        return try await transport.imageData(for: request, progress: progress)
    }
}

enum ClientImageDataCollector {
    static let maximum = 20 * 1024 * 1024

    static func collect<Bytes: AsyncSequence>(_ bytes: Bytes, total: Int64?,
        progress: @escaping @Sendable (ClientImageProgress) -> Void) async throws -> Data where Bytes.Element == UInt8 {
        guard total == nil || total! <= maximum else { throw URLError(.dataLengthExceedsMaximum) }
        var result = Data()
        if let total { result.reserveCapacity(Int(total)) }
        var last = ContinuousClock.now
        progress(.init(received: 0, total: total))
        for try await byte in bytes {
            guard result.count < maximum else { throw URLError(.dataLengthExceedsMaximum) }
            result.append(byte)
            if result.count & 16_383 == 0 {
                try Task.checkCancellation()
                if last.duration(to: .now) >= .milliseconds(100) {
                    last = .now
                    progress(.init(received: Int64(result.count), total: total))
                }
            }
        }
        try Task.checkCancellation()
        guard !result.isEmpty else { throw URLError(.zeroByteResource) }
        progress(.init(received: Int64(result.count), total: total))
        return result
    }
}
