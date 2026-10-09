import Foundation

/// Explicit image URLs use an isolated, credential-free session, never the
/// authenticated backend transport. Bytes and request duration are bounded.
public enum ClientRemoteImageDownload {
    private static let session = URLSession(configuration: .ephemeral)
    public static func read(_ url: URL) async throws -> Data {
        let requestTask = Task.detached(priority: .utility) { try await download(url) }
        return try await withTaskCancellationHandler {
            try await requestTask.value
        } onCancel: {
            requestTask.cancel()
        }
    }

    private static func download(_ url: URL) async throws -> Data {
        try Task.checkCancellation()
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil else { throw URLError(.unsupportedURL) }
        let maximum = 20 * 1024 * 1024
        let (bytes, response) = try await session.bytes(for: URLRequest(url: url, timeoutInterval: 20))
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              response.expectedContentLength <= maximum else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            if data.count & 16_383 == 0 { try Task.checkCancellation() }
            guard data.count < maximum else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        guard !data.isEmpty else { throw URLError(.zeroByteResource) }
        return data
    }
}
