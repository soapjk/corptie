import Foundation

@MainActor
protocol SessionUsageServing: AnyObject {
    func cached(for sessionID: String) -> SessionUsageResponse?
    func remember(_ usage: SessionUsageResponse, for sessionID: String)
    func fetch(for sessionID: String) async throws -> SessionUsageResponse?
    func fetchFreshAccount(for sessionID: String) async throws -> SessionUsageResponse?
    func applyingEvent(_ data: String, sessionID: String?, current: SessionUsageResponse?) -> SessionUsageResponse?
}

/// Usage transport and per-Session cache; refresh coordination is separate.
@MainActor
final class SessionUsageClient: SessionUsageServing {
    private let baseURL: URL
    private let urlSession: URLSession
    private var cachedUsage: [String: SessionUsageResponse] = [:]

    init(baseURL: URL, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    func cached(for sessionID: String) -> SessionUsageResponse? {
        cachedUsage[sessionID]
    }

    func remember(_ usage: SessionUsageResponse, for sessionID: String) {
        cachedUsage[sessionID] = usage
    }

    func fetch(for sessionID: String) async throws -> SessionUsageResponse? {
        try await fetch(for: sessionID, requireFreshAccount: false)
    }

    func fetchFreshAccount(for sessionID: String) async throws -> SessionUsageResponse? {
        try await fetch(for: sessionID, requireFreshAccount: true)
    }

    private func fetch(for sessionID: String, requireFreshAccount: Bool) async throws -> SessionUsageResponse? {
        let url = baseURL.appending(path: "sessions/\(sessionID)/usage")
        let requestURL = requireFreshAccount
            ? url.appending(queryItems: [URLQueryItem(name: "freshAccount", value: "1")])
            : url
        var request = URLRequest(url: requestURL)
        if requireFreshAccount {
            request.cachePolicy = .reloadIgnoringLocalCacheData
        }
        let (data, response) = try await urlSession.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { return nil }
        return try JSONDecoder().decode(SessionUsageResponse.self, from: data)
    }

    func applyingEvent(
        _ data: String, sessionID: String?, current: SessionUsageResponse?
    ) -> SessionUsageResponse? {
        guard let payload = data.data(using: .utf8),
              let event = try? JSONDecoder().decode(SessionUsageEventEnvelope.self, from: payload),
              sessionID == event.payload.sessionId else { return nil }
        let account = current?.account ?? CodexAccountUsage(
            available: nil, provider: "codex", model: nil,
            rateLimits: nil, rateLimitsByLimitId: nil
        )
        let usage = SessionUsageResponse(
            account: account, context: event.payload.context,
            accountFresh: current?.accountFresh,
            resetForecast: current?.resetForecast
        )
        remember(usage, for: event.payload.sessionId)
        return usage
    }
}
