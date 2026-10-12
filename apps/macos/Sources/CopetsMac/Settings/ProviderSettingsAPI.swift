import Foundation
import CorptieClientCore

@MainActor enum ProviderSettingsAPI {
    static func readTaskDefaults(providerId: String? = nil) async throws -> TaskCreationSettings {
        var url = CorptieAppEnvironment.backendBaseURL.appending(path: "settings/task-creation")
        if let providerId { url.append(queryItems: [URLQueryItem(name: "providerId", value: providerId)]) }
        return try await perform(URLRequest(url: url))
    }

    static func saveTaskDefaults(_ value: TaskCreationDefaults) async throws -> TaskCreationSettings {
        var request = URLRequest(url: CorptieAppEnvironment.backendBaseURL.appending(path: "settings/task-creation"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(value)
        let result = try await perform(request)
        return result
    }

    private static func perform(_ request: URLRequest) async throws -> TaskCreationSettings {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let value = try JSONDecoder().decode(TaskCreationSettings.self, from: data)
        guard value.schemaVersion == 1 else { throw URLError(.cannotParseResponse) }
        return value
    }
}
