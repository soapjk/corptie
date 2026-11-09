import CorptieClientCore
import Foundation

/// Owns the canonical wake-event connection and its replay cursor. Domain
/// handlers finish before acknowledgement; durable state remains elsewhere.
@MainActor
final class BackendEventStream {
    private let baseURL: URL
    private let urlSession: URLSession
    private var task: Task<Void, Never>?
    private var connectedTask: Task<Void, Never>?
    private var cursor = 0
    private var generation: UInt64 = 0

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
        let generation = self.generation
        task = Task { [weak self] in
            guard let self else { return }
            var failureLogged = false
            while !Task.isCancelled, generation == self.generation {
                var components = URLComponents(
                    url: baseURL.appending(path: "events"),
                    resolvingAgainstBaseURL: false
                )!
                components.queryItems = [URLQueryItem(name: "cursor", value: String(cursor))]
                var request = URLRequest(url: components.url!)
                request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                do {
                    let (bytes, response) = try await urlSession.bytes(for: request)
                    guard !Task.isCancelled, generation == self.generation else { return }
                    guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                        if let http = response as? HTTPURLResponse {
                            ClientFailureDiagnostics.log(NSError(domain: "HTTP", code: http.statusCode), operation: "BackendEventStream.response")
                        }
                        throw URLError(.badServerResponse)
                    }
                    failureLogged = false
                    // Reconciliation may perform network reads. Receiving new wakes must
                    // not wait for settings, automation or snapshot hydration.
                    connectedTask?.cancel()
                    connectedTask = Task { await connected() }
                    guard !Task.isCancelled, generation == self.generation else { return }
                    for try await event in ServerSentEventStream.events(from: bytes) {
                        guard !Task.isCancelled, generation == self.generation else { return }
                        if event.isComment { continue }
                        await receive(event.name, event.data)
                        guard !Task.isCancelled, generation == self.generation else { return }
                        // Never acknowledge an event before its domain handler
                        // returns, or let a cancelled connection advance replay.
                        cursor = Self.acknowledgedCursor(current: cursor, event: event)
                    }
                    guard !Task.isCancelled, generation == self.generation else { return }
                    disconnected()
                } catch {
                    guard !Task.isCancelled, generation == self.generation else { return }
                    if !failureLogged {
                        ClientFailureDiagnostics.log(error, operation: "BackendEventStream.start")
                        failureLogged = true
                    }
                    disconnected()
                }
                // Clean EOF and failed connections share the same backoff.
                // Never spin through connected() when a server closes normally.
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        generation &+= 1
        task?.cancel()
        task = nil
        connectedTask?.cancel()
        connectedTask = nil
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
