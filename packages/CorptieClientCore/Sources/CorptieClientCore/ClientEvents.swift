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

    public func subscribeRealtime(
        sessionId: String?,
        stateRevision: Int = 0,
        timelineRevision: Int = 0
    ) -> AsyncThrowingStream<ClientRealtimeUpdate, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(64)) { continuation in
            let task = Task { [transport] in
                do {
                    var query = [URLQueryItem(name: "stateRevision", value: String(stateRevision)),
                                 URLQueryItem(name: "timelineRevision", value: String(timelineRevision))]
                    if let sessionId { query.append(URLQueryItem(name: "sessionId", value: sessionId)) }
                    var request = try transport.endpoint.request(path: ["client", "v2", "events"], query: query)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = .infinity
                    let (bytes, response) = try await transport.bytes(for: request)
                    guard response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
                        throw ClientConnectionError.invalidResponse
                    }
                    var parser = ServerSentEventParser()
                    var size = 0
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        size += 1
                        guard size <= 8 * 1024 * 1024 else { throw ClientConnectionError.invalidResponse }
                        for event in parser.append(byte) {
                            size = 0
                            guard !event.isComment else { continue }
                            let data = Data(event.data.utf8)
                            let update: ClientRealtimeUpdate
                            switch event.name {
                            case "stream-ready": update = .ready(try JSONDecoder().decode(ClientRealtimeReady.self, from: data))
                            case "state-snapshot": update = .state(try JSONDecoder().decode(ClientStateSnapshot.self, from: data))
                            case "control-snapshot": update = .control(try JSONDecoder().decode(ClientControlSnapshot.self, from: data))
                            case "timeline-snapshot": update = .timelineSnapshot(try JSONDecoder().decode(ClientTimelineSnapshot.self, from: data))
                            case "timeline-delta": update = .timelineDelta(try JSONDecoder().decode(ClientTimelineDelta.self, from: data))
                            case "command-receipt": update = .receipt(try JSONDecoder().decode(ClientCommandReceipt.self, from: data))
                            case "heartbeat": update = .heartbeat
                            default: throw ClientConnectionError.invalidResponse
                            }
                            switch continuation.yield(update) {
                            case .dropped: throw ClientConnectionError.invalidResponse
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

public struct ClientRealtimeReady: Decodable, Sendable {
    public let schemaVersion: Int
    public let pushPayloads: Bool
    public let eventRecovery: String
}

public struct ClientStateSnapshot: Decodable, Sendable {
    public let schemaVersion: Int
    public let revision: Int
    public let works: [ClientWork]
    public let tasks: [ClientTask]
    public let sessions: [ClientSession]
}

public struct ClientControlSnapshot: Decodable, Sendable {
    public let schemaVersion: Int
    public let automations: [ClientControlItem]
    public let repositories: [ClientControlItem]
    public let agents: [ClientControlItem]
    public let skills: [ClientControlItem]
}

public struct ClientTimelineSnapshot: Decodable, Sendable {
    public let schemaVersion: Int
    public let kind: String
    public let sessionId: String
    public let revision: Int
    public let messages: ClientMessagePage
    public let capabilities: ClientSessionCapabilities
    public let usage: ClientSessionUsage?
    public let composer: ClientComposerConfiguration?
}

public struct ClientTimelineChange: Decodable, Sendable {
    public let revision: Int
    public let itemId: String
    public let operation: String
    public let item: ClientMessage?
}

public struct ClientTimelineDelta: Decodable, Sendable {
    public let schemaVersion: Int
    public let kind: String
    public let sessionId: String
    public let snapshotRequired: Bool
    public let baseRevision: Int
    public let revision: Int
    public let currentRevision: Int
    public let hasMore: Bool
    public let changes: [ClientTimelineChange]
}

public enum ClientRealtimeUpdate: Sendable {
    case ready(ClientRealtimeReady)
    case state(ClientStateSnapshot)
    case control(ClientControlSnapshot)
    case timelineSnapshot(ClientTimelineSnapshot)
    case timelineDelta(ClientTimelineDelta)
    case receipt(ClientCommandReceipt)
    case heartbeat
}
