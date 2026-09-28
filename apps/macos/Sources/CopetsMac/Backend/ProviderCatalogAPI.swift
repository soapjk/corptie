import Foundation
import CorptieClientCore

@MainActor
struct ProviderCatalogAPI {
    let baseURL: URL
    let urlSession: URLSession

    func providers() async throws -> AgentProvidersResponse {
        try await read(baseURL.appending(path: "providers"))
    }

    func models(for provider: String, forceRefresh: Bool) async throws -> CodexModelsResponse {
        var components = URLComponents(
            url: baseURL.appending(path: "providers/\(provider)/models"),
            resolvingAgainstBaseURL: false
        )!
        if forceRefresh {
            components.queryItems = [URLQueryItem(name: "refresh", value: "true")]
        }
        return try await read(components.url!)
    }

    private func read<Response: Decodable>(_ url: URL) async throws -> Response {
        let (data, response) = try await urlSession.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}
