import Foundation

/// Opt-in v2 transport. The existing v1 UI subscriptions remain unchanged until
/// the shared pool and renderer bridge have been migrated and accepted.
public struct ClientDetailV2API: Sendable {
    private let transport: BackendTransport
    private let route: ClientDetailAPI.Route
    public let negotiation: ClientDetailV2Negotiation
    public init(transport: BackendTransport, route: ClientDetailAPI.Route, negotiation: ClientDetailV2Negotiation = .legacy) {
        self.transport = transport; self.route = route; self.negotiation = negotiation
    }

    public func snapshot(sessionID: String) async throws -> ClientDetailV2State {
        let prefix = route == .desktop ? [] : ["client", "v1"]
        var request = try transport.endpoint.request(path: prefix + ["sessions", sessionID, "detail"])
        request.setValue("application/json; corptie-detail=\(negotiation.catalog)", forHTTPHeaderField: "Accept")
        if !negotiation.isLegacy {
            request.setValue(negotiation.clientCapabilities.joined(separator: ","), forHTTPHeaderField: "X-Corptie-Detail-Capabilities")
        }
        let (data, _) = try await transport.data(for: request)
        let value = try ClientDetailV2JSON.decode(data)
        try ClientDetailV2JSON.validateEnvelope(value, commit: false)
        let state = try JSONDecoder().decode(ClientDetailV2State.self, from: data)
        try state.validate(catalogProfile: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities); return state
    }

    public func subscribe(sessionID: String, resume: ClientDetailV2State? = nil,
                          resumeNegotiation: ClientDetailV2Negotiation? = nil) -> AsyncThrowingStream<ClientDetailV2State, Error> {
        // Existing callers' raw cursors belong to legacy. Rich cursors must
        // carry the exact originating catalog and capability set.
        let resume = (resumeNegotiation ?? .legacy) == negotiation ? resume : nil
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(16)) { continuation in
            let task = Task {
                do {
                    if let resume { try resume.validate(catalogProfile: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities) }
                    let prefix = route == .desktop ? [] : ["client", "v1"]
                    var request = try transport.endpoint.request(path: prefix + ["sessions", sessionID, "detail", "sync"])
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("text/event-stream; corptie-detail=native-v2", forHTTPHeaderField: "Accept")
                    let cursor: ClientInspectorValue = resume.map { .object(["documentId": .string($0.documentId), "generation": .string($0.generation),
                        "revision": .number(Double($0.revision)), "stateHash": .string($0.stateHash)]) } ?? .null
                    var fields: [String: ClientInspectorValue] = ["protocolVersion": .number(2), "catalog": .string(negotiation.catalog),
                        "resume": cursor, "cachedTemplateHashes": .array((resume?.templates.keys.sorted() ?? []).map { .string($0) })]
                    if !negotiation.isLegacy { fields["clientCapabilities"] = .array(negotiation.clientCapabilities.map { .string($0) }) }
                    request.httpBody = try JSONEncoder().encode(ClientInspectorValue.object(fields))
                    request.timeoutInterval = 35
                    let (bytes, response) = try await transport.bytes(for: request)
                    guard response.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw ClientConnectionError.invalidResponse }
                    var parser = ServerSentEventParser(), count = 0, latest = resume
                    for try await byte in bytes {
                        try Task.checkCancellation(); count += 1
                        guard count <= ClientDetailProtocol.maxFrameBytes else { throw ClientDetailV2Canonical.Failure.limit }
                        for event in parser.append(byte) {
                            count = 0
                            if event.isComment || event.name == "heartbeat" { continue }
                            let value = try ClientDetailV2JSON.decode(Data(event.data.utf8))
                            let next: ClientDetailV2State
                            switch event.name {
                            case "detail-snapshot":
                                try ClientDetailV2JSON.validateEnvelope(value, commit: false)
                                var fields = value.fields
                                var templates = latest?.templates ?? [:]; templates.merge(value["templates"].fields) { _, new in new }
                                let referenced = Set(value["manifest"]["cards"].fields.values.compactMap { $0["templateHash"].text })
                                fields["templates"] = .object(templates.filter { referenced.contains($0.key) })
                                next = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(ClientInspectorValue.object(fields)))
                                try next.validate(catalogProfile: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities)
                                if let latest, next.documentId != latest.documentId || next.sessionId != latest.sessionId ||
                                    (next.generation == latest.generation && (next.revision < latest.revision || (next.revision == latest.revision && next.stateHash != latest.stateHash))) { throw ClientDetailV2Canonical.Failure.base }
                            case "detail-commit":
                                try ClientDetailV2JSON.validateEnvelope(value, commit: true)
                                guard let current = latest else { throw ClientDetailV2Canonical.Failure.base }
                                let commit = try JSONDecoder().decode(ClientDetailV2Commit.self, from: JSONEncoder().encode(value))
                                next = try current.applying(commit, catalogProfile: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities)
                            case "detail-ready":
                                let keys: Set<String> = ["protocolVersion", "documentId", "sessionId", "generation", "revision", "stateHash"]
                                try ClientDetailV2JSON.keys(value, allowed: keys, required: keys)
                                guard let current = latest, value["protocolVersion"].number == 2,
                                      value["documentId"].text == current.documentId, value["sessionId"].text == current.sessionId,
                                      value["generation"].text == current.generation, value["revision"].number == Double(current.revision),
                                      value["stateHash"].text == current.stateHash else { throw ClientDetailV2Canonical.Failure.base }
                                next = current
                            case "detail-error":
                                throw ClientServiceFailure(statusCode: Int(value["status"].text ?? "503") ?? 503, code: value["code"].text ?? "DETAIL_FAILED")
                            default: throw ClientConnectionError.invalidResponse
                            }
                            latest = next
                            switch continuation.yield(next) {
                            case .dropped: throw ClientDetailFailure.bufferOverflow
                            case .terminated: return
                            case .enqueued: break
                            @unknown default: throw ClientDetailFailure.bufferOverflow
                            }
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }
}
