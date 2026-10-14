import Foundation

public struct ClientDetailAPI: Sendable {
    public enum Route: Sendable { case desktop, pairedDevice }
    private let transport: BackendTransport
    private let route: Route
    public let negotiation: ClientDetailV2Negotiation
    public private(set) var writesAvailable = false
    public private(set) var paginationAvailable = false
    public init(transport: BackendTransport, route: Route, negotiation: ClientDetailV2Negotiation = .legacy) {
        self.transport = transport; self.route = route; self.negotiation = negotiation
    }
    var v2: ClientDetailV2API { ClientDetailV2API(transport: transport, route: route, negotiation: negotiation) }
    /// Reuse a fixed profile with this API's current credential-bound transport.
    public func negotiating(_ profile: ClientDetailV2Negotiation) -> Self {
        Self(transport: transport, route: route, negotiation: profile)
    }
    public func usingPresentationPolicy(_ selected: Self) -> Self {
        var current = negotiating(selected.negotiation)
        current.writesAvailable = selected.writesAvailable; current.paginationAvailable = selected.paginationAvailable; return current
    }
    public var actionTransport: ClientDetailActionAPI {
        ClientDetailActionAPI(transport: transport, route: route, negotiation: negotiation)
    }
    /// Host advertisement chooses the profile; actual renderer capabilities
    /// remain explicit. Never downgrade an already negotiated rich request.
    public func forPresentation(sessionID: String, clientCapabilities: [String]) async throws -> Self {
        let actual = try ClientDetailV2Negotiation.components(clientCapabilities: clientCapabilities)
        let prefix = route == .desktop ? [] : ["client", "v1"]
        var request = try transport.endpoint.request(path: prefix + ["sessions", sessionID, "detail", "capabilities"])
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15
        let data: Data
        do { (data, _) = try await transport.data(for: request) }
        catch {
            // Older hosts have no advertisement endpoint. This is selection
            // before a rich request, not fallback from a rejected rich stream.
            guard negotiation.isLegacy, Self.canFallbackToV1(error) else { throw error }
            return self
        }
        guard data.count <= 4096 else { throw ClientDetailFailure.limit }
        let value = try JSONDecoder().decode(ClientDetailDeliveryCapabilities.self, from: data)
        try value.validate()
        guard value.catalogs.contains(actual.catalog) else {
            guard negotiation.isLegacy else { throw ClientDetailV2Canonical.Failure.shape }
            return self
        }
        guard Set(value.requiredCapabilities).isSubset(of: Set(actual.clientCapabilities)) else {
            throw ClientServiceFailure(statusCode: 409, code: "DETAIL_CAPABILITY_UNAVAILABLE")
        }
        var selected = Self(transport: transport, route: route, negotiation: actual)
        selected.writesAvailable = value.writes
        selected.paginationAvailable = value.pagination ?? false
        return selected
    }
    static func canFallbackToV1(_ error: Error) -> Bool {
        if let failure = error as? ClientServiceFailure {
            return (failure.statusCode == 409 && failure.code == "DETAIL_CATALOG_UNSUPPORTED") ||
                (failure.statusCode == 405 && failure.code == "DETAIL_REQUEST_NOT_ALLOWED") ||
                (failure.statusCode == 403 && failure.code == "REQUEST_NOT_ALLOWED") ||
                (failure.statusCode == 404 && ["NOT_FOUND", "ROUTE_NOT_FOUND"].contains(failure.code))
        }
        if case ClientConnectionError.httpStatus(let status) = error { return [404, 405].contains(status) }
        return false
    }
    static func isAccessFailure(_ error: Error) -> Bool {
        if let failure = error as? ClientServiceFailure { return [401, 403, 404].contains(failure.statusCode) }
        if case ClientConnectionError.httpStatus(let status) = error { return [401, 403, 404].contains(status) }
        return false
    }
    func renderingSnapshot(sessionID: String) async throws -> ClientDetailDocument {
        do { return try await v2.snapshot(sessionID: sessionID).renderingDocument(catalogProfile: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities) }
        catch { guard negotiation.isLegacy && Self.canFallbackToV1(error) else { throw error }; return try await snapshot(sessionID: sessionID) }
    }
    private func request(sessionID: String, events: Bool) throws -> URLRequest {
        let prefix = route == .desktop ? [] : ["client", "v1"]
        var request = try transport.endpoint.request(path: prefix + ["sessions", sessionID, "detail"] + (events ? ["events"] : []))
        request.setValue(events ? "text/event-stream; corptie-detail=native-v1" : "application/json; corptie-detail=native-v1",
                         forHTTPHeaderField: "Accept")
        return request
    }
    public func snapshot(sessionID: String) async throws -> ClientDetailDocument {
        let (data, _) = try await transport.data(for: request(sessionID: sessionID, events: false))
        return try ClientDetailDocument.decode(data)
    }
    /// FIFO patches cannot be silently dropped. Overflow terminates and the Store resnapshots.
    public func subscribe(sessionID: String) -> AsyncThrowingStream<ClientDetailEvent, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(16)) { continuation in
            let task = Task {
                do {
                    var request = try request(sessionID: sessionID, events: true)
                    request.timeoutInterval = 35
                    let (bytes, response) = try await transport.bytes(for: request)
                    guard response.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw ClientConnectionError.invalidResponse }
                    var parser = ServerSentEventParser(), count = 0
                    for try await byte in bytes {
                        try Task.checkCancellation(); count += 1
                        guard count <= ClientDetailProtocol.maxFrameBytes else { throw ClientDetailFailure.limit }
                        for event in parser.append(byte) {
                            count = 0
                            if event.isComment || event.name == "heartbeat" { continue }
                            let data = Data(event.data.utf8)
                            guard data.count <= ClientDetailProtocol.maxDocumentBytes else { throw ClientDetailFailure.limit }
                            let next: ClientDetailEvent
                            switch event.name {
                            case "detail-snapshot": next = .snapshot(try ClientDetailDocument.decode(data))
                            case "detail-patch": next = .patch(try JSONDecoder().decode(ClientDetailPatch.self, from: data))
                            case "detail-error":
                                let failure = try JSONDecoder().decode([String: String].self, from: data)
                                throw ClientServiceFailure(statusCode: Int(failure["status"] ?? "503") ?? 503, code: failure["code"] ?? "DETAIL_FAILED")
                            default: throw ClientConnectionError.invalidResponse
                            }
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

public struct ClientDetailDeliveryCapabilities: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let catalogs: [String]
    public let requiredCapabilities: [String]
    public let writes: Bool
    public let pagination: Bool?
    public func validate() throws {
        guard schemaVersion == 1, catalogs == ["native-v2"] || catalogs == ["native-v2", "native-v2-components-1"],
              requiredCapabilities == requiredCapabilities.sorted(), Set(requiredCapabilities).count == requiredCapabilities.count,
              Set(requiredCapabilities).isSubset(of: ClientDetailV2Negotiation.registeredCapabilities),
              catalogs.contains("native-v2-components-1") || requiredCapabilities.isEmpty,
              pagination != true || catalogs.contains("native-v2-components-1") && requiredCapabilities.contains("detail.button") else {
            throw ClientDetailV2Canonical.Failure.shape
        }
    }
}
