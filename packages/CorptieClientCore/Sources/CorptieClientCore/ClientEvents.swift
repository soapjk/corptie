import Foundation

public struct ClientInvalidation: Decodable, Sendable {
    public let schemaVersion: Int
    public let inventory: Bool
    public let control: Bool?
    public let sessions: [String]
    public let allSessions: Bool
}

public struct ClientEvents: Sendable {
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }

    /// Every subscription begins with reset. No durable suffix replay is assumed.
    public func subscribe() -> AsyncThrowingStream<ClientInvalidation, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(16)) { continuation in
            let task = Task { [transport] in
                do {
                    var request = try transport.endpoint.request(path: ["client", "v1", "events"])
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = 35
                    let (bytes, response) = try await transport.bytes(for: request)
                    guard response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
                        throw ClientConnectionError.invalidResponse
                    }
                    var parser = ServerSentEventParser()
                    var size = 0
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        size += 1
                        guard size <= 32768 else { throw ClientConnectionError.invalidResponse }
                        let frames = parser.append(byte)
                        for event in frames {
                            size = 0
                            guard !event.isComment else { continue }
                            guard ["reset", "invalidate", "heartbeat"].contains(event.name) else {
                                throw ClientConnectionError.invalidResponse
                            }
                            let update = try JSONDecoder().decode(ClientInvalidation.self, from: Data(event.data.utf8))
                            guard update.schemaVersion == 1 else { throw ClientConnectionError.invalidResponse }
                            switch continuation.yield(update) {
                            case .dropped: throw ClientConnectionError.invalidResponse // reconnect + resync, never silently lose invalidations
                            case .terminated: return
                            case .enqueued: break
                            @unknown default: throw ClientConnectionError.invalidResponse
                            }
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
