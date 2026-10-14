import Foundation

public protocol ClientDetailActionTransport: Sendable {
    func read(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientInspectorValue
    func command(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientCommandReceipt
    func receipt(sessionID: String, requestID: String) async throws -> ClientCommandReceipt
}

/// Each operation obtains a current credential-bound transport. No automatic
/// mutation retry is introduced by token refresh or a reconnection.
public struct ClientDetailDynamicActionTransport: ClientDetailActionTransport {
    private let api: @Sendable () async throws -> ClientDetailActionAPI
    public init(api: @escaping @Sendable () async throws -> ClientDetailActionAPI) { self.api = api }
    public func read(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientInspectorValue {
        try await api().read(sessionID: sessionID, request: request)
    }
    public func command(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientCommandReceipt {
        try await api().command(sessionID: sessionID, request: request)
    }
    public func receipt(sessionID: String, requestID: String) async throws -> ClientCommandReceipt {
        try await api().receipt(sessionID: sessionID, requestID: requestID)
    }
}

public struct ClientDetailActionAPI: ClientDetailActionTransport {
    private let transport: BackendTransport
    private let route: ClientDetailAPI.Route
    private let negotiation: ClientDetailV2Negotiation
    public init(transport: BackendTransport, route: ClientDetailAPI.Route, negotiation: ClientDetailV2Negotiation = .legacy) {
        self.transport = transport; self.route = route; self.negotiation = negotiation
    }
    private func fetch<T: Decodable>(sessionID: String, suffix: [String], body: ClientDetailActionRequest? = nil) async throws -> T {
        let prefix = route == .desktop ? [] : ["client", "v1"]
        var request = try transport.endpoint.request(path: prefix + ["sessions", sessionID, "detail"] + suffix)
        request.setValue("application/json; corptie-detail=\(negotiation.isLegacy ? "native-v1" : negotiation.catalog)", forHTTPHeaderField: "Accept")
        if !negotiation.isLegacy { request.setValue(negotiation.clientCapabilities.joined(separator: ","), forHTTPHeaderField: "X-Corptie-Detail-Capabilities") }
        if let body {
            try body.validate()
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, _) = try await transport.data(for: request)
        guard data.count <= ClientDetailProtocol.maxDocumentBytes else { throw ClientDetailFailure.limit }
        if T.self == ClientInspectorValue.self, let value = try ClientDetailV2JSON.decode(data) as? T { return value }
        return try JSONDecoder().decode(T.self, from: data)
    }
    public func read(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientInspectorValue {
        try await fetch(sessionID: sessionID, suffix: ["read"], body: request)
    }
    public func command(sessionID: String, request: ClientDetailActionRequest) async throws -> ClientCommandReceipt {
        try await fetch(sessionID: sessionID, suffix: ["actions"], body: request)
    }
    public func receipt(sessionID: String, requestID: String) async throws -> ClientCommandReceipt {
        try await fetch(sessionID: sessionID, suffix: ["receipts", requestID])
    }
}

/// This is a registry of native destinations, not a URL interpreter.
public enum ClientDetailActionRouting {
    /// The platform registers only destinations it can actually present.
    /// Wire tokens alone never imply that a native editor exists on a client.
    public struct Resolver: Sendable {
        private let registrations: [String: Set<String>]
        public init(registrations: [String: Set<String>] = [:]) { self.registrations = registrations }
        public func target(for action: ClientDetailAction) throws -> ClientDetailAction.Target {
            let target = try ClientDetailActionRouting.target(for: action)
            guard registrations[action.operation]?.contains(target.resourceType) == true else {
                throw ClientServiceFailure(statusCode: 409, code: "DETAIL_NAVIGATION_UNAVAILABLE")
            }
            return target
        }
    }
    public static let destinations: [String: Set<String>] = [
        "resource.open": ["session", "task", "work", "schedule", "artifact", "memory", "reference"],
        "editor.open": ["task", "schedule", "provider", "worktree", "artifact", "memory", "reference"]
    ]
    public static func target(for action: ClientDetailAction) throws -> ClientDetailAction.Target {
        guard action.kind == "navigation", action.available, let target = action.target,
              !target.id.isEmpty, destinations[action.operation]?.contains(target.resourceType) == true else {
            throw ClientServiceFailure(statusCode: 409, code: "DETAIL_NAVIGATION_UNSUPPORTED")
        }
        return target
    }
}
