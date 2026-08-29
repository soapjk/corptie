import AppKit
import Foundation

enum ArtifactExportOutcome: Equatable {
    case success
    case repositoryConfirmationRequired
    case failed
}

@MainActor
final class ArtifactAPIClient: ObservableObject {
    static let shared = ArtifactAPIClient()

    @Published private(set) var artifactsByObjective: [String: [ObjectiveArtifact]] = [:]
    @Published private(set) var artifactsByWorkItem: [String: [ObjectiveArtifact]] = [:]
    @Published var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    func refresh(objectiveId: String) async {
        do {
            let envelope: ArtifactListEnvelope = try await get("objectives/\(objectiveId)/artifacts")
            artifactsByObjective[objectiveId] = envelope.artifacts
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func refresh(workItemId: String) async {
        do {
            let envelope: ArtifactListEnvelope = try await get("work-items/\(workItemId)/artifacts")
            artifactsByWorkItem[workItemId] = envelope.artifacts
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func detail(artifactId: String, version: Int? = nil, offset: Int = 0) async -> ArtifactDetailEnvelope? {
        var components = URLComponents(url: Self.endpointURL(baseURL: baseURL, path: "artifacts/\(artifactId)"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            version.map { URLQueryItem(name: "version", value: String($0)) },
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(ArtifactContentPagingPolicy.pageBytes))
        ].compactMap { $0 }
        do {
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            try Self.validate(response: response, data: data)
            return try await decode(ArtifactDetailEnvelope.self, data: data)
        } catch { errorMessage = error.localizedDescription; return nil }
    }

    func create(objectiveId: String, title: String, summary: String, content: String, visibility: ArtifactVisibility, boundWorkItemId: String?) async -> ObjectiveArtifact? {
        var body: [String: Any] = [
            "title": title, "summary": summary, "content": content, "visibility": visibility.rawValue
        ]
        if let boundWorkItemId { body["boundWorkItemId"] = boundWorkItemId }
        return await mutate("objectives/\(objectiveId)/artifacts", method: "POST", body: body)
    }

    func importFile(objectiveId: String, fileURL: URL, visibility: ArtifactVisibility, boundWorkItemId: String?) async -> ArtifactImportEnvelope? {
        var body: [String: Any] = ["importPath": fileURL.path, "title": fileURL.lastPathComponent, "visibility": visibility.rawValue]
        if let boundWorkItemId { body["boundWorkItemId"] = boundWorkItemId }
        let result: ArtifactImportEnvelope? = await mutate(
            "objectives/\(objectiveId)/artifacts", method: "POST", body: body)
        return result
    }

    func publish(artifactId: String, content: String, summary: String) async -> Bool {
        let result: ArtifactPublicationEnvelope? = await mutate("artifacts/\(artifactId)/versions", method: "POST", body: ["content": content, "summary": summary, "approvalStatus": "approved"])
        return result != nil
    }

    func reference(artifactId: String, workItemId: String, relation: String, required: Bool, versionPolicy: String) async -> Bool {
        let result: ArtifactReference? = await mutate("artifacts/\(artifactId)/references", method: "POST", body: [
            "workItemId": workItemId, "relation": relation, "required": required, "versionPolicy": versionPolicy
        ])
        return result != nil
    }

    func markSuperseded(artifactId: String) async -> Bool {
        let result: ObjectiveArtifact? = await mutate("artifacts/\(artifactId)", method: "PATCH", body: ["status": "superseded"])
        return result != nil
    }

    func revoke(referenceId: String, reason: String) async -> Bool {
        let result: ArtifactReference? = await mutate("artifacts/references/\(referenceId)/revoke", method: "POST", body: ["reason": reason])
        return result != nil
    }

    func acknowledge(referenceId: String) async -> Bool {
        let result: ArtifactReference? = await mutate("artifacts/references/\(referenceId)/acknowledge-update", method: "POST", body: ["confirmed": true])
        return result != nil
    }

    func export(artifactId: String, version: Int, destinationURL: URL, confirmRepositoryWrite: Bool, confirmOverwrite: Bool) async -> ArtifactExportOutcome {
        do {
            var request = URLRequest(url: Self.endpointURL(baseURL: baseURL, path: "artifacts/\(artifactId)/export"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "destinationPath": destinationURL.path, "version": version, "confirmed": true,
                "confirmedRepositoryWrite": confirmRepositoryWrite, "confirmedOverwrite": confirmOverwrite
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                if payload?["code"] as? String == "ARTIFACT_REPOSITORY_WRITE_CONFIRMATION_REQUIRED" {
                    return .repositoryConfirmationRequired
                }
                throw EntityLaunchError(message: payload?["error"] as? String ?? "Artifact export failed", code: payload?["code"] as? String)
            }
            _ = try await decode(ArtifactExportReceipt.self, data: data)
            errorMessage = nil
            return .success
        } catch {
            errorMessage = error.localizedDescription
            return .failed
        }
    }

    func localFile(artifactId: String, version: Int) async throws -> ArtifactLocalFileReceipt {
        var components = URLComponents(
            url: Self.endpointURL(baseURL: baseURL, path: "artifacts/\(artifactId)/local-file"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "version", value: String(version))]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        try Self.validate(response: response, data: data)
        return try await decode(ArtifactLocalFileReceipt.self, data: data)
    }

    private func get<T: Decodable & Sendable>(_ path: String) async throws -> T {
        let (data, response) = try await URLSession.shared.data(from: Self.endpointURL(baseURL: baseURL, path: path))
        try Self.validate(response: response, data: data)
        return try await decode(T.self, data: data)
    }

    private func mutate<T: Decodable & Sendable>(_ path: String, method: String, body: [String: Any]) async -> T? {
        do {
            var request = URLRequest(url: Self.endpointURL(baseURL: baseURL, path: path))
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.validate(response: response, data: data)
            let result = try await decode(T.self, data: data)
            errorMessage = nil
            return result
        } catch { errorMessage = error.localizedDescription; return nil }
    }

    private func decode<T: Decodable & Sendable>(_ type: T.Type, data: Data) async throws -> T {
        return try await Task.detached(priority: .userInitiated) {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            return try decoder.decode(type, from: data)
        }.value
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw EntityLaunchError(message: payload?["error"] as? String ?? "Artifact request failed", code: payload?["code"] as? String)
        }
    }

    nonisolated static func endpointURL(baseURL: URL, path: String) -> URL {
        path.split(separator: "/").reduce(baseURL) { partial, component in
            partial.appendingPathComponent(String(component))
        }
    }
}
