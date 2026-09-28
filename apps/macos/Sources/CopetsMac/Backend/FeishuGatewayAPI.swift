import Foundation
import CorptieClientCore

/// Typed gateway requests. No observation, UI state, inventory cache or retries.
@MainActor
struct FeishuGatewayAPI {
    let baseURL: URL
    let urlSession: URLSession
    let decodeError: (Data) -> String?

    func bots() async throws -> [FeishuBot] {
        let (data, response) = try await urlSession.data(from: baseURL.appending(path: "feishu/bots"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(FeishuBotsResponse.self, from: data).bots
    }

    func profiles() async throws -> [FeishuProfile] {
        let (data, response) = try await urlSession.data(from: baseURL.appending(path: "feishu/profiles"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(FeishuProfilesResponse.self, from: data).profiles
    }

    func pairingCode(botID: String) async throws -> FeishuPairingCodeResponse {
        let data = try await send(
            method: "POST", path: "feishu/bots/\(botID)/pairing-code", body: [:],
            fallbackError: "Could not create pairing code."
        )
        return try JSONDecoder().decode(FeishuPairingCodeResponse.self, from: data)
    }

    func mutate(method: String, path: String, body: [String: Any]?) async throws {
        _ = try await send(
            method: method, path: path, body: body,
            fallbackError: "Feishu gateway request failed."
        )
    }

    private func send(
        method: String, path: String, body: [String: Any]?, fallbackError: String
    ) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw BackendError.message(decodeError(data) ?? fallbackError)
        }
        return data
    }
}
