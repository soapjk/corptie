import Foundation

/// In-memory partial bytes scoped to one immutable Artifact and one download owner.
/// Calls are serialized by the download; the lock also protects transport callbacks.
public final class ClientImageTransfer: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var expectedTotal: Int64?
    private let hash: String
    public init?(resource: ClientMessageImageResource) {
        guard resource.variant == .original, case .messageReference(let destination) = resource.source,
              let url = URLComponents(string: destination), url.scheme == "artifact",
              let version = url.queryItems?.first(where: { $0.name == "version" })?.value,
              let number = Int(version), number > 0,
              let hash = url.queryItems?.first(where: { $0.name == "hash" })?.value,
              hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        self.hash = hash
    }
    func prepare(_ input: URLRequest) -> URLRequest {
        lock.lock(); defer { lock.unlock() }
        if expectedTotal == Int64(bytes.count) { bytes = Data(); expectedTotal = nil }
        var request = input
        if !bytes.isEmpty {
            request.setValue("bytes=\(bytes.count)-", forHTTPHeaderField: "Range")
            request.setValue("\"\(hash)\"", forHTTPHeaderField: "If-Range")
        }
        return request
    }
    func begin(_ response: HTTPURLResponse) throws -> Int64 {
        lock.lock(); defer { lock.unlock() }
        if response.statusCode == 200 {
            bytes = Data()
            expectedTotal = response.expectedContentLength > 0 ? response.expectedContentLength : nil
            return 0
        }
        guard response.statusCode == 206,
              response.value(forHTTPHeaderField: "ETag") == "\"\(hash)\"",
              let range = response.value(forHTTPHeaderField: "Content-Range"),
              range.hasPrefix("bytes \(bytes.count)-"),
              let total = range.split(separator: "/").last.flatMap({ Int($0) }),
              total > bytes.count, total <= 20 * 1024 * 1024,
              range == "bytes \(bytes.count)-\(total - 1)/\(total)",
              response.expectedContentLength == total - bytes.count else { throw URLError(.badServerResponse) }
        expectedTotal = Int64(total)
        return Int64(bytes.count)
    }
    func append(_ chunk: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard chunk.count <= 20 * 1024 * 1024 - bytes.count else { throw URLError(.dataLengthExceedsMaximum) }
        bytes.append(chunk)
    }
    func complete() -> Data { lock.lock(); defer { lock.unlock() }; return bytes }
}
