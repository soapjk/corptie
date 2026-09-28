import CorptieClientCore
import Foundation

/// Owns the canonical wake-event connection and its replay cursor. Domain
/// handlers finish before acknowledgement; durable state remains elsewhere.
@MainActor
final class BackendEventStream {
    private let baseURL: URL
    private let urlSession: URLSession
    private var task: Task<Void, Never>?
    private var cursor = 0

    init(baseURL: URL, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    func start(
        connected: @escaping @MainActor () async -> Void,
        disconnected: @escaping @MainActor () -> Void,
        receive: @escaping @MainActor (String, String) async -> Void
    ) {
        stop()
        task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                var components = URLComponents(
                    url: baseURL.appending(path: "events"),
                    resolvingAgainstBaseURL: false
                )!
                components.queryItems = [URLQueryItem(name: "cursor", value: String(cursor))]
                var request = URLRequest(url: components.url!)
                request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                do {
                    let (bytes, response) = try await urlSession.bytes(for: request)
                    guard !Task.isCancelled else { return }
                    guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                        throw URLError(.badServerResponse)
                    }
                    await connected()
                    guard !Task.isCancelled else { return }
                    for try await event in ServerSentEventStream.events(from: bytes) {
                        guard !Task.isCancelled else { return }
                        if event.isComment { continue }
                        await receive(event.name, event.data)
                        guard !Task.isCancelled else { return }
                        // Never acknowledge an event before its domain handler
                        // returns, or let a cancelled connection advance replay.
                        cursor = Self.acknowledgedCursor(current: cursor, event: event)
                    }
                    guard !Task.isCancelled else { return }
                    disconnected()
                } catch {
                    guard !Task.isCancelled else { return }
                    disconnected()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        // A reconnect, including a Data Root handoff, keeps the existing cursor.
        // EventReplayRequired can explicitly rebase it against the new backend.
    }

    nonisolated static func acknowledgedCursor(current: Int, event: ServerSentEvent) -> Int {
        if event.isComment { return current }
        if event.name == "EventReplayRequired",
           let payload = event.data.data(using: .utf8),
           let replay = try? JSONDecoder().decode(ReplayRequired.self, from: payload) {
            return max(0, replay.latestCursor)
        }
        if let eventID = event.id.flatMap(Int.init) {
            return max(current, eventID)
        }
        return current
    }

    private struct ReplayRequired: Decodable {
        let latestCursor: Int
    }
}
