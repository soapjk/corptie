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
    @Published private(set) var artifactsByCorptieTask: [String: [ObjectiveArtifact]] = [:]
    @Published private(set) var objectiveLoadStates: [String: ArtifactCollectionLoadState] = [:]
    @Published private(set) var taskLoadStates: [String: ArtifactCollectionLoadState] = [:]
    @Published var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private var requestTokens: [String: UUID] = [:]
    private var publishIdempotencyKeys: [String: String] = [:]
    private var objectiveNextOffsets: [String: Int] = [:]
    private var taskNextOffsets: [String: Int] = [:]
    private var externalRefreshTask: Task<Void, Never>?
    private static let requestTimeout: TimeInterval = 5

    func artifact(artifactId: String, objectiveId: String, taskId: String?) -> ObjectiveArtifact? {
        let artifacts = taskId.flatMap { artifactsByCorptieTask[$0] }
            ?? artifactsByObjective[objectiveId]
            ?? []
        return artifacts.first { $0.artifactId == artifactId }
    }

    /// State change sets can contain several rows for one atomic publish and
    /// fixed-reference repin. Debounce the burst and refresh only collections
    /// this process has actually loaded; this is event-driven cache repair,
    /// not a polling loop.
    func refreshLoadedCollectionsAfterExternalChange() {
        externalRefreshTask?.cancel()
        externalRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled, let self else { return }
            let objectiveIds = Set(self.artifactsByObjective.keys)
                .union(self.objectiveLoadStates.keys)
            let taskIds = Set(self.artifactsByCorptieTask.keys)
                .union(self.taskLoadStates.keys)
            for objectiveId in objectiveIds.sorted() {
                guard !Task.isCancelled else { return }
                await self.refresh(objectiveId: objectiveId)
            }
            for taskId in taskIds.sorted() {
                guard !Task.isCancelled else { return }
                await self.refresh(taskId: taskId)
            }
        }
    }

    func refresh(objectiveId: String) async {
        let key = "objective:\(objectiveId)"
        let token = UUID()
        requestTokens[key] = token
        let previous = objectiveLoadStates[objectiveId]?.value ?? artifactsByObjective[objectiveId]
        objectiveLoadStates[objectiveId] = .loading(previousValue: previous)
        do {
            var components = URLComponents(
                url: Self.endpointURL(baseURL: baseURL, path: "objectives/\(objectiveId)/artifacts"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [URLQueryItem(name: "limit", value: "100")]
            let envelope: ArtifactListEnvelope = try await get(components.url!)
            try Self.validateArtifactEnvelope(envelope)
            try Task.checkCancellation()
            guard requestTokens[key] == token else { return }
            artifactsByObjective[objectiveId] = envelope.artifacts
            objectiveNextOffsets[objectiveId] = envelope.nextOffset
            objectiveLoadStates[objectiveId] = .loaded(envelope.artifacts)
        } catch is CancellationError {
            return
        } catch {
            guard requestTokens[key] == token else { return }
            objectiveLoadStates[objectiveId] = .failed(message: Self.displayMessage(for: error), previousValue: previous)
        }
    }

    func refresh(taskId: String) async {
        let key = "task:\(taskId)"
        let token = UUID()
        requestTokens[key] = token
        let previous = taskLoadStates[taskId]?.value ?? artifactsByCorptieTask[taskId]
        taskLoadStates[taskId] = .loading(previousValue: previous)
        do {
            var components = URLComponents(
                url: Self.endpointURL(baseURL: baseURL, path: "tasks/\(taskId)/artifacts"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [URLQueryItem(name: "limit", value: "100")]
            let envelope: ArtifactListEnvelope = try await get(components.url!)
            try Self.validateArtifactEnvelope(envelope)
            try Task.checkCancellation()
            guard requestTokens[key] == token else { return }
            artifactsByCorptieTask[taskId] = envelope.artifacts
            taskNextOffsets[taskId] = envelope.nextOffset
            taskLoadStates[taskId] = .loaded(envelope.artifacts)
        } catch is CancellationError {
            return
        } catch {
            guard requestTokens[key] == token else { return }
            taskLoadStates[taskId] = .failed(message: Self.displayMessage(for: error), previousValue: previous)
        }
    }

    func cancelRefresh(taskId: String) {
        requestTokens.removeValue(forKey: "task:\(taskId)")
    }

    func hasMore(objectiveId: String, taskId: String?) -> Bool {
        if let taskId { return taskNextOffsets[taskId] != nil }
        return objectiveNextOffsets[objectiveId] != nil
    }

    func loadMore(objectiveId: String, taskId: String?) async {
        let offset: Int?
        if let taskId { offset = taskNextOffsets[taskId] }
        else { offset = objectiveNextOffsets[objectiveId] }
        guard let offset else { return }
        let path = taskId.map { "tasks/\($0)/artifacts" } ?? "objectives/\(objectiveId)/artifacts"
        do {
            var components = URLComponents(
                url: Self.endpointURL(baseURL: baseURL, path: path),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [
                URLQueryItem(name: "limit", value: "100"),
                URLQueryItem(name: "offset", value: String(offset))
            ]
            let envelope: ArtifactListEnvelope = try await get(components.url!)
            try Self.validateArtifactEnvelope(envelope)
            if let taskId {
                var known = Set((artifactsByCorptieTask[taskId] ?? []).map(\.artifactId))
                artifactsByCorptieTask[taskId, default: []].append(
                    contentsOf: envelope.artifacts.filter { known.insert($0.artifactId).inserted }
                )
                taskNextOffsets[taskId] = envelope.nextOffset
                taskLoadStates[taskId] = .loaded(artifactsByCorptieTask[taskId] ?? [])
            } else {
                var known = Set((artifactsByObjective[objectiveId] ?? []).map(\.artifactId))
                artifactsByObjective[objectiveId, default: []].append(
                    contentsOf: envelope.artifacts.filter { known.insert($0.artifactId).inserted }
                )
                objectiveNextOffsets[objectiveId] = envelope.nextOffset
                objectiveLoadStates[objectiveId] = .loaded(artifactsByObjective[objectiveId] ?? [])
            }
        } catch {
            errorMessage = Self.displayMessage(for: error)
        }
    }

    func detail(artifact: ObjectiveArtifact, version: Int, offset: Int = 0, turnExecutionId: String) async -> ArtifactDetailEnvelope? {
        guard let pinnedVersion = artifact.versions.first(where: { $0.version == version }) else {
            errorMessage = "The selected immutable Artifact version is unavailable."
            return nil
        }
        let reference = artifact.references.first(where: {
            $0.revokedAt == nil && $0.pinnedVersion == version && $0.pinnedHash == pinnedVersion.contentHash
        })
        var components = URLComponents(url: Self.endpointURL(baseURL: baseURL, path: "artifacts/\(artifact.artifactId)"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "version", value: String(pinnedVersion.version)),
            URLQueryItem(name: "contentHash", value: pinnedVersion.contentHash),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(ArtifactContentPagingPolicy.pageBytes)),
            URLQueryItem(name: "turnExecutionId", value: turnExecutionId)
        ]
        if let reference {
            components.queryItems?.append(URLQueryItem(name: "referenceId", value: reference.referenceId))
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            try Self.validate(response: response, data: data)
            return try await decode(ArtifactDetailEnvelope.self, data: data)
        } catch { errorMessage = error.localizedDescription; return nil }
    }

    func create(objectiveId: String, title: String, summary: String, content: String, visibility: ArtifactVisibility, boundTaskId: String?) async -> ObjectiveArtifact? {
        var body: [String: Any] = [
            "title": title, "summary": summary, "content": content, "visibility": visibility.rawValue
        ]
        if let boundTaskId { body["boundTaskId"] = boundTaskId }
        return await mutate("objectives/\(objectiveId)/artifacts", method: "POST", body: body)
    }

    func importFile(objectiveId: String, fileURL: URL, visibility: ArtifactVisibility, boundTaskId: String?) async -> ArtifactImportEnvelope? {
        var body: [String: Any] = ["importPath": fileURL.path, "title": fileURL.lastPathComponent, "visibility": visibility.rawValue]
        if let boundTaskId { body["boundTaskId"] = boundTaskId }
        let result: ArtifactImportEnvelope? = await mutate(
            "objectives/\(objectiveId)/artifacts", method: "POST", body: body)
        return result
    }

    func publish(artifact: ObjectiveArtifact, taskId: String?, content: String, summary: String) async -> Bool {
        guard let taskId,
              artifact.availableActions?.contains("publish_and_repin") == true else {
            guard taskId == nil || artifact.availableActions?.contains("publish") == true else {
                errorMessage = "This Artifact is read-only in the current Work Item."
                return false
            }
            let result: ArtifactPublicationEnvelope? = await mutate(
                "artifacts/\(artifact.artifactId)/versions", method: "POST",
                body: ["content": content, "summary": summary, "approvalStatus": "approved"])
            return result != nil
        }
        guard let reference = artifact.references.first(where: {
                  $0.taskId == taskId && $0.revokedAt == nil && $0.versionPolicy == "fixed"
              }) else {
            errorMessage = "This Artifact is read-only in the current Work Item."
            return false
        }
        let requestIdentity = [artifact.artifactId, String(artifact.resourceVersion),
                               reference.referenceId, String(reference.pinnedVersion),
                               reference.pinnedHash, summary, content].joined(separator: "\u{0}")
        let idempotencyKey = publishIdempotencyKeys[requestIdentity] ?? UUID().uuidString
        publishIdempotencyKeys[requestIdentity] = idempotencyKey
        let result: ArtifactPublicationEnvelope? = await mutate(
            "tasks/\(taskId)/artifacts/\(artifact.artifactId)/publish", method: "POST",
            body: [
                "content": content, "summary": summary, "approvalStatus": "approved",
                "referenceId": reference.referenceId,
                "expectedResourceVersion": artifact.resourceVersion,
                "expectedPinnedVersion": reference.pinnedVersion,
                "expectedPinnedHash": reference.pinnedHash,
                "idempotencyKey": idempotencyKey
            ])
        if result != nil {
            publishIdempotencyKeys.removeValue(forKey: requestIdentity)
            await refresh(taskId: taskId)
        }
        return result != nil
    }

    func reference(artifactId: String, taskId: String, relation: String, required: Bool, versionPolicy: String) async -> Bool {
        let result: ArtifactReference? = await mutate("artifacts/\(artifactId)/references", method: "POST", body: [
            "taskId": taskId, "relation": relation, "required": required, "versionPolicy": versionPolicy
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

    func export(artifact: ObjectiveArtifact, version: Int, destinationURL: URL, confirmRepositoryWrite: Bool, confirmOverwrite: Bool) async -> ArtifactExportOutcome {
        do {
            let pin = try pinnedReference(artifact: artifact, version: version)
            var request = URLRequest(url: Self.endpointURL(baseURL: baseURL, path: "artifacts/\(artifact.artifactId)/export"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "destinationPath": destinationURL.path, "version": version,
                "contentHash": pin.contentHash, "referenceId": pin.referenceId, "confirmed": true,
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

    func localFile(artifact: ObjectiveArtifact, version: Int) async throws -> ArtifactLocalFileReceipt {
        let pin = try pinnedReference(artifact: artifact, version: version)
        var components = URLComponents(
            url: Self.endpointURL(baseURL: baseURL, path: "artifacts/\(artifact.artifactId)/local-file"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "version", value: String(version)),
            URLQueryItem(name: "contentHash", value: pin.contentHash),
            URLQueryItem(name: "referenceId", value: pin.referenceId)
        ]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        try Self.validate(response: response, data: data)
        return try await decode(ArtifactLocalFileReceipt.self, data: data)
    }

    private func pinnedReference(artifact: ObjectiveArtifact, version: Int) throws -> (referenceId: String, contentHash: String) {
        guard let reference = artifact.references.first(where: { $0.revokedAt == nil && $0.pinnedVersion == version }),
              let artifactVersion = artifact.versions.first(where: { $0.version == version && $0.contentHash == reference.pinnedHash }) else {
            throw EntityLaunchError(message: "Artifact content requires an active Reference pinned to this exact version and hash.", code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN")
        }
        return (reference.referenceId, artifactVersion.contentHash)
    }

    private func get<T: Decodable & Sendable>(_ path: String) async throws -> T {
        try await get(Self.endpointURL(baseURL: baseURL, path: path))
    }

    private func get<T: Decodable & Sendable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.timeoutInterval = Self.requestTimeout
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.validate(response: response, data: data)
        return try await decode(T.self, data: data)
    }

    private func mutate<T: Decodable & Sendable>(_ path: String, method: String, body: [String: Any]) async -> T? {
        do {
            var request = URLRequest(url: Self.endpointURL(baseURL: baseURL, path: path))
            request.httpMethod = method
            request.timeoutInterval = Self.requestTimeout
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

    private static func displayMessage(for error: Error) -> String {
        if let urlError = error as? URLError, urlError.code == .timedOut {
            return "Artifact request timed out. Check the backend and retry."
        }
        return error.localizedDescription
    }

    private static func validateArtifactEnvelope(_ envelope: ArtifactListEnvelope) throws {
        let statuses = Set(["active", "superseded", "revoked"])
        let policies = Set(["fixed", "latest_approved"])
        for artifact in envelope.artifacts {
            guard statuses.contains(artifact.status) else {
                throw EntityLaunchError(
                    message: "Artifact \(artifact.artifactId) has unsupported status \(artifact.status).",
                    code: "ARTIFACT_STATUS_UNKNOWN"
                )
            }
            if let reference = artifact.references.first(where: { !policies.contains($0.versionPolicy) }) {
                throw EntityLaunchError(
                    message: "Artifact Reference \(reference.referenceId) has unsupported version policy \(reference.versionPolicy).",
                    code: "ARTIFACT_VERSION_POLICY_UNKNOWN"
                )
            }
        }
    }

    nonisolated static func endpointURL(baseURL: URL, path: String) -> URL {
        path.split(separator: "/").reduce(baseURL) { partial, component in
            partial.appendingPathComponent(String(component))
        }
    }
}
